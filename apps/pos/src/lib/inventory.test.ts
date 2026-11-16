import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PosProduct } from '@/types/pos';

vi.mock('@/lib/edge', () => ({ edge: { stockAdjust: vi.fn() } }));
vi.mock('@/lib/supabase', () => ({ rpc: vi.fn() }));

import { clearDb, db, getMeta } from './db';
import {
  INVENTORY_CURSOR_KEY,
  listInventoryLines,
  removeInventoryLine,
  sendInventory,
  syncInventory,
  upsertInventoryLine,
} from './inventory';
import type { InventoryServerLine, InventorySyncParams, InventorySyncResponse } from './inventory';

const product = (n: number, stock = 10): PosProduct =>
  ({
    id: `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name: `Produit ${n}`,
    ean: `30000000000${n}`,
    stock_boutique: stock,
  }) as unknown as PosProduct;

/** Serveur simulé : dernière écriture gagnante par produit, curseur sur l'horloge serveur. */
function fakeServer() {
  const lines = new Map<string, InventoryServerLine & { at: number }>();
  let tick = 0;
  return {
    lines,
    sync: async (p: InventorySyncParams): Promise<InventorySyncResponse> => {
      for (const l of p.p_lines) {
        const cur = lines.get(l.product_id);
        if (!cur || Date.parse(l.updated_at) > Date.parse(cur.updated_at)) {
          lines.set(l.product_id, { ...l, at: ++tick });
        }
      }
      return {
        server_time: new Date().toISOString(),
        // Faux serveur sans curseur fin : renvoie tout (le client ignore les lignes déjà à jour).
        lines: [...lines.values()].map(({ at: _at, ...rest }) => rest),
      };
    },
  };
}

describe('lot d’inventaire — saisie locale', () => {
  beforeEach(async () => {
    await clearDb();
  });

  it('une saisie est à envoyer ; une ligne retirée disparaît de la liste mais reste à propager', async () => {
    await upsertInventoryLine(product(1), 4);
    const [l] = await listInventoryLines();
    expect(l).toMatchObject({ counted: 4, dirty: true, deleted: false });
    await removeInventoryLine(l!.idempotency_key);
    expect(await listInventoryLines()).toHaveLength(0);
    expect(await db.inventory.count()).toBe(1);
    expect((await db.inventory.toArray())[0]).toMatchObject({ deleted: true, dirty: true });
  });

  it('recompter un produit retiré le fait revenir avec une nouvelle clé', async () => {
    await upsertInventoryLine(product(1), 4);
    const [first] = await listInventoryLines();
    await removeInventoryLine(first!.idempotency_key);
    await upsertInventoryLine(product(1), 6);
    const lines = await listInventoryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ counted: 6, deleted: false });
    expect(lines[0]!.idempotency_key).not.toBe(first!.idempotency_key);
  });
});

describe('lot d’inventaire — synchronisation entre postes', () => {
  beforeEach(async () => {
    await clearDb();
  });

  it('envoie les lignes à envoyer, les marque envoyées et mémorise le curseur', async () => {
    await upsertInventoryLine(product(1), 4);
    const sync = vi.fn(async (_p: InventorySyncParams) => ({
      server_time: '2026-11-16T12:00:30.000Z',
      lines: [] as InventoryServerLine[],
    }));
    const r = await syncInventory({ sync });
    expect(r.pushed).toBe(1);
    expect(sync.mock.calls[0]![0].p_lines[0]).toMatchObject({ counted: 4, deleted: false });
    expect(sync.mock.calls[0]![0].p_since).toBeNull();
    expect((await db.inventory.toArray())[0]!.dirty).toBe(false);
    // Curseur = heure serveur − marge de 10 s.
    expect(await getMeta<string>(INVENTORY_CURSOR_KEY)).toBe('2026-11-16T12:00:20.000Z');
    // Seconde synchro : plus rien à envoyer.
    expect((await syncInventory({ sync })).pushed).toBe(0);
  });

  it('un autre poste retrouve la saisie, la modifie, et la suppression se propage', async () => {
    const server = fakeServer();
    // Poste A : saisit deux produits.
    await upsertInventoryLine(product(1), 4);
    await upsertInventoryLine(product(2), 7);
    await syncInventory({ sync: server.sync });
    expect(server.lines.size).toBe(2);

    // Poste B (base vide) : reprend le lot.
    await clearDb();
    await syncInventory({ sync: server.sync });
    const onB = await listInventoryLines();
    expect(onB.map((l) => l.counted).sort()).toEqual([4, 7]);
    expect(onB.every((l) => l.dirty === false)).toBe(true);

    // Poste B corrige un comptage et retire l'autre produit.
    await new Promise((r) => setTimeout(r, 5));
    await upsertInventoryLine(product(1), 9);
    const two = onB.find((l) => l.product_id === product(2).id)!;
    await new Promise((r) => setTimeout(r, 5));
    await removeInventoryLine(two.idempotency_key);
    await syncInventory({ sync: server.sync });
    expect(await db.inventory.filter((l) => !!l.deleted).count()).toBe(0);

    // Retour sur le poste A (base vide simulée avec l'état d'avant) : correction + suppression reçues.
    await clearDb();
    await syncInventory({ sync: server.sync });
    const onA = await listInventoryLines();
    expect(onA).toHaveLength(1);
    expect(onA[0]).toMatchObject({ product_id: product(1).id, counted: 9 });
  });

  it('dernière écriture gagnante : une ligne locale plus récente n’est pas écrasée', async () => {
    await upsertInventoryLine(product(1), 4);
    const [l] = await listInventoryLines();
    const older: InventoryServerLine = {
      product_id: l!.product_id,
      idempotency_key: 'aaaaaaaa-0000-4000-8000-000000000001',
      label: 'Produit 1',
      ean: null,
      stock_seen: 10,
      counted: 99,
      added_at: '2020-01-01T00:00:00.000Z',
      updated_at: '2020-01-01T00:00:00.000Z',
      deleted: false,
    };
    await syncInventory({
      sync: async () => ({ server_time: new Date().toISOString(), lines: [older] }),
    });
    expect((await listInventoryLines())[0]).toMatchObject({ counted: 4 });
  });

  it('une ligne plus récente venue du serveur remplace la ligne locale', async () => {
    await upsertInventoryLine(product(1), 4);
    await syncInventory({
      sync: async () => ({ server_time: new Date().toISOString(), lines: [] }),
    });
    const [l] = await listInventoryLines();
    const newer: InventoryServerLine = {
      product_id: l!.product_id,
      idempotency_key: 'bbbbbbbb-0000-4000-8000-000000000002',
      label: 'Produit 1',
      ean: null,
      stock_seen: 10,
      counted: 21,
      added_at: l!.added_at,
      updated_at: new Date(Date.now() + 60_000).toISOString(),
      deleted: false,
    };
    await syncInventory({
      sync: async () => ({ server_time: new Date().toISOString(), lines: [newer] }),
    });
    const lines = await listInventoryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ counted: 21, idempotency_key: newer.idempotency_key });
  });

  it('l’envoi confirmé retire les lignes et propage la suppression', async () => {
    await upsertInventoryLine(product(1), 4);
    const [l] = await listInventoryLines();
    const adjust = vi.fn(async () => ({
      results: [
        {
          product_id: l!.product_id,
          applied: true,
          already_applied: false,
          stock_before: 10,
          stock_after: 4,
          delta: -6,
        },
      ],
    }));
    const report = await sendInventory('Inventaire test', {
      adjust: adjust as unknown as Parameters<typeof sendInventory>[1] extends infer O
        ? O extends { adjust?: infer A }
          ? A
          : never
        : never,
    });
    expect(report.confirmed).toHaveLength(1);
    expect(await listInventoryLines()).toHaveLength(0);
    const sync = vi.fn(async (_p: InventorySyncParams) => ({
      server_time: new Date().toISOString(),
      lines: [] as InventoryServerLine[],
    }));
    await syncInventory({ sync });
    expect(sync.mock.calls[0]![0].p_lines[0]).toMatchObject({ deleted: true });
    expect(await db.inventory.count()).toBe(0);
  });
});
