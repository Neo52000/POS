// Facture A4 / e-mail (HTML autonome) bâtie sur le ticket. FICHIER SANS IMPORT : copié à
// l'identique dans supabase/functions/_shared/invoiceHtml.ts (Edge) ; invoice.test.ts vérifie
// que les deux copies restent identiques. Hors périmètre fiscal : le numéro est celui du ticket.

/** En-tête de facture d'une personne de passage (passage_contacts.billing). */
export interface InvoiceBilling {
  name?: string;
  address?: string;
  postal_code?: string;
  city?: string;
  siret?: string;
  vat_number?: string;
  email?: string;
}

/** Destinataire de la facture : client pro (ticket) ou personne de passage (en-tête saisi). */
export interface InvoiceParty {
  name: string;
  address_lines: string[];
  siret?: string;
  vat_number?: string;
  email?: string;
}

/** Sous-ensemble du TicketPayload nécessaire à la facture (compatible côté PWA et Edge). */
export interface InvoiceTicket {
  register_code: string;
  ticket_code: string;
  kind: 'sale' | 'refund';
  refund_of_ticket_code?: string;
  duplicate?: boolean;
  duplicate_number?: number;
  business_at: string;
  cashier_name: string;
  header: {
    company_name: string;
    address_lines: string[];
    siret: string;
    vat_number: string;
    phone?: string;
  };
  customer?: { display_name: string; company_name?: string; siret?: string; vat_number?: string };
  lines: Array<{
    label: string;
    qty: number;
    discount_percent: number;
    line_ttc_cents: number;
    vat_rate: string;
  }>;
  vat_breakdown: Array<{
    rate: string;
    base_ht_cents: number;
    vat_cents: number;
    ttc_cents: number;
  }>;
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
  payments: Array<{ label: string; amount_cents: number }>;
  compliance: { training?: boolean; provisional?: boolean };
}

const PASSAGE_PREFIX = 'Passage — ';

const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
  timeZone: 'Europe/Paris',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const eur = (cents: number): string =>
  new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(cents / 100)
    .replace(/[\u00a0\u202f]/g, ' ');

const qtyText = (n: number): string => Number(n.toFixed(3)).toString().replace('.', ',');

const vatText = (rate: string): string => {
  const n = Number(rate);
  return Number.isFinite(n) ? `${Number(n.toFixed(2)).toString().replace('.', ',')} %` : rate;
};

const dateText = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateTimeFmt.format(d);
};

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** Nom de la personne de passage portée par le ticket (« Passage — Nom »), sinon null. */
export function passageNameOf(ticket: Pick<InvoiceTicket, 'customer'>): string | null {
  const n = ticket.customer?.display_name ?? '';
  return n.startsWith(PASSAGE_PREFIX) ? n.slice(PASSAGE_PREFIX.length).trim() || null : null;
}

/**
 * Destinataire : l'en-tête saisi (personne de passage) prime ; sinon la fiche du ticket (client
 * pro). `null` = aucun client identifié (la facture porte alors « Client comptoir »).
 */
export function invoicePartyFor(
  ticket: Pick<InvoiceTicket, 'customer'>,
  billing: InvoiceBilling | null,
  passageName: string | null,
): InvoiceParty | null {
  if (billing && Object.keys(billing).length > 0) {
    const cityLine = [billing.postal_code, billing.city].filter(Boolean).join(' ');
    return {
      name: billing.name || passageName || 'Client',
      address_lines: [billing.address, cityLine].filter((l): l is string => !!l),
      ...(billing.siret ? { siret: billing.siret } : {}),
      ...(billing.vat_number ? { vat_number: billing.vat_number } : {}),
      ...(billing.email ? { email: billing.email } : {}),
    };
  }
  if (passageName) return { name: passageName, address_lines: [] };
  const c = ticket.customer;
  if (!c) return null;
  return {
    name: c.company_name || c.display_name,
    address_lines: [],
    ...(c.siret ? { siret: c.siret } : {}),
    ...(c.vat_number ? { vat_number: c.vat_number } : {}),
  };
}

/** Libellé du document : « FACTURE » ou « AVOIR ». */
export function invoiceTitle(ticket: Pick<InvoiceTicket, 'kind'>): 'FACTURE' | 'AVOIR' {
  return ticket.kind === 'refund' ? 'AVOIR' : 'FACTURE';
}

/** Mention « DUPLICATA n°X » (ou « DUPLICATA ») d'un ticket réimprimé, sinon null. */
export function invoiceDuplicateLabel(
  t: Pick<InvoiceTicket, 'duplicate' | 'duplicate_number'>,
): string | null {
  if (!t.duplicate) return null;
  return t.duplicate_number != null && t.duplicate_number > 0
    ? `DUPLICATA n°${t.duplicate_number}`
    : 'DUPLICATA';
}

/** Facture A4 (HTML autonome, prête pour l'impression navigateur ou l'e-mail). */
export function buildInvoiceHtml(ticket: InvoiceTicket, party: InvoiceParty | null): string {
  const refund = ticket.kind === 'refund';
  const title = invoiceTitle(ticket);
  const number = ticket.ticket_code;
  const dup = invoiceDuplicateLabel(ticket);
  const h = ticket.header;
  const sellerLines = [
    ...h.address_lines,
    h.phone ? `Tél. ${h.phone}` : '',
    h.siret ? `SIRET ${h.siret}` : '',
    h.vat_number ? `TVA ${h.vat_number}` : '',
  ].filter(Boolean);

  const buyer = party
    ? [
        `<strong>${esc(party.name)}</strong>`,
        ...party.address_lines.map(esc),
        party.siret ? `SIRET ${esc(party.siret)}` : '',
        party.vat_number ? `TVA ${esc(party.vat_number)}` : '',
        party.email ? esc(party.email) : '',
      ]
        .filter(Boolean)
        .join('<br>')
    : '<strong>Client comptoir</strong>';

  const lines = ticket.lines
    .map((l) => {
      const unitHt = Math.round(l.line_ttc_cents / (1 + Number(l.vat_rate) / 100) / (l.qty || 1));
      return `<tr>
        <td>${esc(l.label)}${l.discount_percent ? `<br><small>Remise ${l.discount_percent} %</small>` : ''}</td>
        <td class="n">${esc(qtyText(l.qty))}</td>
        <td class="n">${esc(eur(unitHt))}</td>
        <td class="n">${esc(vatText(l.vat_rate))}</td>
        <td class="n">${esc(eur(l.line_ttc_cents))}</td>
      </tr>`;
    })
    .join('');

  const vat = ticket.vat_breakdown
    .map(
      (v) => `<tr>
        <td>${esc(vatText(v.rate))}</td>
        <td class="n">${esc(eur(v.base_ht_cents))}</td>
        <td class="n">${esc(eur(v.vat_cents))}</td>
        <td class="n">${esc(eur(v.ttc_cents))}</td>
      </tr>`,
    )
    .join('');

  const pay = ticket.payments.map((p) => `${esc(p.label)} ${esc(eur(p.amount_cents))}`).join(' · ');

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${esc(title)} ${esc(number)}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; }
  body { font: 11pt/1.4 Arial, Helvetica, sans-serif; color: #111; margin: 0; }
  .top { display: flex; justify-content: space-between; gap: 24px; }
  .box { border: 1px solid #999; padding: 10px 12px; min-width: 240px; }
  h1 { font-size: 22pt; margin: 0 0 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; }
  th { text-align: left; background: #eee; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #ccc; vertical-align: top; }
  .n { text-align: right; white-space: nowrap; }
  .totals { margin-left: auto; width: 55%; }
  .totals td { border: 0; padding: 3px 8px; }
  .grand td { font-weight: bold; font-size: 13pt; border-top: 2px solid #111; }
  small, .foot { color: #444; font-size: 9pt; }
  .foot { margin-top: 28px; }
</style></head><body>
  <div class="top">
    <div><strong style="font-size:14pt">${esc(h.company_name)}</strong><br>${sellerLines.map(esc).join('<br>')}</div>
    <div class="box">${buyer}</div>
  </div>
  <h1>${title} n° ${esc(number)}${dup ? ` — ${esc(dup)}` : ''}</h1>
  <div>Date : ${esc(dateText(ticket.business_at))}${refund && ticket.refund_of_ticket_code ? ` · Avoir sur ticket ${esc(ticket.refund_of_ticket_code)}` : ''}</div>
  <table>
    <thead><tr><th>Désignation</th><th class="n">Qté</th><th class="n">P.U. HT</th><th class="n">TVA</th><th class="n">Total TTC</th></tr></thead>
    <tbody>${lines}</tbody>
  </table>
  <table class="totals">
    <tr><td>Total HT</td><td class="n">${esc(eur(ticket.total_ht_cents))}</td></tr>
    <tr><td>TVA</td><td class="n">${esc(eur(ticket.total_vat_cents))}</td></tr>
    <tr class="grand"><td>Total TTC</td><td class="n">${esc(eur(ticket.total_ttc_cents))}</td></tr>
  </table>
  <table style="width:55%">
    <thead><tr><th>Taux</th><th class="n">Base HT</th><th class="n">TVA</th><th class="n">TTC</th></tr></thead>
    <tbody>${vat}</tbody>
  </table>
  <p class="foot">${refund ? '' : `Facture acquittée à la caisse : ${pay}.<br>`}Document établi à partir du ticket ${esc(number)} (caisse ${esc(ticket.register_code)}, vendeur ${esc(ticket.cashier_name)}).${ticket.compliance.training ? '<br><strong>MODE FORMATION — sans valeur.</strong>' : ''}${ticket.compliance.provisional ? '<br>Ticket provisoire (hors ligne).' : ''}</p>
</body></html>`;
}
