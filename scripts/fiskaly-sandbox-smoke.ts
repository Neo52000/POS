/**
 * Smoke test de bout en bout : ouvre une session sur une caisse de test, enchaîne N ventes
 * et 1 remboursement via l'Edge Function pos-checkout (service role), vérifie la chaîne et
 * l'état des signatures, puis clôture la session.
 *
 * Usage : SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm smoke:fiskaly [N=5] [REGISTER=SMOKE-01]
 * En FISKALY_MODE=mock côté Edge, les signatures sont déterministes ; en live, elles viennent du sandbox.
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { computeCart } from '../packages/core/src/index.ts';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis');
  process.exit(2);
}
const n = Number(process.argv[2] ?? 5);
const registerCode = process.argv[3] ?? 'SMOKE-01';
const db = createClient(url, key, { auth: { persistSession: false } });
const fnUrl = `${url}/functions/v1/pos-checkout`;

async function checkout(payload: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(fnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`pos-checkout ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main(): Promise<void> {
  let { data: reg } = await db
    .from('pos_registers')
    .select('id, code')
    .eq('code', registerCode)
    .maybeSingle();
  if (!reg) {
    const { data, error } = await db
      .from('pos_registers')
      .insert({ code: registerCode, label: 'Caisse smoke test', fiskaly_env: 'test' })
      .select('id, code')
      .single();
    if (error) throw error;
    reg = data;
    await db.from('pos_counters').insert(
      ['ticket', 'session', 'closing', 'event'].map((kind) => ({
        register_id: reg!.id,
        kind,
        value: 0,
      })),
    );
  }
  const { data: session, error: sErr } = await db.rpc('pos_open_session', {
    p_register_id: reg.id,
    p_opening_float_cents: 5000,
  });
  if (sErr) throw sErr;
  const sessionId = (session as { id: string }).id;
  console.log(`Session ${sessionId} ouverte sur ${reg.code}`);

  const { data: products } = await db.rpc('pos_search_products', { p_query: 'stylo', p_limit: 3 });
  const catalog = (products ?? []) as Array<{
    id: string;
    name: string;
    ean: string;
    price_ttc_cents: number;
    vat_rate: number;
  }>;
  const sample = catalog[0] ?? {
    id: null,
    name: 'Article test',
    ean: null,
    price_ttc_cents: 1000,
    vat_rate: 20,
  };

  let lastTxnId: string | null = null;
  for (let i = 1; i <= n; i++) {
    const lines = [
      {
        line_no: 1,
        product_id: sample.id,
        ean: sample.ean,
        label: sample.name,
        qty: i,
        unit_price_ttc_cents: sample.price_ttc_cents,
        vat_rate: sample.vat_rate,
        discount_percent: 0,
        eco_tax_cents: 0,
      },
      {
        line_no: 2,
        product_id: null,
        label: 'Photocopie A4',
        qty: 3,
        unit_price_ttc_cents: 25,
        vat_rate: 20,
        discount_percent: 0,
        eco_tax_cents: 0,
      },
    ];
    const cart = computeCart(lines);
    const payload = {
      client_txn_id: randomUUID(),
      register_id: reg.id,
      session_id: sessionId,
      kind: 'sale',
      business_at: new Date().toISOString(),
      offline_queued: false,
      invoice_requested: false,
      lines,
      payments: [
        {
          method: i % 2 ? 'cash' : 'cb',
          amount_cents: cart.total_ttc_cents,
          ...(i % 2 ? {} : { tpe_response: { AE: '10' } }),
        },
      ],
      change_cents: 0,
      totals: {
        total_ht_cents: cart.total_ht_cents,
        total_vat_cents: cart.total_vat_cents,
        total_ttc_cents: cart.total_ttc_cents,
      },
      app_version: 'smoke',
    };
    const out = await checkout(payload);
    const tx = out.transaction as {
      id: string;
      ticket_number: number;
      signature_status: string;
      hash: string;
    };
    lastTxnId = tx.id;
    console.log(
      `  vente ${i}: ticket #${tx.ticket_number} ${tx.signature_status} hash=${tx.hash.slice(0, 8)}`,
    );
  }

  if (lastTxnId) {
    const refundLines = [
      {
        line_no: 1,
        product_id: null,
        label: 'Photocopie A4',
        qty: -1,
        unit_price_ttc_cents: 25,
        vat_rate: 20,
        discount_percent: 0,
        eco_tax_cents: 0,
      },
    ];
    const cart = computeCart(refundLines);
    const out = await checkout({
      client_txn_id: randomUUID(),
      register_id: reg.id,
      session_id: sessionId,
      kind: 'refund',
      refund_of_transaction_id: lastTxnId,
      refund_reason: 'Smoke test remboursement',
      business_at: new Date().toISOString(),
      offline_queued: false,
      invoice_requested: false,
      lines: refundLines,
      payments: [{ method: 'cash', amount_cents: cart.total_ttc_cents }],
      change_cents: 0,
      totals: {
        total_ht_cents: cart.total_ht_cents,
        total_vat_cents: cart.total_vat_cents,
        total_ttc_cents: cart.total_ttc_cents,
      },
      app_version: 'smoke',
    });
    const tx = out.transaction as { ticket_number: number; signature_status: string };
    console.log(`  remboursement: ticket #${tx.ticket_number} ${tx.signature_status}`);
  }

  const { data: chain, error: cErr } = await db.rpc('pos_verify_chain', { p_register_id: reg.id });
  if (cErr) throw cErr;
  console.log('pos_verify_chain :', JSON.stringify(Array.isArray(chain) ? chain[0] : chain));

  const { data: closing, error: clErr } = await db.rpc('pos_close_session', {
    p_session_id: sessionId,
    p_counted_cash_cents: 5000,
    p_notes: 'smoke',
  });
  if (clErr) throw clErr;
  console.log('Clôture :', JSON.stringify(closing).slice(0, 400));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
