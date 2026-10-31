// Commandes non réglées d'un client pro — RPC ma-papeterie pos_customer_open_orders
// (sales_orders + sales_order_lines), transférables dans le panier pour encaissement.
// Avec passage_contact_id : commandes d'une personne de passage (pos_passage_open_orders).
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { mapapClient } from '../_shared/mapapeterie.ts';

const Schema = z.union([
  z.object({ account_id: z.string().uuid() }),
  z.object({ passage_contact_id: z.string().uuid() }),
]);

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    await requirePos(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    const rpc = 'passage_contact_id' in parsed.data
      ? mapapClient().rpc('pos_passage_open_orders', { p_contact_id: parsed.data.passage_contact_id })
      : mapapClient().rpc('pos_customer_open_orders', { p_account_id: parsed.data.account_id });
    const { data, error } = await rpc;
    if (error) throw new ApiError('DB_ERROR', `open orders: ${error.message}`);
    return json(200, { orders: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
});
