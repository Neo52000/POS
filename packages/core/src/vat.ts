import { roundHalfAwayFromZero } from './money.js';

/** Taux de TVA français, forme canonique à 2 décimales (SPEC §1). */
export const VAT_RATES_FR = ['20.00', '10.00', '5.50', '2.10', '0.00'] as const;
export type VatRateFr = (typeof VAT_RATES_FR)[number];

const RATE_STRING_RE = /^\+?\d+(?:\.\d+)?$/;

/**
 * Convertit un taux (`20`, `"20"`, `"20.0"`, `5.5`, `"5,5"`, `"20 %"`) en points de base (`2000`).
 * @throws RangeError si le taux est invalide (non fini, < 0, > 100, plus de 2 décimales).
 */
export function vatRateToBasisPoints(rate: number | string): number {
  let value: number;
  if (typeof rate === 'number') {
    value = rate;
  } else if (typeof rate === 'string') {
    const cleaned = rate.trim().replace(/\s*%$/, '').replace(',', '.');
    if (!RATE_STRING_RE.test(cleaned)) {
      throw new RangeError(`Invalid VAT rate: "${rate}"`);
    }
    value = Number(cleaned);
  } else {
    throw new RangeError(`Invalid VAT rate: ${String(rate)}`);
  }
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`Invalid VAT rate: ${String(rate)}`);
  }
  const bp = Math.round(value * 100);
  if (Math.abs(value * 100 - bp) > 1e-6) {
    throw new RangeError(`VAT rate must have at most 2 decimals: ${String(rate)}`);
  }
  return bp;
}

/** Normalise un taux en chaîne canonique à 2 décimales : `20` → `"20.00"`, `"5.5"` → `"5.50"`. */
export function normalizeVatRate(rate: number | string): string {
  const bp = vatRateToBasisPoints(rate);
  const whole = Math.floor(bp / 100);
  const decimals = bp % 100;
  return `${whole}.${String(decimals).padStart(2, '0')}`;
}

/** `true` si le taux (après normalisation) fait partie des taux français connus. */
export function isVatRateFr(rate: number | string): rate is VatRateFr {
  try {
    return (VAT_RATES_FR as readonly string[]).includes(normalizeVatRate(rate));
  } catch {
    return false;
  }
}

/** TTC → HT en centimes : `round(ttc × 10000 / (10000 + rate_bp))` (SPEC §2). */
export function ttcToHtCents(ttcCents: number, rate: number | string): number {
  const bp = vatRateToBasisPoints(rate);
  return roundHalfAwayFromZero((ttcCents * 10000) / (10000 + bp));
}

/** HT → TTC en centimes : `round(ht × (10000 + rate_bp) / 10000)`. */
export function htToTtcCents(htCents: number, rate: number | string): number {
  const bp = vatRateToBasisPoints(rate);
  return roundHalfAwayFromZero((htCents * (10000 + bp)) / 10000);
}
