import { PAYMENT_METHOD_LABELS } from './cart.js';
import type { PaymentMethod, VatBreakdownEntry } from './cart.js';

export const TICKET_PAYLOAD_VERSION = 1;
export const SOFTWARE_NAME = 'Ma Papeterie POS';

export type TransactionKind = 'sale' | 'refund';
export type SignatureStatus = 'signed' | 'pending_signature' | 'failed' | 'mock';

export interface TicketHeader {
  company_name: string;
  address_lines: string[];
  siret: string;
  vat_number: string;
  phone?: string;
}

export interface TicketCustomer {
  display_name: string;
  company_name?: string;
  siret?: string;
  vat_number?: string;
}

export interface TicketLine {
  label: string;
  qty: number;
  unit_price_ttc_cents: number;
  discount_percent: number;
  line_ttc_cents: number;
  vat_rate: string;
  price_tier_title?: string;
  public_price_ttc_cents?: number;
}

export interface TicketPayment {
  method: PaymentMethod;
  label: string;
  amount_cents: number;
  reference?: string;
}

export interface TicketCompliance {
  /** 8 premiers hex du hash. */
  hash_short: string;
  signature_status: SignatureStatus;
  fiskaly_signature_short?: string;
  software: typeof SOFTWARE_NAME;
  version: string;
  provisional?: boolean;
  /** Mode formation (SPEC §13.3) : ticket sans valeur, jamais enregistré. */
  training?: boolean;
}

/** SPEC §6 — rendu ESC/POS par le bridge, aperçu HTML par la PWA. */
export interface TicketPayload {
  version: typeof TICKET_PAYLOAD_VERSION;
  register_code: string;
  ticket_number: number | null;
  /** `T-2026-000123` ou `provisional_ref`. */
  ticket_code: string;
  duplicate: boolean;
  /**
   * Rang du duplicata (0.4.0) renvoyé par `pos_reprint` après journalisation synchrone ; imprimé
   * « DUPLICATA n°X ». Absent : « DUPLICATA » seul (ticket provisoire, formation).
   */
  duplicate_number?: number;
  kind: TransactionKind;
  refund_of_ticket_code?: string;
  business_at: string;
  cashier_name: string;
  header: TicketHeader;
  customer?: TicketCustomer;
  lines: TicketLine[];
  vat_breakdown: VatBreakdownEntry[];
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
  payments: TicketPayment[];
  change_cents: number;
  footer: { lines: string[] };
  compliance: TicketCompliance;
  quote_number?: string;
  invoice_requested: boolean;
}

/** `buildTicketCode(2026, 123)` → `T-2026-000123`. */
export function buildTicketCode(year: number, ticketNumber: number): string {
  if (!Number.isInteger(year) || year < 0) {
    throw new RangeError(`year must be a positive integer, got ${String(year)}`);
  }
  if (!Number.isInteger(ticketNumber) || ticketNumber < 0) {
    throw new RangeError(`ticketNumber must be a positive integer, got ${String(ticketNumber)}`);
  }
  return `T-${String(year).padStart(4, '0')}-${String(ticketNumber).padStart(6, '0')}`;
}

/** Libellé imprimable d'une méthode de paiement (SPEC §6). */
export function paymentMethodLabel(method: PaymentMethod): string {
  return PAYMENT_METHOD_LABELS[method];
}

/** 8 premiers caractères hex du hash, pour `compliance.hash_short`. */
export function hashShort(hash: string): string {
  return hash.slice(0, 8).toLowerCase();
}

/** Mention imprimée d'un duplicata : `DUPLICATA n°X` (0.4.0) ou `DUPLICATA`. */
export function duplicateLabel(
  t: Pick<TicketPayload, 'duplicate' | 'duplicate_number'>,
): string | null {
  if (!t.duplicate) return null;
  return t.duplicate_number != null && t.duplicate_number > 0
    ? `DUPLICATA n°${t.duplicate_number}`
    : 'DUPLICATA';
}
