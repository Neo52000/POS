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
  order_id: string;
}

/** Couple (vente, commande) : une vente peut régler plusieurs commandes (encaissement groupé). */
export interface SettlementKey {
  transaction_id: string;
  order_id: string;
}

type SettlementStatus = 'done' | 'rejected' | 'pending';

async function mark(
  db: SupabaseClient,
  keys: SettlementKey[],
  status: SettlementStatus,
  error: string | null,
) {
  if (keys.length === 0) return;
  const { error: e } = await db.rpc('pos_order_settlement_mark', {
    p_transaction_ids: keys.map((k) => k.transaction_id),
    p_order_ids: keys.map((k) => k.order_id),
    p_status: status,
    p_error: error,
  });
  if (e) console.error(`[order-settlement] pos_order_settlement_mark: ${e.message}`);
}

/**
 * Répartit la réponse par couple (vente, commande) : appliqué (ou déjà appliqué) → done ; refus
 * métier → rejected ; sinon pending. Une réponse sans `order_id` (ma-papeterie pas encore migrée)
 * ne vaut que pour une vente à commande unique : une vente groupée reste alors en attente, pour
 * ne jamais marquer réglée une commande que ma-papeterie n'a pas inscrite.
 */
export function splitSettlementResults(
  sent: SettlementKey[],
  results: SettleOrderResult[],
): { done: SettlementKey[]; rejected: Array<{ key: SettlementKey; error: string }>; retry: SettlementKey[] } {
  const byPair = new Map<string, SettleOrderResult>();
  const byTxnLegacy = new Map<string, SettleOrderResult>();
  for (const r of results) {
    if (r.order_id) byPair.set(`${r.transaction_id}:${r.order_id}`, r);
    else byTxnLegacy.set(r.transaction_id, r);
  }
  const ordersPerTxn = new Map<string, number>();
  for (const k of sent) ordersPerTxn.set(k.transaction_id, (ordersPerTxn.get(k.transaction_id) ?? 0) + 1);

  const done: SettlementKey[] = [];
  const rejected: Array<{ key: SettlementKey; error: string }> = [];
  const retry: SettlementKey[] = [];
  for (const k of sent) {
    const r =
      byPair.get(`${k.transaction_id}:${k.order_id}`) ??
      (ordersPerTxn.get(k.transaction_id) === 1 ? byTxnLegacy.get(k.transaction_id) : undefined);
    if (r && (r.applied || r.already_applied)) done.push(k);
    else if (r?.error) rejected.push({ key: k, error: r.error });
    else retry.push(k);
  }
  return { done, rejected, retry };
}

/**
 * Inscrit le lien vente → commandes (idempotent, ensemble figé à la première inscription).
 * Ne lève jamais.
 */
export async function recordOrderSettlement(
  db: SupabaseClient,
  transactionId: string,
  orderIds: string[],
): Promise<string | null> {
  if (orderIds.length === 0) return null;
  const { error } = await db.rpc('pos_order_settlement_record_many', {
    p_transaction_id: transactionId,
    p_order_ids: orderIds,
  });
  if (error) {
    console.error(`[order-settlement] pos_order_settlement_record_many: ${error.message}`);
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
  const keys: SettlementKey[] = pending.map((p) => ({
    transaction_id: p.transaction_id,
    order_id: p.order_id,
  }));

  try {
    const results = await settleOrders(pending);
    const { done, rejected, retry } = splitSettlementResults(keys, results);
    await mark(db, done, 'done', null);
    for (const r of rejected) await mark(db, [r.key], 'rejected', r.error);
    await mark(db, retry, 'pending', 'NO_RESULT');
    return { processed: keys.length, done: done.length, rejected: rejected.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[order-settlement] ${message}`);
    await mark(db, keys, 'pending', message);
    return { processed: keys.length, done: 0, rejected: 0, error: message };
  }
}
