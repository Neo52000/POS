// Ticket dématérialisé (après encaissement) : envoi par e-mail ou SMS via Brevo.
// Le contenu est reconstruit depuis la base (`pos_transaction_full`), jamais depuis le client :
// le ticket envoyé est identique au ticket enregistré. Le destinataire n'est pas conservé.
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { normalizePhone, sendEmail, sendSms } from '../_shared/brevo.ts';
import { buildInvoiceHtml, invoicePartyFor, invoiceTitle, passageNameOf } from '../_shared/invoiceHtml.ts';
import { mapapClient } from '../_shared/mapapeterie.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { renderReceiptEmail, renderReceiptSms } from '../_shared/receiptText.ts';
import { loadTransactionFull } from '../_shared/signing.ts';
import { buildTicketPayload } from '../_shared/ticket.ts';

const Schema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('email'),
    transaction_id: z.string().uuid(),
    to: z.string().trim().toLowerCase().email().max(254),
    /** `invoice` : facture A4 en HTML (en-tête de facture relu en base) au lieu du ticket. */
    document: z.enum(['ticket', 'invoice']).default('ticket'),
  }),
  z.object({
    channel: z.literal('sms'),
    transaction_id: z.string().uuid(),
    to: z.string().trim().min(6).max(40),
  }),
]);

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const auth = await requirePos(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    }
    const input = parsed.data;

    let full;
    try {
      full = await loadTransactionFull(auth.db, input.transaction_id);
    } catch {
      throw new ApiError('NOT_FOUND', 'Transaction introuvable');
    }
    const ticket = buildTicketPayload(full);

    if (input.channel === 'email' && input.document === 'invoice') {
      // Personne de passage : en-tête de facture relu en base (lien vente → contact, service role).
      let billing: Record<string, string> | null = null;
      const { data: link } = await auth.db
        .from('pos_transaction_passage_contacts')
        .select('passage_contact_id')
        .eq('transaction_id', input.transaction_id)
        .maybeSingle();
      if (link) {
        const { data } = await mapapClient().rpc('pos_passage_billing_get', {
          p_contact_id: link.passage_contact_id,
        });
        billing = (data as Record<string, string> | null) ?? null;
      }
      const party = invoicePartyFor(ticket, billing, passageNameOf(ticket));
      const title = invoiceTitle(ticket) === 'AVOIR' ? 'Avoir' : 'Facture';
      await sendEmail({
        to: input.to,
        subject: `${title} ${ticket.ticket_code} — ${ticket.header.company_name}`,
        html: buildInvoiceHtml(ticket, party),
        text:
          `${title} ${ticket.ticket_code} — ${ticket.header.company_name}\n` +
          `Total TTC : ${(ticket.total_ttc_cents / 100).toFixed(2).replace('.', ',')} €\n` +
          'Le détail est dans la version HTML de ce message.',
        tags: ['pos-invoice'],
      });
    } else if (input.channel === 'email') {
      const mail = renderReceiptEmail(ticket);
      await sendEmail({ to: input.to, ...mail, tags: ['pos-receipt'] });
    } else {
      const phone = normalizePhone(input.to);
      if (!phone) throw new ApiError('VALIDATION', 'Numéro de mobile invalide');
      await sendSms({ to: phone, content: renderReceiptSms(ticket), tag: 'pos-receipt' });
    }
    return json(200, { ok: true, channel: input.channel, ticket_code: ticket.ticket_code });
  } catch (e) {
    return errorResponse(e);
  }
});
