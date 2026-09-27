/** Saisies de la page de vente : multiplicateur, quantité, remise. Fonctions pures (testées). */

const MULTIPLIER_RE = /^\s*(\d{1,4}(?:[.,]\d{1,3})?)\s*[*×]\s*(.*)$/;

/** « 3* cahier » → quantité 3 appliquée au prochain article, recherche « cahier ». */
export function parseMultiplier(input: string): { qty: number | null; term: string } {
  const m = MULTIPLIER_RE.exec(input);
  if (!m || m[1] === undefined) return { qty: null, term: input.trim() };
  const qty = Number(m[1].replace(',', '.'));
  return qty > 0 ? { qty, term: (m[2] ?? '').trim() } : { qty: null, term: input.trim() };
}

/** Quantité : entier ou décimal (3 décimales max, SPEC §1), strictement positive. */
export function parseQty(input: string): number | null {
  const t = input.trim().replace(',', '.');
  if (!/^\d{1,5}(\.\d{1,3})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/** `12`, `12,5`, `12.25` ; refuse `1e2`, `-3`, `12,345`, `> 100`. */
export function parsePercent(input: string): number | null {
  const t = input.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return n >= 0 && n <= 100 ? n : null;
}

/** Remise implicite (%) d'un prix forcé par rapport au prix de référence (public). */
export function impliedDiscountPercent(referenceCents: number, priceCents: number): number {
  if (referenceCents <= 0 || priceCents >= referenceCents) return 0;
  return Math.round((1 - priceCents / referenceCents) * 10_000) / 100;
}
