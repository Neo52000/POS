import { describeApiError, isNetworkFailure } from '@/lib/apiError';
import { db, getMeta, setMeta } from '@/lib/db';
import type { InventoryLine } from '@/lib/db';
import { edge } from '@/lib/edge';
import { rpc } from '@/lib/supabase';
import { uuidv4 } from '@/lib/uuid';
import type {
  PosProduct,
  StockAdjustInput,
  StockAdjustLineResult,
  StockAdjustResult,
} from '@/types/pos';

/**
 * Lot d'inventaire (lot 6) : lignes conservées dans Dexie (`inventory`) jusqu'à confirmation
 * serveur ; clé d'idempotence générée une fois par ligne (nouvelle clé si le comptage change).
 */

export const INVENTORY_CHUNK_SIZE = 100;

const nowIso = (): string => new Date().toISOString();

/** Lignes du lot en cours (hors lignes retirées ou confirmées), dans l'ordre de saisie. */
export async function listInventoryLines(): Promise<InventoryLine[]> {
  return (await db.inventory.orderBy('added_at').toArray()).filter((l) => !l.deleted);
}

export async function upsertInventoryLine(product: PosProduct, counted: number): Promise<void> {
  if (!Number.isInteger(counted) || counted < 0) throw new Error('Quantité comptée invalide');
  await db.transaction('rw', db.inventory, async () => {
    const existing = await db.inventory.where('product_id').equals(product.id).first();
    const live = existing && !existing.deleted ? existing : undefined;
    const now = nowIso();
    if (live && live.counted === counted) {
      await db.inventory.update(live.idempotency_key, {
        stock_seen: product.stock_boutique,
        status: 'pending',
        error: null,
        updated_at: now,
        dirty: true,
      });
      return;
    }
    // Une ligne retirée (tombstone) est remplacée : l'index product_id est unique.
    if (existing) await db.inventory.delete(existing.idempotency_key);
    await db.inventory.add({
      idempotency_key: uuidv4(),
      product_id: product.id,
      label: product.name,
      ean: product.ean,
      stock_seen: product.stock_boutique,
      counted,
      added_at: live?.added_at ?? now,
      status: 'pending',
      error: null,
      updated_at: now,
      dirty: true,
      deleted: false,
    });
  });
}

export async function removeInventoryLine(idempotencyKey: string): Promise<void> {
  await db.inventory.update(idempotencyKey, { deleted: true, dirty: true, updated_at: nowIso() });
}

export interface ConfirmedInventoryLine extends StockAdjustLineResult {
  label: string;
  counted: number;
}

export interface InventorySendReport {
  confirmed: ConfirmedInventoryLine[];
  errors: number;
  stoppedByNetwork: boolean;
}

/** Envoie le lot à `pos-stock-adjust` par tranches de 100 ; retire les lignes confirmées. */
export async function sendInventory(
  reason: string,
  opts: {
    registerId?: string | null;
    adjust?: (input: StockAdjustInput) => Promise<StockAdjustResult>;
  } = {},
): Promise<InventorySendReport> {
  const adjust = opts.adjust ?? ((input: StockAdjustInput) => edge.stockAdjust(input));
  const lines = await listInventoryLines();
  const report: InventorySendReport = { confirmed: [], errors: 0, stoppedByNetwork: false };
  for (let i = 0; i < lines.length; i += INVENTORY_CHUNK_SIZE) {
    const chunk: InventoryLine[] = lines.slice(i, i + INVENTORY_CHUNK_SIZE);
    try {
      const res = await adjust({
        items: chunk.map((l) => ({
          product_id: l.product_id,
          counted: l.counted,
          idempotency_key: l.idempotency_key,
          label: l.label,
        })),
        reason,
        ...(opts.registerId ? { register_id: opts.registerId } : {}),
      });
      for (const line of chunk) {
        const r = res.results.find((x) => x.product_id === line.product_id);
        if (r && !r.error && (r.applied || r.already_applied)) {
          await removeInventoryLine(line.idempotency_key);
          report.confirmed.push({ ...r, label: line.label, counted: line.counted });
        } else {
          await db.inventory.update(line.idempotency_key, {
            status: 'error',
            error: r?.error ?? 'Aucun résultat serveur pour cette ligne',
          });
          report.errors += 1;
        }
      }
    } catch (e) {
      const message = describeApiError(e);
      for (const line of chunk) {
        await db.inventory.update(line.idempotency_key, { status: 'error', error: message });
      }
      report.errors += chunk.length;
      if (isNetworkFailure(e)) {
        report.stoppedByNetwork = true;
        break;
      }
    }
  }
  return report;
}

// --- Synchronisation du lot entre les postes (pos_inventory_sync) ---------------------------------

export const INVENTORY_CURSOR_KEY = 'inventory.sync_cursor';
/** Marge de relecture du curseur : une écriture concurrente validée juste après n'est pas manquée. */
export const INVENTORY_CURSOR_MARGIN_MS = 10_000;

export interface InventoryServerLine {
  product_id: string;
  idempotency_key: string;
  label: string;
  ean: string | null;
  stock_seen: number;
  counted: number;
  added_at: string;
  updated_at: string;
  deleted: boolean;
}

export interface InventorySyncParams {
  p_lines: InventoryServerLine[];
  p_since: string | null;
}

export interface InventorySyncResponse {
  server_time: string;
  lines: InventoryServerLine[];
}

export interface InventorySyncReport {
  pushed: number;
  pulled: number;
}

const ts = (iso: string | undefined): number => (iso ? Date.parse(iso) : Number.NEGATIVE_INFINITY);

/**
 * Synchronise le lot avec le serveur : envoie les lignes modifiées sur ce poste, applique celles
 * modifiées ailleurs. Dernière écriture gagnante par produit (`updated_at`). Un poste hors ligne
 * continue de saisir en local ; tout part à la prochaine synchro.
 */
export async function syncInventory(
  opts: { sync?: (p: InventorySyncParams) => Promise<InventorySyncResponse> } = {},
): Promise<InventorySyncReport> {
  const call =
    opts.sync ??
    ((p: InventorySyncParams) => rpc<InventorySyncResponse>('pos_inventory_sync', { ...p }));
  const rows = await db.inventory.toArray();
  // Lignes d'avant la synchro (sans updated_at) : à envoyer, horodatées à leur création.
  const dirty = rows.filter((l) => l.dirty || !l.updated_at);
  const sent = new Map(dirty.map((l) => [l.idempotency_key, l.updated_at ?? l.added_at]));
  const payload: InventoryServerLine[] = dirty.map((l) => ({
    product_id: l.product_id,
    idempotency_key: l.idempotency_key,
    label: l.label,
    ean: l.ean,
    stock_seen: l.stock_seen,
    counted: l.counted,
    added_at: l.added_at,
    updated_at: l.updated_at ?? l.added_at,
    deleted: !!l.deleted,
  }));
  const since = (await getMeta<string | null>(INVENTORY_CURSOR_KEY)) ?? null;
  const res = await call({ p_lines: payload, p_since: since });

  await db.transaction('rw', db.inventory, async () => {
    // Lignes envoyées : plus « à envoyer », sauf si modifiées pendant l'appel.
    for (const [key, sentAt] of sent) {
      const cur = await db.inventory.get(key);
      if (cur && (cur.updated_at ?? cur.added_at) === sentAt) {
        await db.inventory.update(key, { dirty: false, updated_at: sentAt });
      }
    }
    // Lignes modifiées ailleurs (ou renvoyées par la marge du curseur).
    for (const s of res.lines) {
      const local = await db.inventory.where('product_id').equals(s.product_id).first();
      if (local && ts(s.updated_at) <= ts(local.updated_at ?? local.added_at)) continue;
      if (local) await db.inventory.delete(local.idempotency_key);
      if (s.deleted) continue;
      await db.inventory.add({
        idempotency_key: s.idempotency_key,
        product_id: s.product_id,
        label: s.label,
        ean: s.ean,
        stock_seen: s.stock_seen,
        counted: s.counted,
        added_at: s.added_at,
        status: 'pending',
        error: null,
        updated_at: s.updated_at,
        dirty: false,
        deleted: false,
      });
    }
    // Suppressions déjà transmises : le serveur les conserve pour les autres postes.
    await db.inventory.filter((l) => !!l.deleted && !l.dirty).delete();
  });
  await setMeta(
    INVENTORY_CURSOR_KEY,
    new Date(Date.parse(res.server_time) - INVENTORY_CURSOR_MARGIN_MS).toISOString(),
  );
  return { pushed: payload.length, pulled: res.lines.length };
}
