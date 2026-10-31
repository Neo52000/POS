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
]);

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    await requirePos(req);
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
