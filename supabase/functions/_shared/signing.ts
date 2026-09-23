import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { getFiskalyClient, type FiskalyRegister, type TransactionForSigning } from './fiskaly/index.ts';
import { ticketCode } from './ticket.ts';

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

export interface SignOutcome {
  transaction_id: string;
  status: 'signed' | 'pending_signature' | 'failed';
  error?: string;
}

/** Charge la transaction complète via la RPC `pos_transaction_full` (service role). */
export async function loadTransactionFull(db: SupabaseClient, transactionId: string): Promise<Json> {
  const { data, error } = await db.rpc('pos_transaction_full', { p_transaction_id: transactionId });
  if (error) throw new Error(`pos_transaction_full: ${error.message}`);
  if (!data) throw new Error(`Transaction introuvable : ${transactionId}`);
  return data as Json;
}

async function ensureSystemId(db: SupabaseClient, register: Json): Promise<string> {
  if (register.fiskaly_system_id) return String(register.fiskaly_system_id);
  const fiskaly = getFiskalyClient();
  const reg: FiskalyRegister = {
    id: String(register.id),
    code: String(register.code),
    label: register.label ?? null,
    fiskaly_env: register.fiskaly_env === 'live' ? 'live' : 'test',
    fiskaly_system_id: null,
  };
  const systemId = await fiskaly.commissionSystem(reg);
  const { error } = await db
    .from('pos_registers')
    .update({ fiskaly_system_id: systemId })
    .eq('id', register.id);
  if (error) throw new Error(`pos_registers.fiskaly_system_id: ${error.message}`);
  return systemId;
}

function toSigningInput(full: Json): TransactionForSigning {
  const t: Json = full.transaction;
  return {
    id: String(t.id),
    ticket_number: Number(t.ticket_number),
    ticket_code: ticketCode(String(t.business_at), Number(t.ticket_number)),
    kind: t.kind === 'refund' ? 'refund' : 'sale',
    business_at: String(t.business_at),
    register_code: String(full.register?.code ?? ''),
    hash: String(t.hash),
    prev_hash: t.prev_hash ?? null,
    total_ht_cents: Number(t.total_ht_cents),
    total_vat_cents: Number(t.total_vat_cents),
    total_ttc_cents: Number(t.total_ttc_cents),
    vat_breakdown: (t.vat_breakdown ?? []).map((v: Json) => ({
      rate: String(v.rate),
      base_ht_cents: Number(v.base_ht_cents),
      vat_cents: Number(v.vat_cents),
      ttc_cents: Number(v.ttc_cents),
    })),
    lines: (full.lines ?? []).map((l: Json) => ({
      line_no: Number(l.line_no),
      label: String(l.label),
      qty: Number(l.qty),
      unit_price_ttc_cents: Number(l.unit_price_ttc_cents),
      vat_rate: l.vat_rate,
      discount_percent: Number(l.discount_percent ?? 0),
      line_ttc_cents: Number(l.line_ttc_cents),
      line_ht_cents: Number(l.line_ht_cents),
      line_vat_cents: Number(l.line_vat_cents),
    })),
    payments: (full.payments ?? []).map((p: Json) => ({
      method: String(p.method),
      amount_cents: Number(p.amount_cents),
      reference: p.reference ?? null,
    })),
    customer_snapshot: t.customer_snapshot ?? null,
  };
}

/**
 * Signe une transaction déjà insérée et chaînée. N'échoue jamais « fort » : en cas d'erreur
 * Fiskaly la transaction reste `pending_signature` (rejouée par le cron pos-sign-pending).
 */
export async function signTransaction(db: SupabaseClient, transactionId: string): Promise<SignOutcome> {
  const full = await loadTransactionFull(db, transactionId);
  const t: Json = full.transaction;
  if (t.signature_status === 'signed') return { transaction_id: transactionId, status: 'signed' };
  try {
    const systemId = await ensureSystemId(db, full.register ?? {});
    const fiskaly = getFiskalyClient();
    const sig = await fiskaly.createTransactionRecord(systemId, toSigningInput(full));
    const { error } = await db.rpc('pos_mark_signature', {
      p_transaction_id: transactionId,
      p_status: 'signed',
      p_record_id: sig.record_id,
      p_signature: sig.signature,
      p_payload: sig.raw ?? null,
      p_error: null,
    });
    if (error) throw new Error(`pos_mark_signature: ${error.message}`);
    return { transaction_id: transactionId, status: 'signed' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[signing] ${transactionId}: ${message}`);
    const attempts = Number(t.signature_attempts ?? 0) + 1;
    const status = attempts >= 50 ? 'failed' : 'pending_signature';
    const { error } = await db.rpc('pos_mark_signature', {
      p_transaction_id: transactionId,
      p_status: status,
      p_record_id: null,
      p_signature: null,
      p_payload: null,
      p_error: message.slice(0, 500),
    });
    if (error) console.error(`[signing] pos_mark_signature(error) ${transactionId}: ${error.message}`);
    await db.rpc('pos_log_event', {
      p_event_type: 'signature_failed',
      p_payload: { transaction_id: transactionId, error: message.slice(0, 500), attempts },
      p_register_id: t.register_id ?? null,
      p_session_id: t.session_id ?? null,
    });
    return { transaction_id: transactionId, status, error: message };
  }
}
