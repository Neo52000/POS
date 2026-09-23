// File `pos_stock_sync` (projet Pos) → `pos_apply_stock_movements` (projet ma-papeterie).
// Idempotent par idempotency_key ; un échec laisse la ligne `pending` pour le cron pos-stock-sync.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { applyStockMovements, type StockMovementInput } from './mapapeterie.ts';

interface StockSyncRow {
  id: number;
  transaction_id: string;
  product_id: string;
  qty_delta: number;
  idempotency_key: string;
  attempts: number;
}

export interface StockSyncOutcome {
  processed: number;
  done: number;
  failed: number;
  error?: string;
}

async function markRows(
  db: SupabaseClient,
  rows: StockSyncRow[],
  status: 'done' | 'pending' | 'failed',
  error: string | null,
  stockAfter: Map<string, number | null>,
): Promise<void> {
  for (const row of rows) {
    const { error: e } = await db.rpc('pos_stock_sync_mark', {
      p_id: row.id,
      p_status: status,
      p_error: error,
      p_remote_stock_after: stockAfter.get(row.idempotency_key) ?? null,
    });
    if (e) console.error(`[stock-sync] pos_stock_sync_mark ${row.id}: ${e.message}`);
  }
}

/** Applique un lot de lignes de la file. Ne lève jamais : les erreurs sont journalisées. */
export async function syncStockRows(db: SupabaseClient, rows: StockSyncRow[], ticketRefs: Map<string, string>): Promise<StockSyncOutcome> {
  if (rows.length === 0) return { processed: 0, done: 0, failed: 0 };
  const movements: StockMovementInput[] = rows.map((r) => ({
    idempotency_key: r.idempotency_key,
    product_id: r.product_id,
    qty_delta: r.qty_delta,
    transaction_ref: ticketRefs.get(r.transaction_id) ?? r.transaction_id,
  }));
  try {
    const results = await applyStockMovements(movements);
    const after = new Map(results.map((r) => [r.idempotency_key, r.stock_after]));
    await markRows(db, rows, 'done', null, after);
    return { processed: rows.length, done: rows.length, failed: 0 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[stock-sync] ${message}`);
    const exhausted = rows.filter((r) => r.attempts + 1 >= 100);
    const retry = rows.filter((r) => r.attempts + 1 < 100);
    await markRows(db, retry, 'pending', message.slice(0, 500), new Map());
    await markRows(db, exhausted, 'failed', message.slice(0, 500), new Map());
    return { processed: rows.length, done: 0, failed: exhausted.length, error: message };
  }
}

/** Synchronise immédiatement le stock d'une transaction (appelé par pos-checkout). */
export async function syncStockForTransaction(db: SupabaseClient, transactionId: string, ticketRef: string): Promise<StockSyncOutcome> {
  const { data, error } = await db
    .from('pos_stock_sync')
    .select('id, transaction_id, product_id, qty_delta, idempotency_key, attempts')
    .eq('transaction_id', transactionId)
    .eq('status', 'pending');
  if (error) {
    console.error(`[stock-sync] lecture file: ${error.message}`);
    return { processed: 0, done: 0, failed: 0, error: error.message };
  }
  return syncStockRows(db, (data ?? []) as StockSyncRow[], new Map([[transactionId, ticketRef]]));
}

/** Rejoue toutes les lignes pending (cron pos-stock-sync). */
export async function syncPendingStock(db: SupabaseClient, limit = 100): Promise<StockSyncOutcome> {
  const { data, error } = await db.rpc('pos_stock_sync_pending', { p_limit: limit });
  if (error) {
    console.error(`[stock-sync] pos_stock_sync_pending: ${error.message}`);
    return { processed: 0, done: 0, failed: 0, error: error.message };
  }
  const rows = (data ?? []) as StockSyncRow[];
  return syncStockRows(db, rows, new Map());
}
