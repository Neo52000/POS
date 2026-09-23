import { roundHalfAwayFromZero } from './money.js';
import { normalizeVatRate, ttcToHtCents, vatRateToBasisPoints } from './vat.js';

/** Ligne de panier telle que saisie par la PWA (SPEC §2). Montants en centimes entiers. */
export interface CartLineInput {
  line_no: number;
  product_id?: string | null;
  ean?: string | null;
  sku?: string | null;
  label: string;
  qty: number;
  unit_price_ttc_cents: number;
  /** `20`, `"20"`, `"5.50"` … normalisé par `normalizeVatRate()`. */
  vat_rate: number | string;
  /** 0..100, 2 décimales. Défaut `0`. */
  discount_percent?: number;
  /** Inclus dans le TTC, informatif. Défaut `0`. */
  eco_tax_cents?: number;
  pricing_rule_id?: string | null;
  price_tier_title?: string | null;
  public_price_ttc_cents?: number | null;
}

/** Ligne calculée (SPEC §2). `vat_rate` est la chaîne canonique (`"20.00"`). */
export interface ComputedLine extends Omit<
  CartLineInput,
  'vat_rate' | 'discount_percent' | 'eco_tax_cents'
> {
  vat_rate: string;
  discount_percent: number;
  eco_tax_cents: number;
  unit_after_discount_cents: number;
  line_ttc_cents: number;
  line_ht_cents: number;
  line_vat_cents: number;
  /** Informatif : HT unitaire avant remise. */
  unit_price_ht_cents: number;
}

export interface VatBreakdownEntry {
  rate: string;
  base_ht_cents: number;
  vat_cents: number;
  ttc_cents: number;
}

export interface CartTotals {
  lines: ComputedLine[];
  vat_breakdown: VatBreakdownEntry[];
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
}

export const PAYMENT_METHODS = ['cb', 'cash', 'cheque', 'gift_ucia', 'transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  cb: 'Carte bancaire',
  cash: 'Espèces',
  cheque: 'Chèque',
  gift_ucia: 'Bon cadeau UCIA',
  transfer: 'Virement',
};

/** Méthodes dont la `reference` est obligatoire (SPEC §4). */
export const PAYMENT_METHODS_REQUIRING_REFERENCE: ReadonlySet<PaymentMethod> =
  new Set<PaymentMethod>(['cheque', 'gift_ucia', 'transfer']);

export interface PaymentInput {
  method: PaymentMethod;
  amount_cents: number;
  reference?: string | null;
  tpe_response?: unknown;
  manual_fallback?: boolean;
}

export type PaymentsValidationCode =
  | 'PAYMENTS_MISMATCH'
  | 'CHANGE_WITHOUT_CASH'
  | 'MISSING_REFERENCE'
  | 'MANUAL_FALLBACK_REASON_REQUIRED';

export type PaymentsValidation =
  | { ok: true; tendered_cents: number }
  | { ok: false; code: PaymentsValidationCode; message: string };

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

function assertInteger(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RangeError(`${field} must be an integer number of cents, got ${String(value)}`);
  }
}

/** Quantité en millièmes (entier) — garantit un calcul exact équivalent à `numeric(10,3)`. */
function qtyToMilli(qty: number): number {
  if (typeof qty !== 'number' || !Number.isFinite(qty)) {
    throw new RangeError(`qty must be a finite number, got ${String(qty)}`);
  }
  const milli = Math.round(qty * 1000);
  if (Math.abs(qty * 1000 - milli) > 1e-6) {
    throw new RangeError(`qty must have at most 3 decimals, got ${String(qty)}`);
  }
  return milli;
}

/** Remise en points de base (entier 0..10000) — équivalent à `numeric(5,2)`. */
function discountToBasisPoints(discount: number): number {
  if (
    typeof discount !== 'number' ||
    !Number.isFinite(discount) ||
    discount < 0 ||
    discount > 100
  ) {
    throw new RangeError(`discount_percent must be between 0 and 100, got ${String(discount)}`);
  }
  const bp = Math.round(discount * 100);
  if (Math.abs(discount * 100 - bp) > 1e-6) {
    throw new RangeError(`discount_percent must have at most 2 decimals, got ${String(discount)}`);
  }
  return bp;
}

/** Calcul d'une ligne (SPEC §2, étapes 1 à 5). */
export function computeLine(input: CartLineInput): ComputedLine {
  assertInteger(input.unit_price_ttc_cents, 'unit_price_ttc_cents');
  const discountPercent = input.discount_percent ?? 0;
  const discountBp = discountToBasisPoints(discountPercent);
  const qtyMilli = qtyToMilli(input.qty);
  const ecoTax = input.eco_tax_cents ?? 0;
  assertInteger(ecoTax, 'eco_tax_cents');
  const vatRate = normalizeVatRate(input.vat_rate);
  const rateBp = vatRateToBasisPoints(vatRate);

  const unitAfterDiscount = roundHalfAwayFromZero(
    (input.unit_price_ttc_cents * (10000 - discountBp)) / 10000,
  );
  const lineTtc = roundHalfAwayFromZero((unitAfterDiscount * qtyMilli) / 1000);
  const lineHt = roundHalfAwayFromZero((lineTtc * 10000) / (10000 + rateBp));
  const lineVat = lineTtc - lineHt;
  const unitHt = ttcToHtCents(input.unit_price_ttc_cents, vatRate);

  return {
    ...input,
    vat_rate: vatRate,
    discount_percent: discountBp / 100,
    eco_tax_cents: ecoTax,
    unit_after_discount_cents: unitAfterDiscount,
    line_ttc_cents: lineTtc,
    line_ht_cents: lineHt,
    line_vat_cents: lineVat,
    unit_price_ht_cents: unitHt,
  };
}

/** Trie des groupes de TVA par taux croissant (numérique). */
export function sortVatBreakdown<T extends { rate: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => Number(a.rate) - Number(b.rate));
}

/** Calcul du panier complet : lignes, ventilation TVA, totaux (SPEC §2). */
export function computeCart(lines: readonly CartLineInput[]): CartTotals {
  const computed = lines.map(computeLine);
  const groups = new Map<string, VatBreakdownEntry>();
  let totalTtc = 0;
  let totalVat = 0;
  for (const line of computed) {
    const group = groups.get(line.vat_rate) ?? {
      rate: line.vat_rate,
      base_ht_cents: 0,
      vat_cents: 0,
      ttc_cents: 0,
    };
    group.base_ht_cents += line.line_ht_cents;
    group.vat_cents += line.line_vat_cents;
    group.ttc_cents += line.line_ttc_cents;
    groups.set(line.vat_rate, group);
    totalTtc += line.line_ttc_cents;
    totalVat += line.line_vat_cents;
  }
  return {
    lines: computed,
    vat_breakdown: sortVatBreakdown([...groups.values()]),
    total_ht_cents: totalTtc - totalVat,
    total_vat_cents: totalVat,
    total_ttc_cents: totalTtc,
  };
}

function hasNonEmptyReference(payment: PaymentInput): boolean {
  return typeof payment.reference === 'string' && payment.reference.trim().length > 0;
}

function manualFallbackReason(payment: PaymentInput): string | null {
  const response = payment.tpe_response;
  if (typeof response !== 'object' || response === null) return null;
  const reason = (response as { reason?: unknown }).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : null;
}

/**
 * Validation des paiements (SPEC §2 et §4) :
 * - `Σ amount_cents − change_cents = total_ttc_cents` sinon `PAYMENTS_MISMATCH` ;
 * - `change_cents > 0` uniquement s'il existe un paiement `cash` (`CHANGE_WITHOUT_CASH`) ;
 * - `cheque`, `gift_ucia`, `transfer` exigent une `reference` non vide (`MISSING_REFERENCE`) ;
 * - `cb` avec `manual_fallback` exige `tpe_response.reason` (`MANUAL_FALLBACK_REASON_REQUIRED`).
 */
export function validatePayments(
  totalTtcCents: number,
  payments: readonly PaymentInput[],
  changeCents: number,
): PaymentsValidation {
  if (!Number.isSafeInteger(totalTtcCents)) {
    return { ok: false, code: 'PAYMENTS_MISMATCH', message: 'total_ttc_cents must be an integer' };
  }
  if (!Number.isSafeInteger(changeCents) || changeCents < 0) {
    return { ok: false, code: 'PAYMENTS_MISMATCH', message: 'change_cents must be an integer ≥ 0' };
  }
  if (payments.length === 0) {
    return { ok: false, code: 'PAYMENTS_MISMATCH', message: 'At least one payment is required' };
  }

  let tendered = 0;
  let hasCash = false;
  for (const [index, payment] of payments.entries()) {
    if (!isPaymentMethod(payment.method)) {
      return {
        ok: false,
        code: 'PAYMENTS_MISMATCH',
        message: `payments[${index}].method is invalid: ${String(payment.method)}`,
      };
    }
    if (!Number.isSafeInteger(payment.amount_cents)) {
      return {
        ok: false,
        code: 'PAYMENTS_MISMATCH',
        message: `payments[${index}].amount_cents must be an integer`,
      };
    }
    if (PAYMENT_METHODS_REQUIRING_REFERENCE.has(payment.method) && !hasNonEmptyReference(payment)) {
      return {
        ok: false,
        code: 'MISSING_REFERENCE',
        message: `payments[${index}] (${PAYMENT_METHOD_LABELS[payment.method]}) requires a reference`,
      };
    }
    if (
      payment.method === 'cb' &&
      payment.manual_fallback === true &&
      !manualFallbackReason(payment)
    ) {
      return {
        ok: false,
        code: 'MANUAL_FALLBACK_REASON_REQUIRED',
        message: `payments[${index}] (cb, manual_fallback) requires tpe_response.reason`,
      };
    }
    if (payment.method === 'cash') hasCash = true;
    tendered += payment.amount_cents;
  }

  if (changeCents > 0 && !hasCash) {
    return {
      ok: false,
      code: 'CHANGE_WITHOUT_CASH',
      message: 'change_cents > 0 requires a cash payment',
    };
  }
  if (tendered - changeCents !== totalTtcCents) {
    return {
      ok: false,
      code: 'PAYMENTS_MISMATCH',
      message: `Σ payments (${tendered}) − change (${changeCents}) ≠ total TTC (${totalTtcCents})`,
    };
  }
  return { ok: true, tendered_cents: tendered };
}
