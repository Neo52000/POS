// Historique Shopify POS (avant la bascule NF525), consultation seule en caisse — HORS FISCAL.
// {}            → {days}   : RPC ma-papeterie pos_shopify_pos_days (jours + totaux en centimes)
// {date: J}     → {orders} : RPC ma-papeterie pos_shopify_pos_day (commandes du jour + lignes)
// Lecture de `shopify_orders` (projet ma-papeterie) uniquement : rien n'est écrit.
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { mapapClient } from '../_shared/mapapeterie.ts';

const Schema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    await requirePos(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    if (parsed.data.date) {
      const { data, error } = await mapapClient().rpc('pos_shopify_pos_day', {
        p_date: parsed.data.date,
      });
      if (error) throw new ApiError('DB_ERROR', `pos_shopify_pos_day: ${error.message}`);
      return json(200, { orders: data ?? [] });
    }
    const { data, error } = await mapapClient().rpc('pos_shopify_pos_days');
    if (error) throw new ApiError('DB_ERROR', `pos_shopify_pos_days: ${error.message}`);
    return json(200, { days: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
});
