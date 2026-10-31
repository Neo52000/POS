// Pont commandes (hors périmètre fiscal), deux outbox du projet Pos :
//   * pos_order_settlements (vente → commande entière) → pos_settle_orders (ancien modèle, tickets
//     en file d'une version antérieure) ;
//   * pos_document_settlements (vente → lignes de commandes / BL) → pos_settle_documents.
// Côté ma-papeterie, la commande ou les lignes réglées sortent des documents à encaisser. Ne lève jamais : un échec technique laisse le règlement
// `pending` pour le passage suivant du cron pos-sales-sync.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { settleDocuments, settleOrders, type SettleOrderResult } from './mapapeterie.ts';

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

/** Une outbox : préfixe des RPC Pos (`<prefix>_pending` / `_mark`) et RPC ma-papeterie. */
interface SettlementBridge {
  prefix: 'pos_order_settlement' | 'pos_document_settlement';
  send: (settlements: unknown[]) => Promise<SettleOrderResult[]>;
}

const ORDER_BRIDGE: SettlementBridge = { prefix: 'pos_order_settlement', send: settleOrders };
const DOCUMENT_BRIDGE: SettlementBridge = { prefix: 'pos_document_settlement', send: settleDocuments };

async function mark(
  db: SupabaseClient,
  bridge: SettlementBridge,
  ids: string[],
  status: SettlementStatus,
  error: string | null,
) {
  if (ids.length === 0) return;
  const { error: e } = await db.rpc(`${bridge.prefix}_mark`, {
    p_transaction_ids: ids,
    p_status: status,
    p_error: error,
  });
  if (e) console.error(`[order-settlement] ${bridge.prefix}_mark: ${e.message}`);
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

/** Inscrit les lignes de commandes / BL réglées par une vente (idempotent). Ne lève jamais. */
export async function recordDocumentSettlement(
  db: SupabaseClient,
  transactionId: string,
  lines: unknown[],
): Promise<string | null> {
  const { error } = await db.rpc('pos_document_settlement_record', {
    p_transaction_id: transactionId,
    p_lines: lines,
  });
  if (error) {
    console.error(`[order-settlement] pos_document_settlement_record: ${error.message}`);
    return error.message;
  }
  return null;
}

export function syncPendingOrderSettlements(
  db: SupabaseClient,
  opts: { limit?: number; transactionIds?: string[] } = {},
): Promise<OrderSettlementOutcome> {
  return syncPending(db, ORDER_BRIDGE, opts);
}

export function syncPendingDocumentSettlements(
  db: SupabaseClient,
  opts: { limit?: number; transactionIds?: string[] } = {},
): Promise<OrderSettlementOutcome> {
  return syncPending(db, DOCUMENT_BRIDGE, opts);
}

async function syncPending(
  db: SupabaseClient,
  bridge: SettlementBridge,
  opts: { limit?: number; transactionIds?: string[] },
): Promise<OrderSettlementOutcome> {
  const { data, error } = await db.rpc(`${bridge.prefix}_pending`, {
    p_limit: opts.limit ?? 200,
    p_transaction_ids: opts.transactionIds ?? null,
  });
  if (error) {
    console.error(`[order-settlement] ${bridge.prefix}_pending: ${error.message}`);
    return { processed: 0, done: 0, rejected: 0, error: error.message };
  }
  const pending = (data ?? []) as PendingSettlement[];
  if (pending.length === 0) return { processed: 0, done: 0, rejected: 0 };
  const ids = pending.map((p) => p.transaction_id);

  try {
    const results = await bridge.send(pending);
    const { done, rejected, retry } = splitSettlementResults(ids, results);
    await mark(db, bridge, done, 'done', null);
    for (const r of rejected) await mark(db, bridge, [r.id], 'rejected', r.error);
    await mark(db, bridge, retry, 'pending', 'NO_RESULT');
    return { processed: ids.length, done: done.length, rejected: rejected.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[order-settlement] ${message}`);
    await mark(db, bridge, ids, 'pending', message);
    return { processed: ids.length, done: 0, rejected: 0, error: message };
  }
}
