import { isNetworkFailure } from '@/lib/apiError';
import { catalogRpc } from '@/lib/catalogClient';
import { isOffline } from '@/lib/connectivity';
import { productByEanLocal, searchLocal } from '@/lib/offlineCatalog';
import type { PosProduct } from '@/types/pos';

export { catalog } from '@/lib/catalogClient';

/**
 * Recherche produits : RPC catalogue en ligne ; catalogue local (Dexie) hors ligne ou si la RPC
 * échoue pour une raison réseau. Le catalogue ma-papeterie est un autre projet que « Pos » : son
 * indisponibilité ne fait pas basculer la caisse hors ligne.
 */
export async function searchProducts(query: string, limit: number): Promise<PosProduct[]> {
  if (isOffline()) return searchLocal(query, limit);
  try {
    const rows = await catalogRpc<PosProduct[] | null>('pos_search_products', {
      p_query: query,
      p_limit: limit,
    });
    return rows ?? [];
  } catch (e) {
    if (isNetworkFailure(e)) return searchLocal(query, limit);
    throw e;
  }
}

export async function productByEan(ean: string): Promise<PosProduct | null> {
  if (isOffline()) return productByEanLocal(ean);
  try {
    const rows = await catalogRpc<PosProduct[] | PosProduct | null>('pos_product_by_ean', {
      p_ean: ean,
    });
    if (!rows) return null;
    return Array.isArray(rows) ? (rows[0] ?? null) : rows;
  } catch (e) {
    if (isNetworkFailure(e)) return productByEanLocal(ean);
    throw e;
  }
}
