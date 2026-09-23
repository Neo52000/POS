import { PAYMENT_METHOD_LABELS, formatEurCents, isPaymentMethod } from '@pos/core';
import type { TicketPayload } from '@pos/core';
import { env } from '@/lib/env';
import type { PosSettingsMap, TransactionFull } from '@/types/pos';
import { formatDateTime, formatPercent, formatQty, formatVatRate } from '@/lib/format';

function footerLines(raw: PosSettingsMap['ticket_footer']): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (raw && typeof raw === 'object' && Array.isArray(raw.lines)) return raw.lines.map(String);
  return [];
}

function vatRate(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v);
}

/** `T-2026-000123` (année UTC de `business_at`, comme côté serveur). */
export function ticketCode(businessAt: string, ticketNumber: number): string {
  const year = new Date(businessAt).getUTCFullYear();
  return `T-${year}-${String(ticketNumber).padStart(6, '0')}`;
}

/** Port client de `_shared/ticket.ts` (Edge) : `pos_transaction_full` → `TicketPayload` (SPEC §6). */
export function buildTicketPayload(
  full: TransactionFull,
  opts: { duplicate?: boolean } = {},
): TicketPayload {
  const t = full.transaction;
  const register = full.register;
  const settings = full.settings ?? {};
  const legal = settings.legal ?? {};
  const software = settings.software ?? {};
  const customer = t.customer_snapshot;
  const ticketNumber = t.ticket_number == null ? null : Number(t.ticket_number);
  const code =
    ticketNumber != null ? ticketCode(t.business_at, ticketNumber) : (t.provisional_ref ?? '');

  const payload: TicketPayload = {
    version: 1,
    register_code: register?.code ?? '',
    ticket_number: ticketNumber,
    ticket_code: code,
    duplicate: opts.duplicate === true,
    kind: t.kind === 'refund' ? 'refund' : 'sale',
    business_at: t.business_at,
    cashier_name: full.cashier_name ?? t.cashier_id ?? '',
    header: {
      company_name: legal.company_name ?? 'Reine & Fils SAS',
      address_lines: Array.isArray(legal.address_lines) ? legal.address_lines.map(String) : [],
      siret: legal.siret ?? '',
      vat_number: legal.vat_number ?? '',
      ...(legal.phone ? { phone: legal.phone } : {}),
    },
    lines: [...full.lines]
      .sort((a, b) => Number(a.line_no) - Number(b.line_no))
      .map((l) => ({
        label: l.label,
        qty: Number(l.qty),
        unit_price_ttc_cents: Number(l.unit_price_ttc_cents),
        discount_percent: Number(l.discount_percent ?? 0),
        line_ttc_cents: Number(l.line_ttc_cents),
        vat_rate: vatRate(l.vat_rate),
        ...(l.price_tier_title ? { price_tier_title: l.price_tier_title } : {}),
        ...(l.public_price_ttc_cents != null
          ? { public_price_ttc_cents: Number(l.public_price_ttc_cents) }
          : {}),
      })),
    vat_breakdown: (Array.isArray(t.vat_breakdown) ? t.vat_breakdown : []).map((v) => ({
      rate: vatRate(v.rate),
      base_ht_cents: Number(v.base_ht_cents),
      vat_cents: Number(v.vat_cents),
      ttc_cents: Number(v.ttc_cents),
    })),
    total_ht_cents: Number(t.total_ht_cents ?? 0),
    total_vat_cents: Number(t.total_vat_cents ?? 0),
    total_ttc_cents: Number(t.total_ttc_cents ?? 0),
    payments: full.payments.map((p) => ({
      method: p.method,
      label: isPaymentMethod(p.method) ? PAYMENT_METHOD_LABELS[p.method] : String(p.method),
      amount_cents: Number(p.amount_cents),
      ...(p.reference ? { reference: p.reference } : {}),
    })),
    change_cents: Number(t.change_cents ?? 0),
    footer: { lines: footerLines(settings.ticket_footer) },
    compliance: {
      hash_short: String(t.hash ?? '').slice(0, 8),
      signature_status: t.signature_status ?? 'pending_signature',
      ...(t.fiskaly_signature
        ? { fiskaly_signature_short: String(t.fiskaly_signature).slice(0, 16) }
        : {}),
      software: 'Ma Papeterie POS',
      version: software.version ?? env.appVersion,
      ...(t.offline_queued ? { provisional: true } : {}),
    },
    invoice_requested: t.invoice_requested === true,
  };
  if (customer && (customer.display_name || customer.company_name)) {
    payload.customer = {
      display_name: customer.display_name ?? customer.company_name ?? '',
      ...(customer.company_name ? { company_name: customer.company_name } : {}),
      ...(customer.siret ? { siret: customer.siret } : {}),
      ...(customer.vat_number ? { vat_number: customer.vat_number } : {}),
    };
  }
  if (full.refund_of?.ticket_number != null) {
    payload.refund_of_ticket_code = ticketCode(
      full.refund_of.business_at,
      Number(full.refund_of.ticket_number),
    );
  }
  if (full.quote_number) payload.quote_number = full.quote_number;
  return payload;
}

// ---------------------------------------------------------------------------
// Rendu texte monospace (aperçu HTML + fallback impression), 42 colonnes.
// ---------------------------------------------------------------------------

const WIDTH = 42;

function center(s: string, width = WIDTH): string {
  const text = s.length > width ? s.slice(0, width) : s;
  const pad = Math.floor((width - text.length) / 2);
  return ' '.repeat(pad) + text;
}

function lr(left: string, right: string, width = WIDTH): string {
  const space = width - left.length - right.length;
  if (space < 1) return `${left.slice(0, Math.max(0, width - right.length - 1))} ${right}`;
  return left + ' '.repeat(space) + right;
}

function money(cents: number): string {
  // Espaces insécables → espaces simples pour un rendu monospace stable.
  return formatEurCents(cents).replace(/[\u202f\u00a0]/g, ' ');
}

function wrap(text: string, width = WIDTH): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w.length > width ? w.slice(0, width) : w;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

const SIGNATURE_LABEL: Record<string, string> = {
  signed: 'Signé',
  pending_signature: 'Signature en attente',
  failed: 'Signature en échec',
  mock: 'Signature (test)',
};

/** Rendu texte du ticket (SPEC §6), une entrée par ligne imprimée. */
export function renderTicketText(ticket: TicketPayload, width = WIDTH): string[] {
  const out: string[] = [];
  const sep = '-'.repeat(width);
  const dbl = '='.repeat(width);

  out.push(center(ticket.header.company_name.toUpperCase(), width));
  for (const l of ticket.header.address_lines) out.push(center(l, width));
  if (ticket.header.phone) out.push(center(`Tél. ${ticket.header.phone}`, width));
  if (ticket.header.siret) out.push(center(`SIRET ${ticket.header.siret}`, width));
  if (ticket.header.vat_number) out.push(center(`TVA ${ticket.header.vat_number}`, width));
  out.push(sep);
  if (ticket.duplicate) out.push(center('*** DUPLICATA ***', width));
  if (ticket.kind === 'refund') out.push(center('*** REMBOURSEMENT ***', width));
  if (ticket.compliance.provisional) out.push(center('*** TICKET PROVISOIRE ***', width));
  out.push(lr(`Ticket ${ticket.ticket_code}`, ticket.register_code, width));
  out.push(
    lr(
      formatDateTime(ticket.business_at),
      ticket.cashier_name ? `Vendeur ${ticket.cashier_name}` : '',
      width,
    ),
  );
  if (ticket.refund_of_ticket_code) out.push(`Rembourse le ticket ${ticket.refund_of_ticket_code}`);
  if (ticket.customer) {
    out.push(sep);
    out.push(`Client : ${ticket.customer.display_name}`);
    if (
      ticket.customer.company_name &&
      ticket.customer.company_name !== ticket.customer.display_name
    ) {
      out.push(`  ${ticket.customer.company_name}`);
    }
    if (ticket.customer.siret) out.push(`  SIRET ${ticket.customer.siret}`);
    if (ticket.customer.vat_number) out.push(`  TVA ${ticket.customer.vat_number}`);
    if (ticket.quote_number) out.push(`  Devis ${ticket.quote_number}`);
    if (ticket.invoice_requested) out.push('  Facture demandée');
  }
  out.push(sep);
  for (const line of ticket.lines) {
    for (const l of wrap(line.label, width)) out.push(l);
    if (line.price_tier_title) out.push(`  ${line.price_tier_title}`);
    const detail = `  ${formatQty(line.qty)} x ${money(line.unit_price_ttc_cents)}`;
    const discount = line.discount_percent > 0 ? ` -${formatPercent(line.discount_percent)}` : '';
    out.push(lr(`${detail}${discount}`, money(line.line_ttc_cents), width));
    if (
      line.public_price_ttc_cents != null &&
      line.public_price_ttc_cents !== line.unit_price_ttc_cents
    ) {
      out.push(`  Prix public ${money(line.public_price_ttc_cents)} (tarif pro)`);
    }
    out.push(`  TVA ${formatVatRate(line.vat_rate)}`);
  }
  out.push(sep);
  out.push(lr('Total HT', money(ticket.total_ht_cents), width));
  for (const v of ticket.vat_breakdown) {
    out.push(
      lr(`TVA ${formatVatRate(v.rate)} sur ${money(v.base_ht_cents)}`, money(v.vat_cents), width),
    );
  }
  out.push(dbl);
  out.push(lr('TOTAL TTC', money(ticket.total_ttc_cents), width));
  out.push(dbl);
  for (const p of ticket.payments) {
    out.push(lr(p.label, money(p.amount_cents), width));
    if (p.reference) out.push(`  Réf. ${p.reference}`);
  }
  if (ticket.change_cents > 0) out.push(lr('Rendu', money(ticket.change_cents), width));
  out.push(sep);
  for (const l of ticket.footer.lines) out.push(center(l, width));
  if (ticket.footer.lines.length) out.push('');
  out.push(center(`${ticket.compliance.software} v${ticket.compliance.version}`, width));
  out.push(
    center(
      `${SIGNATURE_LABEL[ticket.compliance.signature_status] ?? ticket.compliance.signature_status} · #${ticket.compliance.hash_short}`,
      width,
    ),
  );
  if (ticket.compliance.fiskaly_signature_short)
    out.push(center(ticket.compliance.fiskaly_signature_short, width));
  return out;
}
