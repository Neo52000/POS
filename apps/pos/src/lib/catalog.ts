import { z } from 'zod';
import { isVatRateFr } from '@pos/core';
import { isNetworkFailure } from '@/lib/apiError';
import { catalogRpc } from '@/lib/catalogClient';
import { isOffline } from '@/lib/connectivity';
import { productByEanLocal, searchLocal } from '@/lib/offlineCatalog';
import type { PosProduct } from '@/types/pos';

export { catalog } from '@/lib/catalogClient';

/** Nombre ou chaîne numérique non vide : `null`, `''` ou un booléen ne valent jamais 0. */
const numeric = z.union([z.number(), z.string().trim().min(1)]).pipe(z.coerce.number().finite());

const cents = numeric.transform((n) => Math.round(n)).pipe(z.number().int().nonnegative());

/** Ligne produit reçue du catalogue : prix entiers en centimes, TVA française valide. */
const PosProductSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  brand: z.string().nullable().catch(null),
  ean: z.string().nullable().catch(null),
  image_url: z.string().nullable().catch(null),
  price_ttc_cents: cents,
  price_ht_cents: cents.catch(0),
  vat_rate: numeric.refine((r) => isVatRateFr(r), 'taux de TVA inconnu'),
  eco_tax_cents: cents
    .nullable()
    .transform((n) => n ?? 0)
    .catch(0),
  stock_boutique: numeric.catch(0),
  pos_price_tiers: z
    .array(z.object({ price: numeric.pipe(z.number().nonnegative()), title: z.string() }))
    .nullable()
    .catch(null),
});

/**
 * Valide les produits du catalogue : une ligne invalide (prix non entier, TVA inconnue…) est
 * écartée plutôt que de faire planter le calcul du panier.
 */
export function sanitizeProducts(rows: unknown[]): PosProduct[] {
  const out: PosProduct[] = [];
  for (const row of rows) {
    const r = PosProductSchema.safeParse(row);
    if (r.success) out.push(r.data);
    else console.warn('[catalog] produit ignoré', (row as { id?: unknown })?.id, r.error.issues);
  }
  return out;
}

/**
 * Recherche produits : RPC catalogue en ligne ; catalogue local (Dexie) hors ligne ou si la RPC
 * échoue pour une raison réseau. Le catalogue ma-papeterie est un autre projet que « Pos » : son
 * indisponibilité ne fait pas basculer la caisse hors ligne.
 */
export async function searchProducts(query: string, limit: number): Promise<PosProduct[]> {
  if (isOffline()) return searchLocal(query, limit);
  try {
    const rows = await catalogRpc<unknown[] | null>('pos_search_products', {
      p_query: query,
      p_limit: limit,
    });
    return sanitizeProducts(rows ?? []);
  } catch (e) {
    if (isNetworkFailure(e)) return searchLocal(query, limit);
    throw e;
  }
}

export async function productByEan(ean: string): Promise<PosProduct | null> {
  if (isOffline()) return productByEanLocal(ean);
  try {
    const rows = await catalogRpc<unknown[] | unknown | null>('pos_product_by_ean', {
      p_ean: ean,
    });
    if (!rows) return null;
    return sanitizeProducts(Array.isArray(rows) ? rows.slice(0, 1) : [rows])[0] ?? null;
  } catch (e) {
    if (isNetworkFailure(e)) return productByEanLocal(ean);
    throw e;
  }
}
