// Rendu texte monospace du TicketPayload (SPEC §6) côté Edge : port de `renderTicketText`
// (apps/pos/src/lib/ticket.ts). Sert au ticket dématérialisé (e-mail) : même contenu que le
// ticket imprimé, reconstruit depuis la base (jamais depuis le client).
import type { TicketPayload } from './ticket.ts';

const WIDTH = 42;
const TZ = 'Europe/Paris';

const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : dateTimeFmt.format(d);
}

export function money(cents: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(cents / 100)
    .replace(/[  ]/g, ' ');
}

function num(n: number): string {
  return Number(n.toFixed(3)).toString().replace('.', ',');
}

function pct(n: number): string {
  return `${Number(n.toFixed(2)).toString().replace('.', ',')} %`;
}

function vat(rate: string): string {
  const n = Number(rate);
  return Number.isFinite(n) ? pct(n) : rate;
}

function center(s: string, width = WIDTH): string {
  const text = s.length > width ? s.slice(0, width) : s;
  return ' '.repeat(Math.floor((width - text.length) / 2)) + text;
}

function lr(left: string, right: string, width = WIDTH): string {
  const space = width - left.length - right.length;
  if (space < 1) return `${left.slice(0, Math.max(0, width - right.length - 1))} ${right}`;
  return left + ' '.repeat(space) + right;
}

function wrap(text: string, width = WIDTH): string[] {
  const lines: string[] = [];
  let current = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${w}` : w;
    if (candidate.length <= width) current = candidate;
    else {
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
      ticket.customer.company_name && ticket.customer.company_name !== ticket.customer.display_name
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
    const detail = `  ${num(line.qty)} x ${money(line.unit_price_ttc_cents)}`;
    const discount = line.discount_percent > 0 ? ` -${pct(line.discount_percent)}` : '';
    out.push(lr(`${detail}${discount}`, money(line.line_ttc_cents), width));
    if (
      line.public_price_ttc_cents != null &&
      line.public_price_ttc_cents !== line.unit_price_ttc_cents
    ) {
      out.push(`  Prix public ${money(line.public_price_ttc_cents)} (tarif pro)`);
    }
    out.push(`  TVA ${vat(line.vat_rate)}`);
  }
  out.push(sep);
  out.push(lr('Total HT', money(ticket.total_ht_cents), width));
  for (const v of ticket.vat_breakdown) {
    out.push(lr(`TVA ${vat(v.rate)} sur ${money(v.base_ht_cents)}`, money(v.vat_cents), width));
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
      `${
        SIGNATURE_LABEL[ticket.compliance.signature_status] ?? ticket.compliance.signature_status
      } · #${ticket.compliance.hash_short}`,
      width,
    ),
  );
  if (ticket.compliance.fiskaly_signature_short) {
    out.push(center(ticket.compliance.fiskaly_signature_short, width));
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(
    /"/g,
    '&quot;',
  );
}

/** E-mail du ticket : ticket monospace intégral (identique au papier) dans un gabarit sobre. */
export function renderReceiptEmail(
  ticket: TicketPayload,
): { subject: string; html: string; text: string } {
  const text = renderTicketText(ticket).join('\n');
  const shop = ticket.header.company_name;
  const what = ticket.kind === 'refund' ? 'Votre avoir' : 'Votre ticket de caisse';
  const subject = `${what} ${ticket.ticket_code} · ${money(ticket.total_ttc_cents)}`;
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${
    escapeHtml(subject)
  }</title></head>
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background:#fff;border-radius:12px;padding:24px">
<tr><td style="font-size:16px;line-height:1.5;padding-bottom:16px">Bonjour,<br>${
    escapeHtml(what.toLowerCase())
  } du ${escapeHtml(formatDateTime(ticket.business_at))} chez ${
    escapeHtml(shop)
  }. Merci de votre visite !</td></tr>
<tr><td><pre style="margin:0;padding:16px;background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;font-family:'Courier New',Courier,monospace;font-size:13px;line-height:1.35;white-space:pre;overflow-x:auto">${
    escapeHtml(text)
  }</pre></td></tr>
<tr><td style="font-size:12px;color:#71717a;padding-top:16px">Ticket de caisse dématérialisé, conservez cet e-mail comme justificatif d'achat.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text: `${what} ${ticket.ticket_code}\n\n${text}` };
}

/** SMS du ticket (≤ 160 caractères visés) : n° de ticket, date, total, moyen de paiement. */
export function renderReceiptSms(ticket: TicketPayload): string {
  const shop = ticket.header.company_name;
  const label = ticket.kind === 'refund' ? 'Avoir' : 'Ticket';
  const paidWith = ticket.payments.map((p) => p.label).join(' + ');
  // « EUR » plutôt que « € » : reste en alphabet GSM, 1 SMS facturé au lieu de 2.
  const total = money(ticket.total_ttc_cents).replace(' €', ' EUR');
  return `${shop} - ${label} ${ticket.ticket_code} du ${
    formatDateTime(ticket.business_at)
  } - Total ${total} TTC${paidWith ? ` (${paidWith})` : ''}. Merci de votre visite !`;
}
