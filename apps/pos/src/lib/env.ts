const meta = import.meta.env;

export const env = {
  /** Projet Supabase « Pos » : auth vendeur, tables/RPC pos_*, Edge Functions pos-*. */
  supabaseUrl: meta.VITE_SUPABASE_URL ?? '',
  supabaseAnonKey: meta.VITE_SUPABASE_ANON_KEY ?? '',
  /** Projet Supabase « ma-papeterie » : catalogue en lecture seule (clé anon publique). */
  catalogUrl: meta.VITE_CATALOG_SUPABASE_URL ?? '',
  catalogAnonKey: meta.VITE_CATALOG_SUPABASE_ANON_KEY ?? '',
  bridgeUrlDefault: meta.VITE_BRIDGE_URL || 'http://localhost:8787',
  appVersion:
    meta.VITE_APP_VERSION || (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'),
  /** Mode e2e : mocks in-memory (Supabase Pos + catalogue, Edge Functions, pont). */
  e2eMock: meta.VITE_E2E_MOCK === '1',
} as const;
