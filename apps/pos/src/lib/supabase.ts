import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';

function createRealClient(): SupabaseClient {
  const url = env.supabaseUrl || 'http://localhost:54321';
  const key = env.supabaseAnonKey || 'anon-key-missing';
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    console.warn(
      '[pos] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY manquants : client Supabase inopérant.',
    );
  }
  return createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: 'pos.auth',
    },
  });
}

async function buildClient(): Promise<SupabaseClient> {
  if (env.e2eMock) {
    const { createMockSupabase } = await import('./mocks/mockSupabase');
    return createMockSupabase();
  }
  return createRealClient();
}

/**
 * Client singleton. En mode e2e (`VITE_E2E_MOCK=1`), un mock in-memory remplace Supabase.
 * L'import dynamique du mock est résolu de façon synchrone via `top-level await` (ES2022).
 */
export const supabase: SupabaseClient = await buildClient();

/** JWT courant (pour les Edge Functions). */
export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/** Type d'erreur PostgREST/RPC minimal. */
export interface RpcError {
  message: string;
  code?: string;
  details?: string | null;
}

/** Appel RPC typé : lève une `Error` dont le message est le code métier plpgsql (SPEC §5). */
export async function rpc<T>(name: string, params?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, params);
  if (error) {
    const e = new Error((error as RpcError).message || `RPC ${name} en erreur`);
    (e as Error & { code?: string; details?: unknown }).code = (error as RpcError).code;
    (e as Error & { code?: string; details?: unknown }).details = (error as RpcError).details;
    throw e;
  }
  return data as T;
}
