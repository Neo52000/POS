import type { PaymentMethod, TransactionKind, VatBreakdownEntry } from '@pos/core';

/** Palier de prix manuel (`products.pos_price_tiers`) : prix en euros. */
export interface PriceTier {
  price: number;
  title: string;
}

/** Projection `pos_search_products` / `pos_product_by_ean`. */
export interface PosProduct {
  id: string;
  name: string;
  brand: string | null;
  ean: string | null;
  image_url: string | null;
  price_ttc_cents: number;
  price_ht_cents: number;
  vat_rate: number;
  eco_tax_cents: number;
  stock_boutique: number;
  pos_price_tiers: PriceTier[] | null;
}

export interface PosRegister {
  id: string;
  code: string;
  label: string | null;
  is_active: boolean;
}

export type SessionStatus = 'open' | 'closed';

export interface PosSession {
  id: string;
  register_id: string;
  session_number: number;
  opened_by: string | null;
  opened_at: string;
  opening_float_cents: number;
  closed_by: string | null;
  closed_at: string | null;
  counted_cash_cents: number | null;
  expected_cash_cents: number | null;
  variance_cents: number | null;
  closing_id: string | null;
  notes: string | null;
  status: SessionStatus;
}

export type SignatureStatus = 'pending_signature' | 'signed' | 'failed' | 'mock';

export interface CustomerSnapshot {
  display_name?: string;
  company_name?: string;
  siret?: string;
  vat_number?: string;
}

export interface PosTransaction {
  id: string;
  client_txn_id: string;
  register_id: string;
  session_id: string;
  ticket_number: number | null;
  kind: TransactionKind;
  refund_of_transaction_id: string | null;
  refund_reason: string | null;
  business_at: string;
  business_date: string;
  received_at: string;
  cashier_id: string | null;
  customer_account_id: string | null;
  customer_snapshot: CustomerSnapshot | null;
  quote_id: string | null;
  invoice_requested: boolean;
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
  vat_breakdown: VatBreakdownEntry[];
  tendered_cents: number;
  change_cents: number;
  offline_queued: boolean;
  provisional_ref: string | null;
  prev_hash: string | null;
  hash: string;
  signature_status: SignatureStatus;
  fiskaly_signature?: string | null;
  app_version: string | null;
}

export interface PosTransactionLine {
  id: string;
  transaction_id: string;
  line_no: number;
  product_id: string | null;
  ean: string | null;
  sku: string | null;
  label: string;
  qty: number;
  unit_price_ttc_cents: number;
  unit_price_ht_cents: number;
  vat_rate: number | string;
  discount_percent: number;
  discount_reason: string | null;
  line_ttc_cents: number;
  line_ht_cents: number;
  line_vat_cents: number;
  eco_tax_cents: number;
  pricing_rule_id: string | null;
  price_tier_title: string | null;
  public_price_ttc_cents: number | null;
}

export interface PosPayment {
  id: string;
  transaction_id: string;
  method: PaymentMethod;
  amount_cents: number;
  reference: string | null;
  tpe_response: unknown;
  manual_fallback: boolean;
  created_at: string;
}

/** Réglages `pos_settings` (clé → valeur) tels que renvoyés par `pos_transaction_full`. */
export interface PosSettingsMap {
  legal?: {
    company_name?: string;
    address_lines?: string[];
    siret?: string;
    vat_number?: string;
    phone?: string;
  };
  /** `['…']` ou `{ lines: ['…'] }` (forme stockée dans `pos_settings`). */
  ticket_footer?: string[] | { lines?: string[] };
  software?: { version?: string };
  [key: string]: unknown;
}

/** Résultat de `pos_transaction_full`. */
export interface TransactionFull {
  transaction: PosTransaction;
  lines: PosTransactionLine[];
  payments: PosPayment[];
  register: PosRegister | null;
  settings: PosSettingsMap | null;
  cashier_name: string | null;
  refund_of: { id: string; ticket_number: number | null; business_at: string } | null;
  quote_number: string | null;
}

export interface PosClosing {
  id: string;
  register_id: string;
  closing_number: number;
  period_type: 'daily' | 'monthly' | 'annual';
  period_start: string;
  period_end: string;
  session_id: string | null;
  txn_count: number;
  first_ticket_number: number | null;
  last_ticket_number: number | null;
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
  vat_breakdown: VatBreakdownEntry[];
  payments_breakdown: unknown;
  refunds_ttc_cents: number;
  grand_total_perpetual_cents: number;
  hash: string | null;
  created_at: string;
}

export interface CloseSessionResult {
  session: PosSession;
  closing: PosClosing | null;
}

/** Ligne de `pos-customer-search`. */
export interface PosCustomer {
  id: string;
  display_name: string;
  company_name: string | null;
  siret: string | null;
  vat_number: string | null;
  kind: string | null;
  customer_type: string | null;
  payment_terms_days: number | null;
  pricing_rules_count: number;
  open_quotes_count: number;
  revenue_ttc_12m: number | null;
  email: string | null;
  phone: string | null;
}

export interface CustomerQuoteItem {
  product_id: string | null;
  label: string;
  quantity: number;
  unit_price_ht: number;
  unit_price_ttc: number | null;
  discount_percent: number | null;
  vat_rate: number;
}

export interface CustomerQuote {
  id: string;
  quote_number: string;
  status: string;
  valid_until: string | null;
  total_ttc: number | null;
  items: CustomerQuoteItem[];
}

/** Ligne de `pos_resolve_cart_prices`. */
export interface ResolvedPrice {
  product_id: string;
  qty: number;
  unit_price_ht_cents: number;
  unit_price_ttc_cents: number;
  vat_rate: number;
  rule_id: string | null;
  rule_scope: string | null;
  rule_mode: 'net_price' | 'percent' | null;
  rule_value: number | null;
  public_price_ht_cents: number;
}

export type PosEventType =
  | 'login'
  | 'logout'
  | 'drawer_opened'
  | 'reprint'
  | 'line_deleted'
  | 'sale_abandoned'
  | 'manual_cb_fallback'
  | 'price_override'
  | 'line_discount'
  | 'qty_decreased'
  | 'sale_parked'
  | 'sale_recalled'
  | 'checkout_draft_abandoned'
  | 'refund'
  | 'offline_enter'
  | 'offline_exit'
  | 'offline_replay_failed'
  | 'offline_sale_abandoned';

/** `pos_client_settings()` (lot 4). */
export interface PosClientSettings {
  offline_max_txns: number;
  offline_max_hours: number;
  clock_tolerance: { online_minutes: number; offline_hours: number; future_minutes: number };
  server_now: string;
}

/** Ligne de `pos_catalog_page` (catalogue ma-papeterie, synchro hors ligne). */
export interface CatalogPageRow extends PosProduct {
  updated_at: string;
  pos_visible: boolean;
}

/** Ligne de `pos_archives` (lot 5). */
export interface PosArchive {
  id: string;
  register_id: string;
  period_start: string;
  period_end: string;
  storage_path: string;
  manifest_sha256: string;
  hash: string;
  created_at: string;
}

/** Réponse `pos-export-archive`. */
export interface ExportArchiveResult {
  archives: Array<{
    register_code: string;
    period_start: string;
    period_end: string;
    storage_path: string;
    manifest_sha256: string;
    hash: string;
    already_exists: boolean;
    counts: { transactions: number; events: number; closings: number };
  }>;
}

/** Entrée `pos-stock-adjust` (lot 6). */
export interface StockAdjustItem {
  product_id: string;
  counted: number;
  idempotency_key: string;
  label?: string;
}

export interface StockAdjustInput {
  items: StockAdjustItem[];
  reason: string;
  register_id?: string;
}

export interface StockAdjustLineResult {
  product_id: string;
  applied: boolean;
  already_applied: boolean;
  stock_before: number;
  stock_after: number;
  delta: number;
  error?: string;
}

export interface StockAdjustResult {
  results: StockAdjustLineResult[];
}
