// Pont commandes (hors périmètre fiscal) : ventes liées à une commande ma-papeterie
// (pos_order_settlements, projet Pos) → pos_settle_orders (projet ma-papeterie), qui retire la
// commande des commandes à encaisser. Ne lève jamais : un échec technique laisse le règlement
// `pending` pour le passage suivant du cron pos-sales-sync.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { settleOrders, type SettleOrderResult } from './mapapeterie.ts';

export interface OrderSettlementOutcome {
  processed: number;
  done: number;
  rejected: number;
  error?: string;
}

interface PendingSettlement {
  transaction_id: string;
}

type SettlementStatus = 'done' | 'rejected' | 'pending';

async function mark(db: SupabaseClient, ids: string[], status: SettlementStatus, error: string | null) {
  if (ids.length === 0) return;
  const { error: e } = await db.rpc('pos_order_settlement_mark', {
    p_transaction_ids: ids,
    p_status: status,
    p_error: error,
  });
  if (e) console.error(`[order-settlement] pos_order_settlement_mark: ${e.message}`);
}

/** Répartit la réponse : appliqué (ou déjà appliqué) → done ; refus métier → rejected ; sinon pending. */
export function splitSettlementResults(
  sent: string[],
  results: SettleOrderResult[],
): { done: string[]; rejected: Array<{ id: string; error: string }>; retry: string[] } {
  const byId = new Map(results.map((r) => [r.transaction_id, r]));
  const done: string[] = [];
  const rejected: Array<{ id: string; error: string }> = [];
  const retry: string[] = [];
  for (const id of sent) {
    const r = byId.get(id);
    if (r && (r.applied || r.already_applied)) done.push(id);
    else if (r?.error) rejected.push({ id, error: r.error });
    else retry.push(id);
  }
  return { done, rejected, retry };
}

/** Inscrit le lien vente → commande (idempotent). Ne lève jamais. */
export async function recordOrderSettlement(
  db: SupabaseClient,
  transactionId: string,
  orderId: string,
): Promise<string | null> {
  const { error } = await db.rpc('pos_order_settlement_record', {
    p_transaction_id: transactionId,
    p_order_id: orderId,
  });
  if (error) {
    console.error(`[order-settlement] pos_order_settlement_record: ${error.message}`);
    return error.message;
  }
  return null;
}

export async function syncPendingOrderSettlements(
  db: SupabaseClient,
  opts: { limit?: number; transactionIds?: string[] } = {},
): Promise<OrderSettlementOutcome> {
  const { data, error } = await db.rpc('pos_order_settlement_pending', {
    p_limit: opts.limit ?? 200,
    p_transaction_ids: opts.transactionIds ?? null,
  });
  if (error) {
    console.error(`[order-settlement] pos_order_settlement_pending: ${error.message}`);
    return { processed: 0, done: 0, rejected: 0, error: error.message };
  }
  const pending = (data ?? []) as PendingSettlement[];
  if (pending.length === 0) return { processed: 0, done: 0, rejected: 0 };
  const ids = pending.map((p) => p.transaction_id);

  try {
    const results = await settleOrders(pending);
    const { done, rejected, retry } = splitSettlementResults(ids, results);
    await mark(db, done, 'done', null);
    for (const r of rejected) await mark(db, [r.id], 'rejected', r.error);
    await mark(db, retry, 'pending', 'NO_RESULT');
    return { processed: ids.length, done: done.length, rejected: rejected.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[order-settlement] ${message}`);
    await mark(db, ids, 'pending', message);
    return { processed: ids.length, done: 0, rejected: 0, error: message };
  }
}
