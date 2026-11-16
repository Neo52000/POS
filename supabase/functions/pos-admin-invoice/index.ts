// Facture d'un ticket pour le back-office ma-papeterie.fr (ERP-DECISIONS §26 côté ma-papeterie-v1).
//
// Facture d'un ticket de caisse NF525 pour le back-office ma-papeterie.fr. Contenu reconstruit
// depuis la base (`pos_transaction_full`), comme `pos-send-receipt` : jamais depuis l'appelant.
//
// Auth : secret partagé DÉDIÉ `MAPAP_BRIDGE_SECRET` (en-tête `x-bridge-secret`), comparé à temps
// constant. Ce n'est PAS la clé service_role : la fonction ne donne accès qu'à deux actions
// bornées (lire / envoyer la facture d'UN ticket). `verify_jwt = false` obligatoire pour cette
// fonction (supabase/config.toml : [functions.pos-admin-invoice] verify_jwt = false) — le
// contrôle de l'appelant est fait ICI, dans le code.
//
// Contrat (miroir de src/lib/pos-invoice-bridge.ts côté ma-papeterie) :
//   { action: 'html', transaction_id }       → { ok: true, ticket_code, title, html }
//   { action: 'send', transaction_id, to }   → { ok: true, ticket_code }
import { z } from 'npm:zod@3';
import { sendEmail } from '../_shared/brevo.ts';
import {
  buildInvoiceHtml,
  invoicePartyFor,
  invoiceTitle,
  passageNameOf,
} from '../_shared/invoiceHtml.ts';
import { mapapClient } from '../_shared/mapapeterie.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { loadTransactionFull } from '../_shared/signing.ts';
import { serviceClient } from '../_shared/supabase.ts';
import { buildTicketPayload } from '../_shared/ticket.ts';

const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('html'), transaction_id: z.string().uuid() }),
  z.object({
    action: z.literal('send'),
    transaction_id: z.string().uuid(),
    to: z.string().trim().toLowerCase().email().max(254),
  }),
]);

/** Comparaison à temps constant (longueurs différentes → faux, sans court-circuit sur le contenu). */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function requireBridgeSecret(req: Request): void {
  const expected = Deno.env.get('MAPAP_BRIDGE_SECRET');
  const given = req.headers.get('x-bridge-secret') ?? '';
  if (!expected || expected.length < 32 || !safeEqual(given, expected)) {
    throw new ApiError('UNAUTHORIZED', 'Secret du pont invalide');
  }
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    if (req.method !== 'POST') throw new ApiError('VALIDATION', 'POST requis');
    requireBridgeSecret(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    }
    const input = parsed.data;
    const db = serviceClient();

    let full;
    try {
      full = await loadTransactionFull(db, input.transaction_id);
    } catch {
      throw new ApiError('NOT_FOUND', 'Transaction introuvable');
    }
    const ticket = buildTicketPayload(full);

    // Personne de passage : en-tête de facture relu en base (lien vente → contact).
    let billing: Record<string, string> | null = null;
    const { data: link } = await db
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
    const html = buildInvoiceHtml(ticket, party);

    if (input.action === 'html') {
      return json(200, { ok: true, ticket_code: ticket.ticket_code, title, html });
    }

    await sendEmail({
      to: input.to,
      subject: `${title} ${ticket.ticket_code} — ${ticket.header.company_name}`,
      html,
      text:
        `${title} ${ticket.ticket_code} — ${ticket.header.company_name}\n` +
        `Total TTC : ${(ticket.total_ttc_cents / 100).toFixed(2).replace('.', ',')} €\n` +
        'Le détail est dans la version HTML de ce message.',
      tags: ['pos-invoice', 'backoffice'],
    });
    return json(200, { ok: true, ticket_code: ticket.ticket_code });
  } catch (e) {
    return errorResponse(e);
  }
});
