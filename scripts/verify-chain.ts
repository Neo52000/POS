/**
 * Vérifie l'intégrité de la chaîne de tickets d'une caisse, hors base :
 * recalcule chaque hash avec @pos/core (implémentation miroir de pos_canonical_txn)
 * ET appelle pos_verify_chain côté SQL. Les deux doivent être OK.
 *
 * Usage : SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm verify-chain [REGISTER_CODE]
 */
import { createClient } from '@supabase/supabase-js';
import { computeTransactionHash, verifyChain, type ChainedTxn } from '@pos/core';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis');
  process.exit(2);
}
const registerCode = process.argv[2] ?? 'CHAUMONT-01';
const db = createClient(url, key, { auth: { persistSession: false } });

async function main(): Promise<void> {
  const { data: reg, error: regErr } = await db
    .from('pos_registers')
    .select('id, code')
    .eq('code', registerCode)
    .single();
  if (regErr || !reg) throw new Error(`Caisse ${registerCode} introuvable`);

  const { data: txs, error } = await db
    .from('pos_transactions')
    .select('*, pos_transaction_lines(*), pos_payments(*)')
    .eq('register_id', reg.id)
    .order('ticket_number', { ascending: true });
  if (error) throw error;

  const chained: ChainedTxn[] = (txs ?? []).map((t) => {
    const input = {
      ticket_number: Number(t.ticket_number),
      register_code: reg.code,
      client_txn_id: t.client_txn_id,
      business_at: new Date(t.business_at).toISOString(),
      kind: t.kind,
      total_ht_cents: Number(t.total_ht_cents),
      total_vat_cents: Number(t.total_vat_cents),
      total_ttc_cents: Number(t.total_ttc_cents),
      vat_breakdown: t.vat_breakdown,
      customer_account_id: t.customer_account_id ?? null,
      lines: (t.pos_transaction_lines ?? []).map((l: Record<string, unknown>) => ({
        line_no: Number(l.line_no),
        product_id: (l.product_id as string | null) ?? null,
        ean: (l.ean as string | null) ?? null,
        label: String(l.label),
        qty: Number(l.qty),
        unit_price_ttc_cents: Number(l.unit_price_ttc_cents),
        vat_rate: String(l.vat_rate),
        discount_percent: Number(l.discount_percent ?? 0),
        line_ttc_cents: Number(l.line_ttc_cents),
      })),
      payments: (t.pos_payments ?? []).map((p: Record<string, unknown>) => ({
        method: String(p.method),
        amount_cents: Number(p.amount_cents),
        reference: (p.reference as string | null) ?? null,
      })),
      prev_hash: t.prev_hash ?? null,
    };
    return { ticket_number: input.ticket_number, prev_hash: input.prev_hash, hash: t.hash, input };
  });

  const local = verifyChain(chained, computeTransactionHash);
  const { data: sqlCheck, error: sqlErr } = await db.rpc('pos_verify_chain', { p_register_id: reg.id });
  if (sqlErr) throw sqlErr;
  const sqlRow = Array.isArray(sqlCheck) ? sqlCheck[0] : sqlCheck;

  console.log(`Caisse ${reg.code} — ${chained.length} tickets`);
  console.log('Vérification locale (@pos/core) :', local.ok ? 'OK' : `RUPTURE ${JSON.stringify(local)}`);
  console.log('Vérification SQL (pos_verify_chain) :', sqlRow?.ok ? 'OK' : `RUPTURE ${JSON.stringify(sqlRow)}`);
  process.exit(local.ok && sqlRow?.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
