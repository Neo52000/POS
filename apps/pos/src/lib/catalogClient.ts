import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

/**
 * Client du projet « ma-papeterie » (catalogue, lecture seule, clé anon publique).
 * Sert UNIQUEMENT aux RPC `pos_search_products`, `pos_product_by_ean` et `pos_catalog_page`.
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

/** Appel RPC catalogue : lève une `Error` (message PostgREST, ou message `fetch` si réseau). */
export async function catalogRpc<T>(name: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await catalog.rpc(name, params);
  if (error) throw new Error(error.message || `RPC catalogue ${name} en erreur`);
  return data as T;
}
