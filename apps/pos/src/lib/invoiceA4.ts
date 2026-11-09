import { paymentMethodLabel } from '@pos/core';
import type { TicketPayload } from '@pos/core';
import { formatDateTime, formatEurCents, formatQty, formatVatRate } from '@/lib/format';
import type { PassageBilling } from '@/types/pos';

/** Destinataire de la facture : client pro (ticket) ou personne de passage (en-tête saisi). */
export interface InvoiceParty {
  name: string;
  address_lines: string[];
  siret?: string;
  vat_number?: string;
  email?: string;
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Destinataire : l'en-tête saisi (personne de passage) prime ; sinon la fiche du ticket (client
 * pro). `null` = aucun client identifié (la facture porte alors « Client comptoir »).
 */
export function invoicePartyFor(
  ticket: Pick<TicketPayload, 'customer'>,
  billing: PassageBilling | null,
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

/** Facture A4 (HTML autonome, prête pour l'impression navigateur) bâtie sur le ticket. */
export function buildInvoiceHtml(ticket: TicketPayload, party: InvoiceParty | null): string {
  const refund = ticket.kind === 'refund';
  const title = refund ? 'AVOIR' : 'FACTURE';
  const number = ticket.ticket_code;
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
        <td class="n">${esc(formatQty(l.qty))}</td>
        <td class="n">${esc(formatEurCents(unitHt))}</td>
        <td class="n">${esc(formatVatRate(l.vat_rate))}</td>
        <td class="n">${esc(formatEurCents(l.line_ttc_cents))}</td>
      </tr>`;
    })
    .join('');

  const vat = ticket.vat_breakdown
    .map(
      (v) => `<tr>
        <td>${esc(formatVatRate(v.rate))}</td>
        <td class="n">${esc(formatEurCents(v.base_ht_cents))}</td>
        <td class="n">${esc(formatEurCents(v.vat_cents))}</td>
        <td class="n">${esc(formatEurCents(v.ttc_cents))}</td>
      </tr>`,
    )
    .join('');

  const pay = ticket.payments
    .map((p) => `${esc(paymentMethodLabel(p.method))} ${esc(formatEurCents(p.amount_cents))}`)
    .join(' · ');

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
  <h1>${title} n° ${esc(number)}</h1>
  <div>Date : ${esc(formatDateTime(ticket.business_at))}${refund && ticket.refund_of_ticket_code ? ` · Avoir sur ticket ${esc(ticket.refund_of_ticket_code)}` : ''}</div>
  <table>
    <thead><tr><th>Désignation</th><th class="n">Qté</th><th class="n">P.U. HT</th><th class="n">TVA</th><th class="n">Total TTC</th></tr></thead>
    <tbody>${lines}</tbody>
  </table>
  <table class="totals">
    <tr><td>Total HT</td><td class="n">${esc(formatEurCents(ticket.total_ht_cents))}</td></tr>
    <tr><td>TVA</td><td class="n">${esc(formatEurCents(ticket.total_vat_cents))}</td></tr>
    <tr class="grand"><td>Total TTC</td><td class="n">${esc(formatEurCents(ticket.total_ttc_cents))}</td></tr>
  </table>
  <table style="width:55%">
    <thead><tr><th>Taux</th><th class="n">Base HT</th><th class="n">TVA</th><th class="n">TTC</th></tr></thead>
    <tbody>${vat}</tbody>
  </table>
  <p class="foot">${refund ? '' : `Facture acquittée à la caisse : ${pay}.<br>`}Document établi à partir du ticket ${esc(number)} (caisse ${esc(ticket.register_code)}, vendeur ${esc(ticket.cashier_name)}).${ticket.compliance.training ? '<br><strong>MODE FORMATION — sans valeur.</strong>' : ''}${ticket.compliance.provisional ? '<br>Ticket provisoire (hors ligne).' : ''}</p>
</body></html>`;
}

/** Imprime un document HTML via un iframe masqué (dialogue d'impression du navigateur, A4). */
export function printHtml(html: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const cleanup = (): void => {
    setTimeout(() => frame.remove(), 1000);
  };
  frame.onload = () => {
    const w = frame.contentWindow;
    if (!w) {
      cleanup();
      return;
    }
    w.addEventListener('afterprint', cleanup);
    w.focus();
    w.print();
  };
  frame.srcdoc = html;
}
