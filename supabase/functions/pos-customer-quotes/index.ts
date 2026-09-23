// Devis ouverts d'un client pro (client_quotes + items) pour import dans le panier.
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';

const Schema = z.object({ account_id: z.string().uuid() });

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const auth = await requirePos(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    const { data, error } = await (auth.userDb ?? auth.db).rpc('pos_customer_open_quotes', {
      p_account_id: parsed.data.account_id,
    });
    if (error) throw error;
    return json(200, { quotes: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
});
