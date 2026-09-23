// Client vers le projet Supabase `ma-papeterie` (données métier : catalogue, clients pro,
// tarifs négociés, devis, stock boutique). Utilisé UNIQUEMENT côté serveur avec la clé service
// de ma-papeterie (secret MAPAP_SERVICE_ROLE_KEY). Toutes les RPC appelées ici sont définies
// dans supabase-mapapeterie/migrations/ et réservées au service role.
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

let cached: SupabaseClient | null = null;

export function mapapClient(): SupabaseClient {
  if (cached) return cached;
  const url = Deno.env.get('MAPAP_SUPABASE_URL');
  const key = Deno.env.get('MAPAP_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('MAPAP_SUPABASE_URL / MAPAP_SERVICE_ROLE_KEY manquants');
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

export interface CustomerSnapshot {
  id: string;
  display_name: string | null;
  company_name: string | null;
  siret: string | null;
  vat_number: string | null;
  kind: string | null;
  customer_type: string | null;
  payment_terms_days: number | null;
  email: string | null;
  phone: string | null;
}

export async function fetchCustomerSnapshot(accountId: string): Promise<CustomerSnapshot | null> {
  const { data, error } = await mapapClient().rpc('pos_customer_get', { p_account_id: accountId });
  if (error) throw new Error(`pos_customer_get: ${error.message}`);
  return (data as CustomerSnapshot | null) ?? null;
}

export interface StockMovementInput {
  idempotency_key: string;
  product_id: string;
  qty_delta: number;
  transaction_ref: string;
}

export interface StockMovementResult {
  idempotency_key: string;
  applied: boolean;
  stock_after: number | null;
  went_negative?: boolean;
}

export async function applyStockMovements(movements: StockMovementInput[]): Promise<StockMovementResult[]> {
  if (movements.length === 0) return [];
  const { data, error } = await mapapClient().rpc('pos_apply_stock_movements', { p_movements: movements });
  if (error) throw new Error(`pos_apply_stock_movements: ${error.message}`);
  return (data as StockMovementResult[]) ?? [];
}
