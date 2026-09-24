import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogPageRow } from '@/types/pos';

vi.mock('@/lib/catalogClient', () => ({
  catalog: { rpc: vi.fn() },
  catalogRpc: vi.fn(async () => {
    throw new Error('catalogRpc non utilisé dans les tests (fetchPage injecté)');
  }),
}));

import { clearDb, db } from './db';
import {
  catalogStatus,
  productByEanLocal,
  searchLocal,
  syncCatalog,
  tokenize,
} from './offlineCatalog';
import type { CatalogPageFetcher, CatalogPageRequest } from './offlineCatalog';

function row(id: number, name: string, extra: Partial<CatalogPageRow> = {}): CatalogPageRow {
  return {
    id: `a0000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    name,
    brand: null,
    ean: null,
    image_url: null,
    price_ttc_cents: 100 * id,
    price_ht_cents: 83 * id,
    vat_rate: 20,
    eco_tax_cents: 0,
    stock_boutique: id,
    pos_price_tiers: null,
    updated_at: `2026-09-0${Math.min(id, 9)}T10:00:00.000Z`,
    pos_visible: true,
    ...extra,
  };
}

/** Serveur simulé : pagination par id (`p_after_id`), filtre `p_since` comme `pos_catalog_page`. */
function server(rows: CatalogPageRow[]): {
  fetchPage: CatalogPageFetcher;
  calls: CatalogPageRequest[];
} {
  const calls: CatalogPageRequest[] = [];
  const fetchPage: CatalogPageFetcher = async (req) => {
    calls.push(req);
    return rows
      .filter((r) => (req.after_id ? r.id > req.after_id : true))
      .filter((r) => (req.since ? r.updated_at > req.since : r.pos_visible))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, req.limit);
  };
  return { fetchPage, calls };
}

const BASE: CatalogPageRow[] = [
  row(1, 'Stylo bille BIC Cristal bleu', { brand: 'BIC', ean: '3086123101227' }),
  row(2, 'Crème pour cuir Saphir', { brand: 'Saphir', ean: '3172210010012' }),
  row(3, 'Cahier Clairefontaine 96p', { brand: 'Clairefontaine', ean: '3037920636016' }),
  row(4, 'Stylo plume Lamy Safari', { brand: 'Lamy', ean: '4014519000105' }),
  row(5, 'Produit masqué', { pos_visible: false }),
];

describe('offlineCatalog', () => {
  beforeEach(async () => {
    await clearDb();
  });

  it('tokenize : minuscules, accents supprimés, découpe non alphanumérique', () => {
    expect(tokenize('Crème-Brûlée  N°5 A4/A3')).toEqual(['creme', 'brulee', 'n', '5', 'a4', 'a3']);
  });

  it('synchro complète paginée (produits visibles uniquement)', async () => {
    const { fetchPage, calls } = server(BASE);
    const r = await syncCatalog({ fetchPage, pageSize: 2 });
    expect(r).toMatchObject({ mode: 'full', upserted: 4, error: null });
    expect(await db.products.count()).toBe(4);
    // Pagination par id : 3 pages (2 + 2 + 0).
    expect(calls.map((c) => c.after_id)).toEqual([null, BASE[1]?.id, BASE[3]?.id]);
    expect(calls.every((c) => c.since === null)).toBe(true);
    const status = await catalogStatus();
    expect(status.count).toBe(4);
    expect(status.last_full_at).not.toBeNull();
  });

  it('synchro delta : p_since = max updated_at, mise à jour et retrait des invisibles', async () => {
    const rows = BASE.map((r) => ({ ...r }));
    const { fetchPage, calls } = server(rows);
    await syncCatalog({ fetchPage });
    // Côté serveur : un prix change, un produit devient invisible, un nouveau apparaît.
    const r1 = rows[0] as CatalogPageRow;
    r1.price_ttc_cents = 999;
    r1.updated_at = '2026-09-20T10:00:00.000Z';
    const r3 = rows[2] as CatalogPageRow;
    r3.pos_visible = false;
    r3.updated_at = '2026-09-20T11:00:00.000Z';
    rows.push(row(6, 'Gomme Staedtler', { updated_at: '2026-09-21T10:00:00.000Z' }));
    calls.length = 0;
    const r = await syncCatalog({ fetchPage });
    expect(r.mode).toBe('delta');
    expect(calls[0]?.since).toBe('2026-09-04T10:00:00.000Z');
    expect(r).toMatchObject({ upserted: 2, deleted: 1, error: null });
    expect(await db.products.count()).toBe(4);
    expect((await db.products.get(r1.id))?.data.price_ttc_cents).toBe(999);
    expect(await db.products.get(r3.id)).toBeUndefined();
  });

  it('synchro complète : les produits disparus du serveur sont retirés', async () => {
    const { fetchPage } = server(BASE);
    await syncCatalog({ fetchPage });
    const second = server(BASE.slice(0, 2));
    const r = await syncCatalog({ fetchPage: second.fetchPage, mode: 'full' });
    expect(r).toMatchObject({ mode: 'full', upserted: 2, deleted: 2 });
    expect(await db.products.count()).toBe(2);
  });

  it('une erreur de synchro est stockée sans lever', async () => {
    const r = await syncCatalog({
      fetchPage: async () => {
        throw new Error('TypeError: Failed to fetch');
      },
    });
    expect(r.error).toMatch(/Failed to fetch/);
    expect((await catalogStatus()).last_error).toMatch(/Failed to fetch/);
  });

  it('recherche locale par jetons (préfixes, accents, plusieurs mots)', async () => {
    await syncCatalog({ fetchPage: server(BASE).fetchPage });
    expect((await searchLocal('stylo', 10)).map((p) => p.name)).toEqual([
      'Stylo bille BIC Cristal bleu',
      'Stylo plume Lamy Safari',
    ]);
    expect((await searchLocal('sty lamy', 10)).map((p) => p.name)).toEqual([
      'Stylo plume Lamy Safari',
    ]);
    expect((await searchLocal('creme', 10)).map((p) => p.name)).toEqual(['Crème pour cuir Saphir']);
    expect(await searchLocal('   ', 10)).toEqual([]);
    expect(await searchLocal('inexistant', 10)).toEqual([]);
  });

  it('EAN : correspondance exacte en tête de recherche et recherche directe', async () => {
    await syncCatalog({ fetchPage: server(BASE).fetchPage });
    const hits = await searchLocal('3037920636016', 5);
    expect(hits[0]?.name).toBe('Cahier Clairefontaine 96p');
    expect((await productByEanLocal('4014519000105'))?.name).toBe('Stylo plume Lamy Safari');
    expect(await productByEanLocal('0000000000000')).toBeNull();
  });

  it('EAN en double : le second produit est conservé sans index unique', async () => {
    const rows = [
      row(1, 'Article A', { ean: '1234567890128' }),
      row(2, 'Article B', { ean: '1234567890128' }),
    ];
    const r = await syncCatalog({ fetchPage: server(rows).fetchPage });
    expect(r.error).toBeNull();
    expect(await db.products.count()).toBe(2);
    expect((await searchLocal('article', 5)).length).toBe(2);
  });
});
