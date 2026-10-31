// Commandes non réglées d'un client pro — RPC ma-papeterie pos_customer_open_orders
// (sales_orders + sales_order_lines), transférables dans le panier pour encaissement.
// Avec passage_contact_id : commandes d'une personne de passage (pos_passage_open_orders).
// documents: true → commandes ET bons de livraison à encaisser, ligne par ligne
// (pos_customer_open_documents / pos_passage_open_documents) : {documents: {orders, delivery_notes,
// prepared_group}} — prepared_group = lot préparé au back-office (null si aucun).
// Sans documents : ancien format {orders} (caisses d'une version antérieure).
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { mapapClient } from '../_shared/mapapeterie.ts';

const Schema = z.union([
  z.object({ account_id: z.string().uuid(), documents: z.boolean().optional() }),
  z.object({ passage_contact_id: z.string().uuid(), documents: z.boolean().optional() }),
]);

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    await requirePos(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    if (parsed.data.documents) {
      const docsRpc = 'passage_contact_id' in parsed.data
        ? mapapClient().rpc('pos_passage_open_documents', { p_contact_id: parsed.data.passage_contact_id })
        : mapapClient().rpc('pos_customer_open_documents', { p_account_id: parsed.data.account_id });
      const { data, error } = await docsRpc;
      if (error) throw new ApiError('DB_ERROR', `open documents: ${error.message}`);
      const docs = (data ?? {}) as { orders?: unknown[]; delivery_notes?: unknown[]; prepared_group?: unknown };
      return json(200, {
        documents: {
          orders: docs.orders ?? [],
          delivery_notes: docs.delivery_notes ?? [],
          // Lot préparé au back-office (pos_order_groups) : présélectionné par la caisse.
          prepared_group: docs.prepared_group ?? null,
        },
      });
    }
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
