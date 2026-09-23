// Construit le TicketPayload (SPEC §6) à partir du résultat de la RPC pos_transaction_full.

export interface TicketPayload {
  version: 1;
  register_code: string;
  ticket_number: number | null;
  ticket_code: string;
  duplicate: boolean;
  kind: 'sale' | 'refund';
  refund_of_ticket_code?: string;
  business_at: string;
  cashier_name: string;
  header: { company_name: string; address_lines: string[]; siret: string; vat_number: string; phone?: string };
  customer?: { display_name: string; company_name?: string; siret?: string; vat_number?: string };
  lines: Array<{
    label: string;
    qty: number;
    unit_price_ttc_cents: number;
    discount_percent: number;
    line_ttc_cents: number;
    vat_rate: string;
    price_tier_title?: string;
    public_price_ttc_cents?: number;
  }>;
  vat_breakdown: Array<{ rate: string; base_ht_cents: number; vat_cents: number; ttc_cents: number }>;
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
  payments: Array<{ method: string; label: string; amount_cents: number; reference?: string }>;
  change_cents: number;
  footer: { lines: string[] };
  compliance: {
    hash_short: string;
    signature_status: string;
    fiskaly_signature_short?: string;
    software: 'Ma Papeterie POS';
    version: string;
    provisional?: boolean;
  };
  quote_number?: string;
  invoice_requested: boolean;
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cb: 'Carte bancaire',
  cash: 'Espèces',
  cheque: 'Chèque',
  gift_ucia: 'Bon cadeau UCIA',
  transfer: 'Virement',
};

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

function vatRate(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}

export function ticketCode(businessAt: string, ticketNumber: number): string {
  const year = new Date(businessAt).getUTCFullYear();
  return `T-${year}-${String(ticketNumber).padStart(6, '0')}`;
}

/**
 * @param full résultat de `pos_transaction_full` : { transaction, lines, payments, register, settings, cashier_name?, refund_of? }
 */
export function buildTicketPayload(full: Json, opts: { duplicate?: boolean } = {}): TicketPayload {
  const t: Json = full.transaction ?? {};
  const lines: Json[] = full.lines ?? [];
  const payments: Json[] = full.payments ?? [];
  const register: Json = full.register ?? {};
  const settings: Json = full.settings ?? {};
  const legal: Json = settings.legal ?? {};
  const software: Json = settings.software ?? {};
  const customer: Json | null = t.customer_snapshot ?? null;
  const change = Number(t.change_cents ?? 0);
  const ticketNumber = t.ticket_number == null ? null : Number(t.ticket_number);
  const code =
    ticketNumber != null ? ticketCode(String(t.business_at), ticketNumber) : String(t.provisional_ref ?? '');

  const payload: TicketPayload = {
    version: 1,
    register_code: String(register.code ?? ''),
    ticket_number: ticketNumber,
    ticket_code: code,
    duplicate: opts.duplicate === true,
    kind: t.kind === 'refund' ? 'refund' : 'sale',
    business_at: String(t.business_at ?? ''),
    cashier_name: String(full.cashier_name ?? t.cashier_id ?? ''),
    header: {
      company_name: String(legal.company_name ?? 'Reine & Fils SAS'),
      address_lines: Array.isArray(legal.address_lines) ? legal.address_lines.map(String) : [],
      siret: String(legal.siret ?? ''),
      vat_number: String(legal.vat_number ?? ''),
      ...(legal.phone ? { phone: String(legal.phone) } : {}),
    },
    lines: lines
      .slice()
      .sort((a, b) => Number(a.line_no) - Number(b.line_no))
      .map((l) => ({
        label: String(l.label),
        qty: Number(l.qty),
        unit_price_ttc_cents: Number(l.unit_price_ttc_cents),
        discount_percent: Number(l.discount_percent ?? 0),
        line_ttc_cents: Number(l.line_ttc_cents),
        vat_rate: vatRate(l.vat_rate),
        ...(l.price_tier_title ? { price_tier_title: String(l.price_tier_title) } : {}),
        ...(l.public_price_ttc_cents != null ? { public_price_ttc_cents: Number(l.public_price_ttc_cents) } : {}),
      })),
    vat_breakdown: (Array.isArray(t.vat_breakdown) ? t.vat_breakdown : []).map((v: Json) => ({
      rate: vatRate(v.rate),
      base_ht_cents: Number(v.base_ht_cents),
      vat_cents: Number(v.vat_cents),
      ttc_cents: Number(v.ttc_cents),
    })),
    total_ht_cents: Number(t.total_ht_cents ?? 0),
    total_vat_cents: Number(t.total_vat_cents ?? 0),
    total_ttc_cents: Number(t.total_ttc_cents ?? 0),
    payments: payments.map((p) => ({
      method: String(p.method),
      label: PAYMENT_METHOD_LABELS[String(p.method)] ?? String(p.method),
      amount_cents: Number(p.amount_cents),
      ...(p.reference ? { reference: String(p.reference) } : {}),
    })),
    change_cents: change,
    footer: {
      lines: Array.isArray(settings.ticket_footer)
        ? settings.ticket_footer.map(String)
        : Array.isArray(settings.ticket_footer?.lines)
          ? settings.ticket_footer.lines.map(String)
          : [],
    },
    compliance: {
      hash_short: String(t.hash ?? '').slice(0, 8),
      signature_status: String(t.signature_status ?? 'pending_signature'),
      ...(t.fiskaly_signature ? { fiskaly_signature_short: String(t.fiskaly_signature).slice(0, 16) } : {}),
      software: 'Ma Papeterie POS',
      version: String(software.version ?? '0.1.0'),
      ...(t.offline_queued ? { provisional: true } : {}),
    },
    invoice_requested: t.invoice_requested === true,
  };
  if (customer && (customer.display_name || customer.company_name)) {
    payload.customer = {
      display_name: String(customer.display_name ?? customer.company_name ?? ''),
      ...(customer.company_name ? { company_name: String(customer.company_name) } : {}),
      ...(customer.siret ? { siret: String(customer.siret) } : {}),
      ...(customer.vat_number ? { vat_number: String(customer.vat_number) } : {}),
    };
  }
  if (full.refund_of?.ticket_number != null) {
    payload.refund_of_ticket_code = ticketCode(
      String(full.refund_of.business_at),
      Number(full.refund_of.ticket_number),
    );
  }
  if (full.quote_number) payload.quote_number = String(full.quote_number);
  return payload;
}
