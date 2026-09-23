import { computeCart, validateCheckoutPayload, validatePayments } from '@pos/core';
import type { CheckoutPayload } from '@pos/core';
import { ApiError } from '@/lib/apiError';
import type { EdgeClient, PosCheckoutResult } from '@/lib/edge';
import { buildTicketPayload } from '@/lib/ticket';
import { businessDate } from '@/lib/format';
import type {
  PosPayment,
  PosTransaction,
  PosTransactionLine,
  ResolvedPrice,
  TransactionFull,
} from '@/types/pos';
import {
  MOCK_CUSTOMERS,
  MOCK_QUOTES,
  MOCK_REGISTER,
  MOCK_SETTINGS,
  mockResolvePrice,
} from './mockData';
import { mockSave, mockState } from './mockStore';

function fakeHash(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

function uuidFrom(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

export function createMockEdge(): EdgeClient {
  return {
    async checkout(payload: CheckoutPayload): Promise<PosCheckoutResult> {
      const st = mockState();
      const existing = st.transactions.find(
        (t) => t.transaction.client_txn_id === payload.client_txn_id,
      );
      if (existing) {
        return {
          transaction: existing.transaction,
          lines: existing.lines,
          payments: existing.payments,
          ticket: buildTicketPayload(existing),
          idempotent_replay: true,
        };
      }
      const valid = validateCheckoutPayload(payload);
      if (!valid.ok) throw new ApiError('VALIDATION', 'Payload invalide', valid.errors, 400);
      if (!st.session || st.session.status !== 'open' || st.session.id !== payload.session_id) {
        throw new ApiError('SESSION_NOT_OPEN', 'SESSION_NOT_OPEN', null, 409);
      }
      const totals = computeCart(payload.lines);
      if (
        totals.total_ttc_cents !== payload.totals.total_ttc_cents ||
        totals.total_ht_cents !== payload.totals.total_ht_cents
      ) {
        throw new ApiError('TOTALS_MISMATCH', 'TOTALS_MISMATCH', totals, 422);
      }
      const pv = validatePayments(totals.total_ttc_cents, payload.payments, payload.change_cents);
      if (!pv.ok) throw new ApiError('PAYMENTS_MISMATCH', pv.message, null, 422);

      let refundOf: TransactionFull | null = null;
      if (payload.kind === 'refund') {
        refundOf =
          st.transactions.find((t) => t.transaction.id === payload.refund_of_transaction_id) ??
          null;
        if (!refundOf)
          throw new ApiError('REFUND_TARGET_NOT_FOUND', 'REFUND_TARGET_NOT_FOUND', null, 404);
        for (const line of payload.lines) {
          const sold = refundOf.lines.find(
            (l) => l.product_id === line.product_id && l.label === line.label,
          );
          const alreadyRefunded = st.transactions
            .filter((t) => t.transaction.refund_of_transaction_id === refundOf?.transaction.id)
            .flatMap((t) => t.lines)
            .filter((l) => l.label === line.label)
            .reduce((s, l) => s + Math.abs(Number(l.qty)), 0);
          if (sold && Math.abs(line.qty) + alreadyRefunded > Number(sold.qty)) {
            throw new ApiError('REFUND_EXCEEDS_SOLD', 'REFUND_EXCEEDS_SOLD', null, 422);
          }
        }
      }

      st.ticketCounter += 1;
      const n = st.ticketCounter;
      const id = uuidFrom('f0000000', n);
      const prev = st.transactions[st.transactions.length - 1]?.transaction.hash ?? null;
      const customer = payload.customer_account_id
        ? MOCK_CUSTOMERS.find((c) => c.id === payload.customer_account_id)
        : undefined;
      const transaction: PosTransaction = {
        id,
        client_txn_id: payload.client_txn_id,
        register_id: payload.register_id,
        session_id: payload.session_id,
        ticket_number: n,
        kind: payload.kind,
        refund_of_transaction_id: payload.refund_of_transaction_id ?? null,
        refund_reason: payload.refund_reason ?? null,
        business_at: payload.business_at,
        business_date: businessDate(payload.business_at),
        received_at: new Date().toISOString(),
        cashier_id: st.user?.id ?? null,
        customer_account_id: payload.customer_account_id ?? null,
        customer_snapshot: customer
          ? {
              display_name: customer.display_name,
              company_name: customer.company_name ?? undefined,
              siret: customer.siret ?? undefined,
              vat_number: customer.vat_number ?? undefined,
            }
          : null,
        quote_id: payload.quote_id ?? null,
        invoice_requested: payload.invoice_requested,
        total_ht_cents: totals.total_ht_cents,
        total_vat_cents: totals.total_vat_cents,
        total_ttc_cents: totals.total_ttc_cents,
        vat_breakdown: totals.vat_breakdown,
        tendered_cents: pv.tendered_cents,
        change_cents: payload.change_cents,
        offline_queued: payload.offline_queued,
        provisional_ref: payload.provisional_ref ?? null,
        prev_hash: prev,
        hash: fakeHash(`${n}|${payload.client_txn_id}|${prev ?? ''}`),
        signature_status: 'mock',
        fiskaly_signature: `mock-sig-${n}`,
        app_version: payload.app_version,
      };
      const lines: PosTransactionLine[] = totals.lines.map((l, i) => ({
        id: uuidFrom('f1000000', n * 100 + i),
        transaction_id: id,
        line_no: l.line_no,
        product_id: l.product_id ?? null,
        ean: l.ean ?? null,
        sku: l.sku ?? null,
        label: l.label,
        qty: l.qty,
        unit_price_ttc_cents: l.unit_price_ttc_cents,
        unit_price_ht_cents: l.unit_price_ht_cents,
        vat_rate: l.vat_rate,
        discount_percent: l.discount_percent,
        discount_reason: null,
        line_ttc_cents: l.line_ttc_cents,
        line_ht_cents: l.line_ht_cents,
        line_vat_cents: l.line_vat_cents,
        eco_tax_cents: l.eco_tax_cents,
        pricing_rule_id: l.pricing_rule_id ?? null,
        price_tier_title: l.price_tier_title ?? null,
        public_price_ttc_cents: l.public_price_ttc_cents ?? null,
      }));
      const payments: PosPayment[] = payload.payments.map((p, i) => ({
        id: uuidFrom('f2000000', n * 100 + i),
        transaction_id: id,
        method: p.method,
        amount_cents: p.amount_cents,
        reference: p.reference ?? null,
        tpe_response: p.tpe_response ?? null,
        manual_fallback: p.manual_fallback === true,
        created_at: new Date().toISOString(),
      }));
      const quote = payload.quote_id
        ? Object.values(MOCK_QUOTES)
            .flat()
            .find((q) => q.id === payload.quote_id)
        : undefined;
      const full: TransactionFull = {
        transaction,
        lines,
        payments,
        register: MOCK_REGISTER,
        settings: MOCK_SETTINGS,
        cashier_name: st.user?.email?.split('@')[0] ?? 'vendeur',
        refund_of: refundOf
          ? {
              id: refundOf.transaction.id,
              ticket_number: refundOf.transaction.ticket_number,
              business_at: refundOf.transaction.business_at,
            }
          : null,
        quote_number: quote?.quote_number ?? null,
      };
      st.transactions.push(full);
      mockSave();
      return {
        transaction,
        lines,
        payments,
        ticket: buildTicketPayload(full),
        idempotent_replay: false,
      };
    },
    async customerSearch(q) {
      const needle = q.trim().toLowerCase();
      return MOCK_CUSTOMERS.filter(
        (c) =>
          c.display_name.toLowerCase().includes(needle) ||
          (c.company_name ?? '').toLowerCase().includes(needle) ||
          (c.siret ?? '').replace(/\s/g, '').includes(needle.replace(/\s/g, '')),
      );
    },
    async customerQuotes(accountId) {
      return MOCK_QUOTES[accountId] ?? [];
    },
    async resolvePrices(accountId, lines) {
      const out: ResolvedPrice[] = [];
      for (const l of lines) {
        const r = mockResolvePrice(accountId, l.product_id, l.qty);
        if (r) out.push(r);
      }
      return out;
    },
  };
}
