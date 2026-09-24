import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogPageRow, PosProduct } from '@/types/pos';
import { MOCK_PRODUCTS } from './mockData';
import { isMockOffline } from './mockNetwork';
import { mockState } from './mockStore';

/** `updated_at` fixe des produits mock (les modifications d'inventaire le rafraîchissent). */
const MOCK_UPDATED_AT = '2026-09-01T08:00:00.000Z';

/** Produits mock avec le stock éventuellement modifié par l'inventaire. */
export function mockProducts(): PosProduct[] {
  const stock = mockState().stock;
  return MOCK_PRODUCTS.map((p) =>
    p.id in stock ? { ...p, stock_boutique: stock[p.id] ?? p.stock_boutique } : p,
  );
}

function catalogRows(): CatalogPageRow[] {
  const stock = mockState().stock;
  return mockProducts().map((p) => ({
    ...p,
    updated_at: p.id in stock ? new Date().toISOString() : MOCK_UPDATED_AT,
    pos_visible: true,
  }));
}

/** Mock du projet catalogue : `pos_search_products`, `pos_product_by_ean`, `pos_catalog_page`. */
export function createMockCatalog(): SupabaseClient {
  const rpc = async (name: string, params: Record<string, unknown> = {}) => {
    // Comme supabase-js : l'échec réseau est renvoyé dans `error` (message du `fetch`).
    if (isMockOffline()) {
      return { data: null, error: { message: 'TypeError: Failed to fetch (mock hors ligne)' } };
    }
    switch (name) {
      case 'pos_search_products': {
        const q = String(params['p_query'] ?? '')
          .trim()
          .toLowerCase();
        const limit = Number(params['p_limit'] ?? 20);
        const rows = mockProducts().filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.brand ?? '').toLowerCase().includes(q) ||
            p.ean === q,
        );
        return { data: rows.slice(0, limit), error: null };
      }
      case 'pos_product_by_ean': {
        const ean = String(params['p_ean'] ?? '');
        return { data: mockProducts().filter((p) => p.ean === ean), error: null };
      }
      case 'pos_catalog_page': {
        const after = params['p_after_id'] ? String(params['p_after_id']) : null;
        const limit = Math.min(10_000, Number(params['p_limit'] ?? 5000));
        const since = params['p_since'] ? String(params['p_since']) : null;
        const rows = catalogRows()
          .filter((r) => (after ? r.id > after : true))
          .filter((r) => (since ? r.updated_at > since : r.pos_visible))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .slice(0, limit);
        return { data: rows, error: null };
      }
      default:
        return { data: null, error: { message: `RPC catalogue mock inconnue : ${name}` } };
    }
  };
  return { rpc } as unknown as SupabaseClient;
}
