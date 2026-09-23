import type { SupabaseClient } from '@supabase/supabase-js';
import { MOCK_PRODUCTS } from './mockData';

/** Mock du projet catalogue : uniquement `pos_search_products` et `pos_product_by_ean`. */
export function createMockCatalog(): SupabaseClient {
  const rpc = async (name: string, params: Record<string, unknown> = {}) => {
    switch (name) {
      case 'pos_search_products': {
        const q = String(params['p_query'] ?? '')
          .trim()
          .toLowerCase();
        const limit = Number(params['p_limit'] ?? 20);
        const rows = MOCK_PRODUCTS.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.brand ?? '').toLowerCase().includes(q) ||
            p.ean === q,
        );
        return { data: rows.slice(0, limit), error: null };
      }
      case 'pos_product_by_ean': {
        const ean = String(params['p_ean'] ?? '');
        return { data: MOCK_PRODUCTS.filter((p) => p.ean === ean), error: null };
      }
      default:
        return { data: null, error: { message: `RPC catalogue mock inconnue : ${name}` } };
    }
  };
  return { rpc } as unknown as SupabaseClient;
}
