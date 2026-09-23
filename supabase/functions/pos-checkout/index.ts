// =============================================================================
// pos-checkout — validation d'une vente/remboursement (SPEC §4-5).
// 1. Auth vendeur (rôle pos) 2. Snapshot client pro (ma-papeterie) 3. RPC pos_finalize_sale
// (transaction atomique, chaînage, file de stock) 4. Application du stock sur ma-papeterie
// (non bloquante, rejouée par cron) 5. Signature Fiskaly (non bloquante) 6. TicketPayload.
// =============================================================================
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { fetchCustomerSnapshot } from '../_shared/mapapeterie.ts';
import { loadTransactionFull, signTransaction } from '../_shared/signing.ts';
import { syncStockForTransaction } from '../_shared/stockSync.ts';
import { buildTicketPayload } from '../_shared/ticket.ts';

const uuid = z.string().uuid();
const cents = z.number().int();

const LineSchema = z.object({
  line_no: z.number().int().positive(),
  product_id: uuid.nullable().optional(),
  ean: z.string().max(20).nullable().optional(),
  sku: z.string().max(64).nullable().optional(),
  label: z.string().min(1).max(200),
  qty: z.number().refine((q) => q !== 0, 'qty ≠ 0'),
  unit_price_ttc_cents: cents.nonnegative(),
  vat_rate: z.union([z.number(), z.string()]),
  discount_percent: z.number().min(0).max(100).default(0),
  discount_reason: z.string().max(200).nullable().optional(),
  eco_tax_cents: cents.nonnegative().default(0),
  pricing_rule_id: uuid.nullable().optional(),
  price_tier_title: z.string().max(120).nullable().optional(),
  public_price_ttc_cents: cents.nullable().optional(),
});

const PaymentSchema = z.object({
  method: z.enum(['cb', 'cash', 'cheque', 'gift_ucia', 'transfer']),
  amount_cents: cents,
  reference: z.string().max(120).nullable().optional(),
  tpe_response: z.unknown().optional(),
  manual_fallback: z.boolean().default(false),
});

export const CheckoutSchema = z
  .object({
    client_txn_id: uuid,
    register_id: uuid,
    session_id: uuid,
    kind: z.enum(['sale', 'refund']),
    refund_of_transaction_id: uuid.optional(),
    refund_reason: z.string().min(3).max(300).optional(),
    business_at: z.string().datetime({ offset: true }),
    offline_queued: z.boolean().default(false),
    provisional_ref: z.string().max(64).optional(),
    customer_account_id: uuid.optional(),
    quote_id: uuid.optional(),
    invoice_requested: z.boolean().default(false),
    lines: z.array(LineSchema).min(1),
    payments: z.array(PaymentSchema).min(1),
    change_cents: cents.nonnegative().default(0),
    totals: z.object({ total_ht_cents: cents, total_vat_cents: cents, total_ttc_cents: cents }),
    app_version: z.string().max(40),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'refund' && (!v.refund_of_transaction_id || !v.refund_reason)) {
      ctx.addIssue({ code: 'custom', message: 'refund_of_transaction_id et refund_reason requis pour un remboursement' });
    }
    for (const p of v.payments) {
      if (['cheque', 'gift_ucia', 'transfer'].includes(p.method) && !(p.reference ?? '').trim()) {
        ctx.addIssue({ code: 'custom', message: `référence obligatoire pour ${p.method}` });
      }
      if (p.method === 'cb' && p.manual_fallback) {
        const r = (p.tpe_response as { reason?: string } | undefined)?.reason;
        if (!r) ctx.addIssue({ code: 'custom', message: 'tpe_response.reason requis pour un fallback manuel CB' });
      }
    }
    if (v.change_cents > 0 && !v.payments.some((p) => p.method === 'cash')) {
      ctx.addIssue({ code: 'custom', message: 'rendu monnaie sans paiement espèces' });
    }
  });

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    if (req.method !== 'POST') throw new ApiError('VALIDATION', 'POST attendu');
    const auth = await requirePos(req);
    const parsed = CheckoutSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    }
    const payload: Record<string, unknown> = { ...parsed.data };

    // Snapshot client pro (données ma-papeterie), figée sur le ticket.
    if (parsed.data.customer_account_id) {
      const snap = await fetchCustomerSnapshot(parsed.data.customer_account_id);
      if (!snap) throw new ApiError('NOT_FOUND', 'Client pro introuvable', { account_id: parsed.data.customer_account_id });
      payload.customer_snapshot = {
        id: snap.id,
        display_name: snap.display_name ?? snap.company_name ?? '',
        company_name: snap.company_name,
        siret: snap.siret,
        vat_number: snap.vat_number,
        customer_type: snap.customer_type,
      };
    }

    // La RPC est appelée avec le JWT utilisateur (is_pos() + auth.uid() comme caissier) ;
    // pour un appel service (tests/crons) on utilise le service role.
    const rpcClient = auth.userDb ?? auth.db;
    const { data, error } = await rpcClient.rpc('pos_finalize_sale', { p_payload: payload });
    if (error) throw error;
    const result = data as { transaction: { id: string }; idempotent_replay?: boolean };
    const transactionId = result.transaction.id;

    // Signature Fiskaly : jamais bloquante pour la vente.
    await signTransaction(auth.db, transactionId);

    const full = await loadTransactionFull(auth.db, transactionId);

    // Stock boutique (ma-papeterie) : application immédiate, rejouée par le cron en cas d'échec.
    const ticketRef = String(full.transaction?.ticket_number ?? transactionId);
    const stock = await syncStockForTransaction(auth.db, transactionId, ticketRef);
    return json(200, {
      transaction: full.transaction,
      lines: full.lines,
      payments: full.payments,
      ticket: buildTicketPayload(full),
      idempotent_replay: result.idempotent_replay === true,
      stock_sync: { done: stock.done, pending: stock.processed - stock.done, error: stock.error ?? null },
    });
  } catch (e) {
    return errorResponse(e);
  }
});
