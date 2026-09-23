// Recherche client (comptoir B2B) — RPC ma-papeterie pos_customer_lookup (customer_360), via service role.
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { mapapClient } from '../_shared/mapapeterie.ts';

const Schema = z.object({ q: z.string().trim().min(2).max(80), limit: z.number().int().min(1).max(25).default(10) });

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    await requirePos(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    const { data, error } = await mapapClient().rpc('pos_customer_lookup', {
      p_query: parsed.data.q,
      p_limit: parsed.data.limit,
    });
    if (error) throw new ApiError('DB_ERROR', `pos_customer_lookup: ${error.message}`);
    return json(200, { customers: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
});
