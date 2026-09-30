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

/** Résultat par ticket de `pos_record_sales` (projet ma-papeterie). */
export interface RecordSaleResult {
  transaction_id: string;
  applied: boolean;
  already_applied?: boolean;
  error?: string;
}

/**
 * Pont ventes : copie de lecture des tickets NF525 vers ma-papeterie pour le dashboard
 * (`pos_record_sales`, service role, idempotente par transaction_id). Le payload est celui de
 * `pos_sales_sync_pending` (projet Pos), transmis tel quel.
 */
export async function recordSales(sales: unknown[]): Promise<RecordSaleResult[]> {
  if (sales.length === 0) return [];
  const { data, error } = await mapapClient().rpc('pos_record_sales', { p_sales: sales });
  if (error) throw new Error(`pos_record_sales: ${error.message}`);
  return (data as RecordSaleResult[]) ?? [];
}

/** Résultat par ticket de `pos_settle_orders` (projet ma-papeterie). */
export interface SettleOrderResult {
  transaction_id: string;
  applied: boolean;
  already_applied?: boolean;
  /** Refus métier définitif : ORDER_NOT_FOUND, ACCOUNT_MISMATCH, VALIDATION. */
  error?: string;
}

/**
 * Pont commandes : marque réglées en caisse les commandes sales_orders transférées dans le panier
 * (`pos_settle_orders`, service role, idempotente par transaction_id). Payload tel que renvoyé par
 * `pos_order_settlement_pending` (projet Pos).
 */
export async function settleOrders(settlements: unknown[]): Promise<SettleOrderResult[]> {
  if (settlements.length === 0) return [];
  const { data, error } = await mapapClient().rpc('pos_settle_orders', { p_settlements: settlements });
  if (error) throw new Error(`pos_settle_orders: ${error.message}`);
  return (data as SettleOrderResult[]) ?? [];
}

export interface SetStockBoutiqueResult {
  product_id: string;
  applied: boolean;
  already_applied: boolean;
  stock_before: number;
  stock_after: number;
  delta: number;
}

/**
 * Inventaire : fixe `products.stock_boutique` au stock compté (RPC ma-papeterie
 * `pos_set_stock_boutique`, service role, idempotente par `idempotencyKey`, tracée dans
 * `pos_stock_movements` avec reason `inventory`). L'erreur PostgREST est relancée telle quelle :
 * son `message` porte le code métier (`PRODUCT_NOT_FOUND`, `VALIDATION`).
 */
export async function setStockBoutique(
  productId: string,
  counted: number,
  reason: string,
  idempotencyKey: string,
): Promise<SetStockBoutiqueResult> {
  const { data, error } = await mapapClient().rpc('pos_set_stock_boutique', {
    p_product_id: productId,
    p_counted: counted,
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return data as SetStockBoutiqueResult;
}
