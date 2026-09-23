/**
 * Arrondi « half away from zero » : `Math.round` sur la valeur absolue puis réapplication du signe
 * (SPEC §2). 0,5 → 1 ; −0,5 → −1 ; 2,5 → 3 ; −2,5 → −3.
 */
export function roundHalfAwayFromZero(n: number): number {
  if (!Number.isFinite(n)) {
    throw new RangeError(`roundHalfAwayFromZero: value must be finite, got ${String(n)}`);
  }
  const rounded = Math.round(Math.abs(n));
  if (rounded === 0) return 0;
  return n < 0 ? -rounded : rounded;
}

/**
 * Formate un montant en centimes en euros selon la locale (`fr-FR` par défaut) : `1 234,56 €`.
 * Les espaces (fine insécable pour les milliers, insécable avant le symbole) sont ceux produits
 * par `Intl.NumberFormat`.
 */
export function formatEurCents(cents: number, locale = 'fr-FR'): string {
  if (!Number.isFinite(cents)) {
    throw new RangeError(`formatEurCents: value must be finite, got ${String(cents)}`);
  }
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return formatter.format(cents / 100);
}

const EURO_INPUT_RE = /^([+-]?)(\d+)(?:[.,](\d{1,2}))?$/;

/**
 * Convertit une saisie utilisateur en centimes : `12,50`, `12.50`, `12`, `1 234,5 €` → entier.
 * Retourne `null` si la saisie est invalide (plus de 2 décimales, caractères inattendus, vide).
 */
export function parseEuroToCents(input: string): number | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\s\u00a0\u202f]/g, '').replace(/€/g, '');
  const match = EURO_INPUT_RE.exec(cleaned);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const whole = Number(match[2]);
  const fraction = Number((match[3] ?? '').padEnd(2, '0'));
  const cents = sign * (whole * 100 + fraction);
  if (!Number.isSafeInteger(cents)) return null;
  return cents === 0 ? 0 : cents;
}
