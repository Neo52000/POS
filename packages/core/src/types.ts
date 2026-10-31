import type { CartLineInput, PaymentInput, PaymentMethod } from './cart.js';
import { PAYMENT_METHODS_REQUIRING_REFERENCE, isPaymentMethod } from './cart.js';
import type { TicketPayload, TransactionKind } from './ticket.js';
import { vatRateToBasisPoints } from './vat.js';

export interface CheckoutTotals {
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
}

export type CheckoutPayment = PaymentInput;

/** SPEC §4 — PWA → `pos-checkout` → `pos_finalize_sale`. */
export interface CheckoutPayload {
  client_txn_id: string;
  register_id: string;
  session_id: string;
  kind: TransactionKind;
  refund_of_transaction_id?: string;
  refund_reason?: string;
  business_at: string;
  offline_queued: boolean;
  provisional_ref?: string;
  /**
   * Paiement CB déjà capté par le TPE, enregistrement retardé par une coupure réseau : le serveur
   * applique la fenêtre hors ligne (y compris pour un remboursement). Exige une CB non manuelle.
   */
  deferred_capture?: boolean;
  customer_account_id?: string;
  quote_id?: string;
  /**
   * Commande ma-papeterie (`sales_orders.id`) transférée dans le panier. Hors périmètre fiscal :
   * retirée du payload avant `pos_finalize_sale`, sert à marquer la commande réglée.
   */
  order_id?: string;
  /**
   * Personne de passage ma-papeterie (`passage_contacts.id`) : nom + téléphone, sans dossier
   * client. Hors périmètre fiscal comme `order_id` (retiré avant `pos_finalize_sale`, outbox).
   * `customer_account_id` porte alors la fiche « Client passage ».
   */
  passage_contact_id?: string;
  /** Nom de la personne de passage, imprimé sur le ticket (snapshot client, non haché). */
  passage_contact_name?: string;
  /**
   * Lignes de commandes / BL ma-papeterie réglées par ce ticket (`pos_settle_documents`). Hors
   * périmètre fiscal comme `order_id` : retirées du payload avant `pos_finalize_sale`, outbox.
   * Ventes uniquement ; exige `customer_account_id`.
   */
  settlement_lines?: SettlementLine[];
  /**
   * Chaînage local de la file hors ligne (0.4.0) : SHA-256 de l'élément précédent de la file
   * (`''` pour le premier) et de l'élément lui-même (`offlineChainHash`). Tracé au JET de la vente,
   * jamais dans le hash ticket v1.
   */
  offline_chain_prev?: string;
  offline_chain_hash?: string;
  invoice_requested: boolean;
  lines: CartLineInput[];
  payments: CheckoutPayment[];
  change_cents: number;
  totals: CheckoutTotals;
  app_version: string;
}

/** Ligne de commande (ou de BL) ma-papeterie réglée par un ticket, quantité ≤ reste ouvert. */
export interface SettlementLine {
  sales_order_line_id: string;
  /** Ligne de bon de livraison réglée ; absente pour la partie non livrée d'une commande. */
  delivery_note_line_id?: string | null;
  qty: number;
}

/** SPEC §5 — réponse de `pos-checkout`. Les types de lignes DB sont fournis par le consommateur. */
export interface CheckoutResult<TTransaction = unknown, TLine = unknown, TPayment = unknown> {
  transaction: TTransaction;
  lines: TLine[];
  payments: TPayment[];
  ticket: TicketPayload;
  idempotent_replay: boolean;
}

export const CHECKOUT_ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN_ROLE',
  'VALIDATION',
  'SESSION_NOT_OPEN',
  /** Session ouverte avant le jour courant (Europe/Paris) : Z1 de la veille obligatoire (0.4.0). */
  'SESSION_STALE',
  'TOTALS_MISMATCH',
  'PAYMENTS_MISMATCH',
  'REFUND_EXCEEDS_SOLD',
  'REFUND_TARGET_NOT_FOUND',
  'QUOTE_NOT_FOUND',
  'REGISTER_NOT_FOUND',
  'BUSINESS_AT_OUT_OF_RANGE',
  'CHAIN_INCONSISTENT',
  'DB_ERROR',
  'FISKALY_ERROR',
] as const;
export type CheckoutErrorCode = (typeof CHECKOUT_ERROR_CODES)[number];

export interface CheckoutErrorBody {
  error: { code: CheckoutErrorCode; message: string; details?: unknown };
}

export type CheckoutValidation =
  { ok: true; value: CheckoutPayload } | { ok: false; errors: string[] };

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_RE.test(value);
}

export function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_DATE_RE.test(value) && !Number.isNaN(Date.parse(value));
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasDecimals(value: number, maxDecimals: number): boolean {
  const scale = 10 ** maxDecimals;
  return Math.abs(value * scale - Math.round(value * scale)) < 1e-6;
}

class Collector {
  readonly errors: string[] = [];

  fail(path: string, message: string): false {
    this.errors.push(`${path}: ${message}`);
    return false;
  }

  uuid(obj: Rec, key: string, path: string, required: boolean): void {
    const value = obj[key];
    if (value === undefined || value === null) {
      if (required) this.fail(`${path}.${key}`, 'is required (uuid v4)');
      return;
    }
    if (!isUuidV4(value)) this.fail(`${path}.${key}`, 'must be a uuid v4');
  }

  string(obj: Rec, key: string, path: string, required: boolean, nonEmpty = true): void {
    const value = obj[key];
    if (value === undefined || value === null) {
      if (required) this.fail(`${path}.${key}`, 'is required (string)');
      return;
    }
    if (typeof value !== 'string') {
      this.fail(`${path}.${key}`, 'must be a string');
      return;
    }
    if (nonEmpty && value.trim().length === 0) this.fail(`${path}.${key}`, 'must not be empty');
  }

  boolean(obj: Rec, key: string, path: string, required: boolean): void {
    const value = obj[key];
    if (value === undefined || value === null) {
      if (required) this.fail(`${path}.${key}`, 'is required (boolean)');
      return;
    }
    if (typeof value !== 'boolean') this.fail(`${path}.${key}`, 'must be a boolean');
  }

  integer(
    obj: Rec,
    key: string,
    path: string,
    required: boolean,
    opts: { min?: number } = {},
  ): void {
    const value = obj[key];
    if (value === undefined || value === null) {
      if (required) this.fail(`${path}.${key}`, 'is required (integer)');
      return;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      this.fail(`${path}.${key}`, 'must be an integer');
      return;
    }
    if (opts.min !== undefined && value < opts.min) {
      this.fail(`${path}.${key}`, `must be ≥ ${opts.min}`);
    }
  }
}

function validateLine(c: Collector, line: unknown, path: string, kind: TransactionKind): void {
  if (!isRecord(line)) {
    c.fail(path, 'must be an object');
    return;
  }
  c.integer(line, 'line_no', path, true, { min: 1 });
  c.uuid(line, 'product_id', path, false);
  c.string(line, 'ean', path, false, false);
  c.string(line, 'sku', path, false, false);
  c.string(line, 'label', path, true);

  const qty = line['qty'];
  if (typeof qty !== 'number' || !Number.isFinite(qty)) {
    c.fail(`${path}.qty`, 'must be a finite number');
  } else if (!hasDecimals(qty, 3)) {
    c.fail(`${path}.qty`, 'must have at most 3 decimals');
  } else if (qty === 0) {
    c.fail(`${path}.qty`, 'must not be 0');
  } else if (kind === 'sale' && qty < 0) {
    c.fail(`${path}.qty`, 'must be > 0 on a sale');
  } else if (kind === 'refund' && qty > 0) {
    c.fail(`${path}.qty`, 'must be < 0 on a refund');
  }

  c.integer(line, 'unit_price_ttc_cents', path, true, { min: 0 });

  const vatRate = line['vat_rate'];
  if (typeof vatRate !== 'number' && typeof vatRate !== 'string') {
    c.fail(`${path}.vat_rate`, 'is required (number or string)');
  } else {
    try {
      vatRateToBasisPoints(vatRate);
    } catch {
      c.fail(`${path}.vat_rate`, `is not a valid VAT rate: ${String(vatRate)}`);
    }
  }

  const discount = line['discount_percent'];
  if (discount !== undefined && discount !== null) {
    if (typeof discount !== 'number' || !Number.isFinite(discount)) {
      c.fail(`${path}.discount_percent`, 'must be a number');
    } else if (discount < 0 || discount > 100) {
      c.fail(`${path}.discount_percent`, 'must be between 0 and 100');
    } else if (!hasDecimals(discount, 2)) {
      c.fail(`${path}.discount_percent`, 'must have at most 2 decimals');
    }
  }

  c.integer(line, 'eco_tax_cents', path, false, { min: 0 });
  c.uuid(line, 'pricing_rule_id', path, false);
  c.string(line, 'price_tier_title', path, false, false);
  c.integer(line, 'public_price_ttc_cents', path, false, { min: 0 });
}

function validatePayment(c: Collector, payment: unknown, path: string): void {
  if (!isRecord(payment)) {
    c.fail(path, 'must be an object');
    return;
  }
  const method = payment['method'];
  if (!isPaymentMethod(method)) {
    c.fail(`${path}.method`, `must be one of cb, cash, cheque, gift_ucia, transfer`);
    return;
  }
  c.integer(payment, 'amount_cents', path, true);
  c.string(payment, 'reference', path, false, false);
  c.boolean(payment, 'manual_fallback', path, false);

  if (PAYMENT_METHODS_REQUIRING_REFERENCE.has(method as PaymentMethod)) {
    if (!isNonEmptyString(payment['reference'])) {
      c.fail(`${path}.reference`, `is required for method ${method}`);
    }
  }
  if (method === 'cb' && payment['manual_fallback'] === true) {
    const response = payment['tpe_response'];
    const reason = isRecord(response) ? response['reason'] : undefined;
    if (!isNonEmptyString(reason)) {
      c.fail(`${path}.tpe_response.reason`, 'is required when manual_fallback is true');
    }
  }
}

const MAX_SETTLEMENT_LINES = 500;

function validateSettlementLines(
  c: Collector,
  p: Record<string, unknown>,
  root: string,
  kind: unknown,
): void {
  const sl = p['settlement_lines'];
  if (sl === undefined) return;
  const path = `${root}.settlement_lines`;
  if (!Array.isArray(sl) || sl.length === 0 || sl.length > MAX_SETTLEMENT_LINES) {
    c.fail(path, `must be a non-empty array (max ${MAX_SETTLEMENT_LINES})`);
    return;
  }
  if (kind !== 'sale') c.fail(path, 'is only allowed on a sale');
  if (p['customer_account_id'] === undefined) c.fail(path, 'requires customer_account_id');
  const seen = new Set<string>();
  sl.forEach((line, i) => {
    const lp = `${path}[${i}]`;
    if (!isRecord(line)) {
      c.fail(lp, 'must be an object');
      return;
    }
    c.uuid(line, 'sales_order_line_id', lp, true);
    if (line['delivery_note_line_id'] !== null) c.uuid(line, 'delivery_note_line_id', lp, false);
    const qty = line['qty'];
    if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0 || !hasDecimals(qty, 3)) {
      c.fail(`${lp}.qty`, 'must be a number > 0 with at most 3 decimals');
    }
    const key = `${String(line['sales_order_line_id'])}/${String(line['delivery_note_line_id'] ?? '')}`;
    if (seen.has(key)) c.fail(lp, 'duplicate sales_order_line_id / delivery_note_line_id');
    seen.add(key);
  });
}

/**
 * Validation structurelle d'un `CheckoutPayload` (SPEC §4), sans dépendance externe.
 * La cohérence des montants (`Σ paiements − rendu = total`) est vérifiée par `validatePayments()`
 * et par le serveur (`TOTALS_MISMATCH`, `PAYMENTS_MISMATCH`).
 */
export function validateCheckoutPayload(payload: unknown): CheckoutValidation {
  const c = new Collector();
  if (!isRecord(payload)) {
    return { ok: false, errors: ['payload: must be an object'] };
  }
  const p = payload;
  const root = 'payload';

  c.uuid(p, 'client_txn_id', root, true);
  c.uuid(p, 'register_id', root, true);
  c.uuid(p, 'session_id', root, true);

  const kind = p['kind'];
  const kindValid = kind === 'sale' || kind === 'refund';
  if (!kindValid) c.fail(`${root}.kind`, "must be 'sale' or 'refund'");

  if (kind === 'refund') {
    c.uuid(p, 'refund_of_transaction_id', root, true);
    c.string(p, 'refund_reason', root, true);
  } else {
    c.uuid(p, 'refund_of_transaction_id', root, false);
    c.string(p, 'refund_reason', root, false, false);
  }

  if (!isIsoDate(p['business_at'])) c.fail(`${root}.business_at`, 'must be an ISO 8601 date');
  c.boolean(p, 'offline_queued', root, true);
  c.string(p, 'provisional_ref', root, false);
  c.boolean(p, 'deferred_capture', root, false);
  c.uuid(p, 'customer_account_id', root, false);
  c.uuid(p, 'quote_id', root, false);
  c.uuid(p, 'order_id', root, false);
  c.uuid(p, 'passage_contact_id', root, false);
  c.string(p, 'passage_contact_name', root, false);
  if (p['passage_contact_id'] !== undefined && p['customer_account_id'] === undefined) {
    c.fail(`${root}.passage_contact_id`, 'requires customer_account_id (Client passage)');
  }
  validateSettlementLines(c, p, root, kind);
  for (const key of ['offline_chain_prev', 'offline_chain_hash'] as const) {
    const v = p[key];
    if (v !== undefined && (typeof v !== 'string' || !/^([0-9a-f]{64})?$/.test(v))) {
      c.fail(`${root}.${key}`, 'must be a lowercase SHA-256 hex digest');
    }
  }
  if (typeof p['offline_chain_hash'] === 'string' && p['offline_chain_hash'] === '') {
    c.fail(`${root}.offline_chain_hash`, 'must not be empty');
  }
  c.boolean(p, 'invoice_requested', root, true);

  const lines = p['lines'];
  if (!Array.isArray(lines) || lines.length === 0) {
    c.fail(`${root}.lines`, 'must be a non-empty array');
  } else {
    const effectiveKind: TransactionKind = kind === 'refund' ? 'refund' : 'sale';
    lines.forEach((line, i) => validateLine(c, line, `${root}.lines[${i}]`, effectiveKind));
  }

  const payments = p['payments'];
  if (!Array.isArray(payments) || payments.length === 0) {
    c.fail(`${root}.payments`, 'must be a non-empty array');
  } else {
    payments.forEach((payment, i) => validatePayment(c, payment, `${root}.payments[${i}]`));
  }

  c.integer(p, 'change_cents', root, true, { min: 0 });

  const totals = p['totals'];
  if (!isRecord(totals)) {
    c.fail(`${root}.totals`, 'must be an object');
  } else {
    c.integer(totals, 'total_ht_cents', `${root}.totals`, true);
    c.integer(totals, 'total_vat_cents', `${root}.totals`, true);
    c.integer(totals, 'total_ttc_cents', `${root}.totals`, true);
  }

  c.string(p, 'app_version', root, true);

  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  return { ok: true, value: p as unknown as CheckoutPayload };
}
