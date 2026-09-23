import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import type { PosProduct } from '@/types/pos';

/**
 * Client du projet « ma-papeterie » (catalogue, lecture seule, clé anon publique).
 * Sert UNIQUEMENT aux RPC `pos_search_products` et `pos_product_by_ean`. Aucune auth.
 */
function createRealCatalog(): SupabaseClient {
  if (!env.catalogUrl || !env.catalogAnonKey) {
    console.warn(
      '[pos] VITE_CATALOG_SUPABASE_URL / VITE_CATALOG_SUPABASE_ANON_KEY manquants : catalogue inopérant.',
    );
  }
  return createClient(
    env.catalogUrl || 'http://localhost:54322',
    env.catalogAnonKey || 'anon-key-missing',
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
}

async function buildCatalog(): Promise<SupabaseClient> {
  if (env.e2eMock) {
    const { createMockCatalog } = await import('./mocks/mockCatalog');
    return createMockCatalog();
  }
  return createRealCatalog();
}

export const catalog: SupabaseClient = await buildCatalog();

async function catalogRpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await catalog.rpc(name, params);
  if (error) throw new Error(error.message || `RPC catalogue ${name} en erreur`);
  return data as T;
}

export async function searchProducts(query: string, limit: number): Promise<PosProduct[]> {
  const rows = await catalogRpc<PosProduct[] | null>('pos_search_products', {
    p_query: query,
    p_limit: limit,
  });
  return rows ?? [];
}

export async function productByEan(ean: string): Promise<PosProduct | null> {
  const rows = await catalogRpc<PosProduct[] | PosProduct | null>('pos_product_by_ean', {
    p_ean: ean,
  });
  if (!rows) return null;
  return Array.isArray(rows) ? (rows[0] ?? null) : rows;
}
