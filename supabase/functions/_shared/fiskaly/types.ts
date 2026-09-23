// =============================================================================
// Contrat Fiskaly SIGN FR (API 2025-08-12) — SEUL point de dépendance au format Fiskaly.
//
// Faits établis (support/doc publique) :
//   - Environnements : TEST https://test.api.fiskaly.com — LIVE https://live.api.fiskaly.com
//   - Auth : POST /auth { api_key, api_secret } → { access_token (24 h), refresh_token (48 h) }
//   - System = une caisse. État initial ACQUIRED ; doit passer COMMISSIONED avant tout Record.
//   - Record : createRecord en 2 appels (intention/start, puis données) → Record de type
//     TRANSACTION, opération RECEIPT (numéro, date, totaux HT/TTC, lignes, TVA, paiements).
//   - Clôtures J/M/A, JET et grands totaux sont produits et signés côté Fiskaly.
//
// À CONFIRMER jour 1 sur https://developer.fiskaly.com/sign-fr/2025-08-12/integration_guide
// (page inaccessible depuis l'environnement de développement) : chemins exacts, noms de champs.
// Tout ajustement se fait ICI et dans client.ts, sans impact sur le reste du code.
// =============================================================================

export const FISKALY_PATHS = {
  auth: '/api/v1/auth',
  system: (systemId: string) => `/api/v1/systems/${systemId}`,
  record: (systemId: string, recordId: string) => `/api/v1/systems/${systemId}/records/${recordId}`,
  closings: (systemId: string) => `/api/v1/systems/${systemId}/closings`,
} as const;

export type FiskalyEnv = 'test' | 'live';

export interface FiskalyRegister {
  id: string;
  code: string;
  fiskaly_system_id: string | null;
  fiskaly_env: FiskalyEnv;
  label: string | null;
}

/** Transaction telle que renvoyée par la RPC `pos_transaction_full` (sous-ensemble utile). */
export interface TransactionForSigning {
  id: string;
  ticket_number: number;
  ticket_code: string;
  kind: 'sale' | 'refund';
  business_at: string;
  register_code: string;
  hash: string;
  prev_hash: string | null;
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
  vat_breakdown: Array<{ rate: string; base_ht_cents: number; vat_cents: number; ttc_cents: number }>;
  lines: Array<{
    line_no: number;
    label: string;
    qty: number;
    unit_price_ttc_cents: number;
    vat_rate: string | number;
    discount_percent: number;
    line_ttc_cents: number;
    line_ht_cents: number;
    line_vat_cents: number;
  }>;
  payments: Array<{ method: string; amount_cents: number; reference: string | null }>;
  customer_snapshot: Record<string, unknown> | null;
}

export interface FiskalySignature {
  record_id: string;
  signature: string;
  signed_at: string;
  raw: unknown;
}

export interface FiskalyClosingRef {
  closing_id: string;
  period_type: 'daily' | 'monthly' | 'annual';
  period_start: string;
  period_end: string;
  raw: unknown;
}

export interface FiskalyClient {
  readonly mode: 'mock' | 'live';
  /** Obtient/rafraîchit le JWT. */
  auth(): Promise<void>;
  /** Crée (ou met à jour) le System de la caisse et le passe en COMMISSIONED. Renvoie l'id System. */
  commissionSystem(register: FiskalyRegister): Promise<string>;
  /** Signe une transaction (RECEIPT) : appel start + appel données. */
  createTransactionRecord(systemId: string, tx: TransactionForSigning): Promise<FiskalySignature>;
  getRecord(systemId: string, recordId: string): Promise<unknown>;
  listClosings(systemId: string, from: string, to: string): Promise<FiskalyClosingRef[]>;
}

export class FiskalyError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}
