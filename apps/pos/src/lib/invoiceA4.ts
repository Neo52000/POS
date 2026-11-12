import type { InvoiceParty, InvoiceTicket } from '@pos/core';
import { buildInvoiceHtml as buildHtml, invoicePartyFor as partyFor } from '@pos/core';
import type { PassageBilling } from '@/types/pos';

export type { InvoiceParty };

/** Destinataire de la facture (voir `@pos/core` invoice) : en-tête de passage, sinon fiche pro. */
export function invoicePartyFor(
  ticket: Pick<InvoiceTicket, 'customer'>,
  billing: PassageBilling | null,
  passageName: string | null,
): InvoiceParty | null {
  return partyFor(ticket, billing, passageName);
}

/** Facture A4 (HTML autonome) bâtie sur le ticket : même rendu que l'e-mail (Edge). */
export function buildInvoiceHtml(ticket: InvoiceTicket, party: InvoiceParty | null): string {
  return buildHtml(ticket, party);
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
