import { computeCart, validateCheckoutPayload, validatePayments } from '@pos/core';
import type { CheckoutPayload } from '@pos/core';
import { ApiError } from '@/lib/apiError';
import type { EdgeClient, PosCheckoutResult } from '@/lib/edge';
import { buildTicketPayload } from '@/lib/ticket';
import { businessDate } from '@/lib/format';
import type {
  ClosePeriodResult,
  ExportArchiveResult,
  PosClosing,
  PosArchive,
  PosPayment,
  PosTransaction,
  PosTransactionLine,
  ResolvedPrice,
  StockAdjustLineResult,
  TransactionFull,
} from '@/types/pos';
import {
  MOCK_CUSTOMERS,
  MOCK_ORDERS,
  MOCK_QUOTES,
  MOCK_REGISTER,
  MOCK_SETTINGS,
  mockResolvePrice,
} from './mockData';
import { mockProducts } from './mockCatalog';
import { assertMockOnline } from './mockNetwork';
import { mockSave, mockState } from './mockStore';

/** `pos_settings.clock_tolerance` (contrat lot 4). */
const CLOCK_TOLERANCE = { online_minutes: 10, offline_hours: 72, future_minutes: 5 };

/** Mois précédent (approximation Europe/Paris : bornes au 1er du mois, heure locale du poste). */
function previousMonthBounds(now = new Date()): { start: Date; end: Date } {
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { start, end };
}

/** Période (mois / année, heure locale du poste) contenant `ref`, ou la précédente si absente. */
function periodBounds(type: 'monthly' | 'annual', ref?: string): { start: Date; end: Date } {
  const r = ref ? new Date(ref) : new Date();
  if (type === 'monthly') {
    const m = ref ? r.getMonth() : r.getMonth() - 1;
    return { start: new Date(r.getFullYear(), m, 1), end: new Date(r.getFullYear(), m + 1, 1) };
  }
  const y = ref ? r.getFullYear() : r.getFullYear() - 1;
  return { start: new Date(y, 0, 1), end: new Date(y + 1, 0, 1) };
}

function fakeHash(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

function uuidFrom(prefix: string, n: number): string {
  return `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/**
 * Échec métier forcé (tests e2e) : `window.__posMockFailNextCheckout = 'TOTALS_MISMATCH'` (ou
 * `localStorage['pos.mock.failNextCheckout']`) fait échouer le prochain enregistrement NON
 * idempotent avec ce code, puis l'interrupteur se désarme.
 */
function takeForcedFailure(): string | null {
  const w = globalThis as { __posMockFailNextCheckout?: string | null };
  let code = w.__posMockFailNextCheckout ?? null;
  try {
    code = code ?? globalThis.localStorage?.getItem('pos.mock.failNextCheckout') ?? null;
    globalThis.localStorage?.removeItem('pos.mock.failNextCheckout');
  } catch {
    // stockage indisponible : interrupteur mémoire seulement
  }
  w.__posMockFailNextCheckout = null;
  return code;
}

export function createMockEdge(): EdgeClient {
  return {
    async checkout(payload: CheckoutPayload): Promise<PosCheckoutResult> {
      assertMockOnline();
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
      if (payload.offline_queued && payload.kind === 'refund') {
        throw new ApiError('VALIDATION', 'Remboursement hors ligne interdit', null, 400);
      }
      // deferred_capture : exige une CB réellement captée (non manuelle).
      const deferred = payload.deferred_capture === true;
      if (
        deferred &&
        !payload.payments.some((p) => p.method === 'cb' && p.manual_fallback !== true)
      ) {
        throw new ApiError('VALIDATION', 'deferred_capture exige une CB captée', null, 400);
      }
      const forced = takeForcedFailure();
      if (forced) throw new ApiError(forced as 'TOTALS_MISMATCH', forced, null, 422);
      // Horodatage métier : ±10 min en ligne ; hors ligne ≤ 72 h dans le passé, ≤ 5 min dans le futur.
      const nowMs = Date.now();
      const businessMs = Date.parse(payload.business_at);
      const outOfRange =
        payload.offline_queued || deferred
          ? businessMs < nowMs - CLOCK_TOLERANCE.offline_hours * 3600_000 ||
            businessMs > nowMs + CLOCK_TOLERANCE.future_minutes * 60_000
          : Math.abs(businessMs - nowMs) > CLOCK_TOLERANCE.online_minutes * 60_000;
      if (outOfRange) {
        throw new ApiError('BUSINESS_AT_OUT_OF_RANGE', 'BUSINESS_AT_OUT_OF_RANGE', null, 422);
      }
      let sessionId = payload.session_id;
      const sessionOpen = !!st.session && st.session.status === 'open';
      if (!sessionOpen || st.session?.id !== payload.session_id) {
        // Vente hors ligne dont la session est fermée : rattachée à la session ouverte.
        if ((payload.offline_queued || deferred) && sessionOpen && st.session) {
          sessionId = st.session.id;
          st.events.push({
            type: 'offline_reattached',
            payload: {
              client_txn_id: payload.client_txn_id,
              from_session_id: payload.session_id,
              to_session_id: sessionId,
            },
            at: new Date().toISOString(),
          });
        } else {
          throw new ApiError('SESSION_NOT_OPEN', 'SESSION_NOT_OPEN', null, 409);
        }
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
        session_id: sessionId,
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
      // Commande transférée : réglée, retirée des commandes à encaisser (pos_settle_orders).
      if (payload.order_id && payload.kind === 'sale') {
        for (const [accountId, orders] of Object.entries(MOCK_ORDERS)) {
          MOCK_ORDERS[accountId] = orders.filter((o) => o.id !== payload.order_id);
        }
      }
      return {
        transaction,
        lines,
        payments,
        ticket: buildTicketPayload(full),
        idempotent_replay: false,
      };
    },
    async exportArchive(input): Promise<ExportArchiveResult> {
      assertMockOnline();
      const st = mockState();
      const { start, end } = input.period_start
        ? (() => {
            const s = new Date(input.period_start);
            return { start: s, end: new Date(s.getFullYear(), s.getMonth() + 1, 1) };
          })()
        : previousMonthBounds();
      const periodStart = start.toISOString();
      const periodEnd = end.toISOString();
      const ym = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`;
      const storagePath = `${MOCK_REGISTER.code}/${ym}.zip`;
      const existing = st.archives.find(
        (a) => a.register_id === MOCK_REGISTER.id && a.period_start === periodStart,
      );
      const txns = st.transactions.filter(
        (t) => t.transaction.business_at >= periodStart && t.transaction.business_at < periodEnd,
      );
      let archive: PosArchive;
      if (existing) {
        archive = existing;
      } else {
        const prev = st.archives[st.archives.length - 1]?.hash ?? '';
        const manifest = fakeHash(`manifest|${storagePath}|${txns.length}`);
        archive = {
          id: uuidFrom('a1000000', st.archives.length + 1),
          register_id: MOCK_REGISTER.id,
          period_start: periodStart,
          period_end: periodEnd,
          storage_path: storagePath,
          manifest_sha256: manifest,
          hash: fakeHash(`archive|${storagePath}|${manifest}|${prev}`),
          created_at: new Date().toISOString(),
        };
        st.archives.push(archive);
        mockSave();
      }
      return {
        archives: [
          {
            register_code: MOCK_REGISTER.code,
            period_start: archive.period_start,
            period_end: archive.period_end,
            storage_path: archive.storage_path,
            manifest_sha256: archive.manifest_sha256,
            hash: archive.hash,
            already_exists: !!existing,
            counts: { transactions: txns.length, events: st.events.length, closings: 0 },
          },
        ],
      };
    },
    async closePeriod(input): Promise<ClosePeriodResult> {
      assertMockOnline();
      const st = mockState();
      const { start, end } = periodBounds(input.period_type, input.period_start);
      const period_start = start.toISOString();
      const period_end = end.toISOString();
      const base = { period_type: input.period_type, period_start, period_end, skipped: [] };
      const existing = st.closings.find(
        (c) => c.period_type === input.period_type && c.period_start === period_start,
      );
      if (existing) return { ...base, closings: [{ ...existing, already_exists: true }] };
      if (end.getTime() > Date.now()) {
        throw new ApiError('PERIOD_NOT_ENDED', undefined, null, 409);
      }
      if (st.session?.status === 'open' && new Date(st.session.opened_at) < end) {
        throw new ApiError('SESSION_OPEN_IN_PERIOD', undefined, null, 409);
      }
      const dailies = st.closings.filter((c) => c.period_type === 'daily');
      if (!dailies.some((c) => new Date(c.period_start) < end)) {
        throw new ApiError('NOTHING_TO_CLOSE', undefined, null, 409);
      }
      const inPeriod = dailies.filter((c) => {
        const t = new Date(c.period_start).getTime();
        return t >= start.getTime() && t < end.getTime();
      });
      const sum = (f: (c: PosClosing) => number): number => inPeriod.reduce((s, c) => s + f(c), 0);
      const vat = new Map<string, PosClosing['vat_breakdown'][number]>();
      const pay = new Map<string, { method: string; amount_cents: number; count: number }>();
      for (const c of inPeriod) {
        for (const v of c.vat_breakdown) {
          const acc = vat.get(v.rate) ?? {
            rate: v.rate,
            base_ht_cents: 0,
            vat_cents: 0,
            ttc_cents: 0,
          };
          acc.base_ht_cents += v.base_ht_cents;
          acc.vat_cents += v.vat_cents;
          acc.ttc_cents += v.ttc_cents;
          vat.set(v.rate, acc);
        }
        for (const p of c.payments_breakdown as Array<{
          method: string;
          amount_cents: number;
          count?: number;
        }>) {
          const acc = pay.get(p.method) ?? { method: p.method, amount_cents: 0, count: 0 };
          acc.amount_cents += p.amount_cents;
          acc.count += p.count ?? 0;
          pay.set(p.method, acc);
        }
      }
      const before = dailies.filter((c) => new Date(c.period_start) < end);
      const number = st.closings.length + 1;
      const firsts = inPeriod
        .map((c) => c.first_ticket_number)
        .filter((n): n is number => n != null);
      const lasts = inPeriod.map((c) => c.last_ticket_number).filter((n): n is number => n != null);
      const closing: PosClosing = {
        id: `77777777-7777-4777-8777-${String(number).padStart(12, '0')}`,
        register_id: input.register_id,
        closing_number: number,
        period_type: input.period_type,
        period_start,
        period_end,
        session_id: null,
        txn_count: sum((c) => c.txn_count),
        first_ticket_number: firsts.length ? Math.min(...firsts) : null,
        last_ticket_number: lasts.length ? Math.max(...lasts) : null,
        total_ht_cents: sum((c) => c.total_ht_cents),
        total_vat_cents: sum((c) => c.total_vat_cents),
        total_ttc_cents: sum((c) => c.total_ttc_cents),
        vat_breakdown: [...vat.values()].sort((a, b) => Number(a.rate) - Number(b.rate)),
        payments_breakdown: [...pay.values()].sort((a, b) => a.method.localeCompare(b.method)),
        refunds_ttc_cents: sum((c) => c.refunds_ttc_cents),
        grand_total_perpetual_cents: before.at(-1)?.grand_total_perpetual_cents ?? 0,
        hash: fakeHash(`closing|${number}|${period_start}`),
        created_at: new Date().toISOString(),
      };
      st.closings.push(closing);
      mockSave();
      return { ...base, closings: [{ ...closing, already_exists: false }] };
    },
    async stockAdjust(input) {
      assertMockOnline();
      if (!input.reason || input.reason.trim().length < 3) {
        throw new ApiError('VALIDATION', 'reason: 3..200 caractères', null, 400);
      }
      if (input.items.length === 0 || input.items.length > 200) {
        throw new ApiError('VALIDATION', 'items: 1..200', null, 400);
      }
      const st = mockState();
      const products = mockProducts();
      const results: StockAdjustLineResult[] = input.items.map((item) => {
        const known = st.stockKeys[item.idempotency_key];
        if (known) return { ...known, applied: false, already_applied: true };
        const product = products.find((p) => p.id === item.product_id);
        if (!product) {
          return {
            product_id: item.product_id,
            applied: false,
            already_applied: false,
            stock_before: 0,
            stock_after: 0,
            delta: 0,
            error: 'PRODUCT_NOT_FOUND',
          };
        }
        const before = product.stock_boutique;
        const r: StockAdjustLineResult = {
          product_id: item.product_id,
          applied: true,
          already_applied: false,
          stock_before: before,
          stock_after: item.counted,
          delta: item.counted - before,
        };
        st.stock[item.product_id] = item.counted;
        st.stockKeys[item.idempotency_key] = r;
        return r;
      });
      st.events.push({
        type: 'stock_adjustment',
        payload: {
          items: results.length,
          delta_sum: results.reduce((s, r) => s + r.delta, 0),
          reason: input.reason,
        },
        at: new Date().toISOString(),
      });
      mockSave();
      return { results };
    },
    async customerSearch(q) {
      assertMockOnline();
      const needle = q.trim().toLowerCase();
      return MOCK_CUSTOMERS.filter(
        (c) =>
          c.display_name.toLowerCase().includes(needle) ||
          (c.company_name ?? '').toLowerCase().includes(needle) ||
          (c.siret ?? '').replace(/\s/g, '').includes(needle.replace(/\s/g, '')),
      );
    },
    async customerQuotes(accountId) {
      assertMockOnline();
      return MOCK_QUOTES[accountId] ?? [];
    },
    async customerOrders(accountId) {
      assertMockOnline();
      return MOCK_ORDERS[accountId] ?? [];
    },
    async resolvePrices(accountId, lines) {
      assertMockOnline();
      const out: ResolvedPrice[] = [];
      for (const l of lines) {
        const r = mockResolvePrice(accountId, l.product_id, l.qty);
        if (r) out.push(r);
      }
      return out;
    },
  };
}
