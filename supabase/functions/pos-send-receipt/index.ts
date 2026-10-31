// Ticket dématérialisé (après encaissement) : envoi par e-mail ou SMS via Brevo.
// Le contenu est reconstruit depuis la base (`pos_transaction_full`), jamais depuis le client :
// le ticket envoyé est identique au ticket enregistré. Le destinataire n'est pas conservé.
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { normalizePhone, sendEmail, sendSms } from '../_shared/brevo.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { renderReceiptEmail, renderReceiptSms } from '../_shared/receiptText.ts';
import { loadTransactionFull } from '../_shared/signing.ts';
import { buildTicketPayload } from '../_shared/ticket.ts';

const Schema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('email'),
    transaction_id: z.string().uuid(),
    to: z.string().trim().toLowerCase().email().max(254),
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

    if (input.channel === 'email') {
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
