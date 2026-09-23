import { sortVatBreakdown } from './cart.js';
import type { VatBreakdownEntry } from './cart.js';
import { sha256Hex, sha256HexAsync } from './sha256.js';
import { normalizeVatRate } from './vat.js';

export const HASH_VERSION = 'v1';

/** Ligne telle qu'entrant dans `lines_digest` (SPEC §3). `ComputedLine` est compatible. */
export interface CanonicalLine {
  line_no: number;
  product_id?: string | null;
  ean?: string | null;
  label: string;
  qty: number;
  unit_price_ttc_cents: number;
  vat_rate: number | string;
  discount_percent: number;
  line_ttc_cents: number;
}

/** Paiement tel qu'entrant dans `payments_digest` (SPEC §3). `PaymentInput` est compatible. */
export interface CanonicalPayment {
  method: string;
  amount_cents: number;
  reference?: string | null;
}

export interface CanonicalTxnInput {
  ticket_number: number;
  register_code: string;
  client_txn_id: string;
  /** ISO 8601 ; normalisé en UTC avec millisecondes (`toISOString`). */
  business_at: string;
  kind: 'sale' | 'refund';
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
  vat_breakdown: readonly VatBreakdownEntry[];
  customer_account_id?: string | null;
  lines: readonly CanonicalLine[];
  payments: readonly CanonicalPayment[];
  /** `''` / `null` / absent pour le premier ticket d'une caisse. */
  prev_hash?: string | null;
}

export interface ChainedTxn extends CanonicalTxnInput {
  hash: string;
}

export type ChainBreakReason = 'HASH_MISMATCH' | 'PREV_HASH_MISMATCH' | 'TICKET_GAP';

export interface ChainBreak {
  ticket_number: number;
  expected: string;
  actual: string;
  reason: ChainBreakReason;
}

export type ChainVerification = { ok: true } | { ok: false; first_break: ChainBreak };

/** Quantité canonique : nombre sans zéros inutiles (`1`, `2.5`, `-1`, `0.125`), 3 décimales max. */
export function canonicalQty(qty: number): string {
  if (!Number.isFinite(qty)) throw new RangeError(`qty must be finite, got ${String(qty)}`);
  const milli = Math.round(qty * 1000);
  if (milli === 0) return '0';
  const sign = milli < 0 ? '-' : '';
  const abs = Math.abs(milli);
  const whole = Math.floor(abs / 1000);
  const frac = String(abs % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${sign}${whole}${frac ? `.${frac}` : ''}`;
}

/** Remise canonique à 2 décimales : `0` → `0.00`, `10` → `10.00`, `12.5` → `12.50`. */
export function canonicalDiscount(discount: number): string {
  if (!Number.isFinite(discount)) {
    throw new RangeError(`discount_percent must be finite, got ${String(discount)}`);
  }
  const bp = Math.round(discount * 100);
  const sign = bp < 0 ? '-' : '';
  const abs = Math.abs(bp);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Date canonique : ISO 8601 UTC avec millisecondes (`2026-09-23T14:05:07.123Z`). */
export function canonicalIsoDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid date: ${String(value)}`);
  }
  return date.toISOString();
}

/** `rate:base_ht:vat:ttc` par groupe, triés par taux croissant, joints par `;`. */
export function canonicalVatBreakdown(entries: readonly VatBreakdownEntry[]): string {
  return sortVatBreakdown(
    entries.map((e) => ({
      rate: normalizeVatRate(e.rate),
      base_ht_cents: e.base_ht_cents,
      vat_cents: e.vat_cents,
      ttc_cents: e.ttc_cents,
    })),
  )
    .map((e) => `${e.rate}:${e.base_ht_cents}:${e.vat_cents}:${e.ttc_cents}`)
    .join(';');
}

function nullable(value: string | null | undefined): string {
  return value ?? '';
}

/** Texte concaténé (avant hachage) des lignes triées par `line_no`, séparées par `\n`. */
export function linesCanonicalText(lines: readonly CanonicalLine[]): string {
  return [...lines]
    .sort((a, b) => a.line_no - b.line_no)
    .map((l) =>
      [
        String(l.line_no),
        nullable(l.product_id),
        nullable(l.ean),
        l.label,
        canonicalQty(l.qty),
        String(l.unit_price_ttc_cents),
        normalizeVatRate(l.vat_rate),
        canonicalDiscount(l.discount_percent),
        String(l.line_ttc_cents),
      ].join('|'),
    )
    .join('\n');
}

function comparePayments(a: CanonicalPayment, b: CanonicalPayment): number {
  if (a.method !== b.method) return a.method < b.method ? -1 : 1;
  if (a.amount_cents !== b.amount_cents) return a.amount_cents - b.amount_cents;
  const ra = nullable(a.reference);
  const rb = nullable(b.reference);
  if (ra === rb) return 0;
  return ra < rb ? -1 : 1;
}

/** Texte concaténé (avant hachage) des paiements triés par (method, amount_cents, reference). */
export function paymentsCanonicalText(payments: readonly CanonicalPayment[]): string {
  return [...payments]
    .sort(comparePayments)
    .map((p) => `${p.method}|${p.amount_cents}|${nullable(p.reference)}`)
    .join('\n');
}

export function linesDigest(lines: readonly CanonicalLine[]): string {
  return sha256Hex(linesCanonicalText(lines));
}

export function linesDigestAsync(lines: readonly CanonicalLine[]): Promise<string> {
  return sha256HexAsync(linesCanonicalText(lines));
}

export function paymentsDigest(payments: readonly CanonicalPayment[]): string {
  return sha256Hex(paymentsCanonicalText(payments));
}

export function paymentsDigestAsync(payments: readonly CanonicalPayment[]): Promise<string> {
  return sha256HexAsync(paymentsCanonicalText(payments));
}

function assembleCanonicalString(
  input: CanonicalTxnInput,
  linesDigestHex: string,
  paymentsDigestHex: string,
): string {
  if (!Number.isSafeInteger(input.ticket_number)) {
    throw new RangeError(`ticket_number must be an integer, got ${String(input.ticket_number)}`);
  }
  return [
    HASH_VERSION,
    String(input.ticket_number),
    input.register_code,
    input.client_txn_id,
    canonicalIsoDate(input.business_at),
    input.kind,
    String(input.total_ht_cents),
    String(input.total_vat_cents),
    String(input.total_ttc_cents),
    canonicalVatBreakdown(input.vat_breakdown),
    nullable(input.customer_account_id),
    linesDigestHex,
    paymentsDigestHex,
    nullable(input.prev_hash),
  ].join('|');
}

/** Chaîne canonique v1 (SPEC §3), avant SHA-256. */
export function buildCanonicalString(input: CanonicalTxnInput): string {
  return assembleCanonicalString(input, linesDigest(input.lines), paymentsDigest(input.payments));
}

export async function buildCanonicalStringAsync(input: CanonicalTxnInput): Promise<string> {
  const [lines, payments] = await Promise.all([
    linesDigestAsync(input.lines),
    paymentsDigestAsync(input.payments),
  ]);
  return assembleCanonicalString(input, lines, payments);
}

/** `hash = SHA-256 hex minuscules` de la chaîne canonique (SPEC §3). */
export function computeTransactionHash(input: CanonicalTxnInput): string {
  return sha256Hex(buildCanonicalString(input));
}

export async function computeTransactionHashAsync(input: CanonicalTxnInput): Promise<string> {
  return sha256HexAsync(await buildCanonicalStringAsync(input));
}

/**
 * Vérifie une chaîne de transactions (triées par `ticket_number`) :
 * - chaque `hash` est recalculable depuis ses champs ;
 * - `prev_hash` de n+1 = `hash` de n ;
 * - les `ticket_number` sont consécutifs.
 * Le `prev_hash` du premier élément n'est vérifié que par sa contribution au hash.
 */
export function verifyChain(transactions: readonly ChainedTxn[]): ChainVerification {
  const ordered = [...transactions].sort((a, b) => a.ticket_number - b.ticket_number);
  let previous: ChainedTxn | undefined;
  for (const txn of ordered) {
    const expected = computeTransactionHash(txn);
    const actual = txn.hash.toLowerCase();
    if (expected !== actual) {
      return {
        ok: false,
        first_break: {
          ticket_number: txn.ticket_number,
          expected,
          actual,
          reason: 'HASH_MISMATCH',
        },
      };
    }
    if (previous) {
      const expectedTicket = previous.ticket_number + 1;
      if (txn.ticket_number !== expectedTicket) {
        return {
          ok: false,
          first_break: {
            ticket_number: txn.ticket_number,
            expected: String(expectedTicket),
            actual: String(txn.ticket_number),
            reason: 'TICKET_GAP',
          },
        };
      }
      const prevHash = nullable(txn.prev_hash).toLowerCase();
      if (prevHash !== previous.hash.toLowerCase()) {
        return {
          ok: false,
          first_break: {
            ticket_number: txn.ticket_number,
            expected: previous.hash.toLowerCase(),
            actual: prevHash,
            reason: 'PREV_HASH_MISMATCH',
          },
        };
      }
    }
    previous = txn;
  }
  return { ok: true };
}
