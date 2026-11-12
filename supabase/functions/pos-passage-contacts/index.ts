// Contacts de passage (comptoir) — personne sans dossier client, nom + téléphone.
// RPC ma-papeterie pos_passage_lookup (recherche nom / téléphone) et pos_passage_upsert
// (création, dédoublonnée par téléphone), via service role. Hors périmètre fiscal : seule la
// fiche « Client passage » (passage_account_id) entre dans le ticket ; l'identifiant du contact
// suit le pont contacts de passage (pos-checkout → outbox → pos-sales-sync).
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { mapapClient } from '../_shared/mapapeterie.ts';

const Schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('search'),
    q: z.string().trim().min(2).max(80),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  z.object({
    action: z.literal('create'),
    full_name: z.string().trim().min(1).max(160),
    phone: z.string().trim().max(40).nullable().optional(),
  }),
  z.object({ action: z.literal('billing_get'), contact_id: z.string().uuid() }),
  // Duplicata A4 d'un ticket passé : contact de passage rattaché à la vente + son en-tête de facture.
  z.object({ action: z.literal('billing_for_transaction'), transaction_id: z.string().uuid() }),
  z.object({
    action: z.literal('billing_set'),
    contact_id: z.string().uuid(),
    billing: z.object({
      name: z.string().trim().max(160).nullish(),
      address: z.string().trim().max(300).nullish(),
      postal_code: z.string().trim().max(16).nullish(),
      city: z.string().trim().max(100).nullish(),
      siret: z.string().trim().max(20).nullish(),
      vat_number: z.string().trim().max(20).nullish(),
      email: z.string().trim().max(160).nullish(),
    }),
  }),
]);

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const auth = await requirePos(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    const input = parsed.data;

    if (input.action === 'search') {
      const { data, error } = await mapapClient().rpc('pos_passage_lookup', {
        p_query: input.q,
        p_limit: input.limit,
      });
      if (error) throw new ApiError('DB_ERROR', `pos_passage_lookup: ${error.message}`);
      return json(200, { contacts: data ?? [] });
    }

    if (input.action === 'billing_for_transaction') {
      // Lien vente → contact : table deny-all (service role) du projet Pos.
      const { data: link, error: linkErr } = await auth.db
        .from('pos_transaction_passage_contacts')
        .select('passage_contact_id')
        .eq('transaction_id', input.transaction_id)
        .maybeSingle();
      if (linkErr) throw new ApiError('DB_ERROR', `pos_transaction_passage_contacts: ${linkErr.message}`);
      if (!link) return json(200, { contact_id: null, billing: {} });
      const { data, error } = await mapapClient().rpc('pos_passage_billing_get', {
        p_contact_id: link.passage_contact_id,
      });
      if (error) throw new ApiError('DB_ERROR', `pos_passage_billing_get: ${error.message}`);
      return json(200, { contact_id: link.passage_contact_id, billing: data ?? {} });
    }

    if (input.action === 'billing_get' || input.action === 'billing_set') {
      const rpc = input.action === 'billing_get' ? 'pos_passage_billing_get' : 'pos_passage_billing_set';
      const args =
        input.action === 'billing_get'
          ? { p_contact_id: input.contact_id }
          : { p_contact_id: input.contact_id, p_billing: input.billing };
      const { data, error } = await mapapClient().rpc(rpc, args);
      if (error) {
        const code = /VALIDATION/.test(error.message)
          ? 'VALIDATION'
          : /NOT_FOUND/.test(error.message)
            ? 'NOT_FOUND'
            : 'DB_ERROR';
        throw new ApiError(code, `${rpc}: ${error.message}`);
      }
      return json(200, { billing: data ?? {} });
    }

    const { data, error } = await mapapClient().rpc('pos_passage_upsert', {
      p_full_name: input.full_name,
      p_phone: input.phone || null,
    });
    if (error) {
      // pos_bridge_error : le message porte le code métier (VALIDATION, NOT_FOUND).
      const code = /VALIDATION/.test(error.message) ? 'VALIDATION' : 'DB_ERROR';
      throw new ApiError(code, `pos_passage_upsert: ${error.message}`);
    }
    return json(200, { contact: data });
  } catch (e) {
    return errorResponse(e);
  }
});
