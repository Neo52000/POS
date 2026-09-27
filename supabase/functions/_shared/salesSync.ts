// Pont ventes (hors périmètre fiscal) : tickets NF525 des caisses live (projet Pos) →
// pos_record_sales (projet ma-papeterie), pour le dashboard du site. Lecture seule des tables
// fiscales ; l'état d'envoi est tenu dans pos_sales_sync. Ne lève jamais : un échec laisse les
// tickets `pending` pour le passage suivant du cron.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { recordSales, type RecordSaleResult } from './mapapeterie.ts';

export interface SalesSyncOutcome {
  processed: number;
  done: number;
  rejected: number;
  error?: string;
}

interface PendingSale {
  transaction_id: string;
}

async function mark(db: SupabaseClient, ids: string[], ok: boolean, error: string | null) {
  if (ids.length === 0) return;
  const { error: e } = await db.rpc('pos_sales_sync_mark', {
    p_transaction_ids: ids,
    p_ok: ok,
    p_error: error,
  });
  if (e) console.error(`[sales-sync] pos_sales_sync_mark: ${e.message}`);
}

/** Répartit la réponse de pos_record_sales : reçu (ou déjà reçu) → done ; refusé → pending. */
export function splitResults(
  sent: string[],
  results: RecordSaleResult[],
): { done: string[]; rejected: Array<{ id: string; error: string }> } {
  const byId = new Map(results.map((r) => [r.transaction_id, r]));
  const done: string[] = [];
  const rejected: Array<{ id: string; error: string }> = [];
  for (const id of sent) {
    const r = byId.get(id);
    if (r && (r.applied || r.already_applied)) done.push(id);
    else rejected.push({ id, error: r?.error ?? 'NO_RESULT' });
  }
  return { done, rejected };
}

export async function syncPendingSales(db: SupabaseClient, limit = 200): Promise<SalesSyncOutcome> {
  const { data, error } = await db.rpc('pos_sales_sync_pending', { p_limit: limit });
  if (error) {
    console.error(`[sales-sync] pos_sales_sync_pending: ${error.message}`);
    return { processed: 0, done: 0, rejected: 0, error: error.message };
  }
  const sales = (data ?? []) as PendingSale[];
  if (sales.length === 0) return { processed: 0, done: 0, rejected: 0 };
  const ids = sales.map((s) => s.transaction_id);

  try {
    const results = await recordSales(sales);
    const { done, rejected } = splitResults(ids, results);
    await mark(db, done, true, null);
    for (const r of rejected) await mark(db, [r.id], false, r.error);
    return { processed: ids.length, done: done.length, rejected: rejected.length };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[sales-sync] ${message}`);
    await mark(db, ids, false, message);
    return { processed: ids.length, done: 0, rejected: 0, error: message };
  }
}
