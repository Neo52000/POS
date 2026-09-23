// Tarifs négociés B2B : proxy vers ma-papeterie `pos_resolve_cart_prices` (resolve_price).
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { mapapClient } from '../_shared/mapapeterie.ts';

const Schema = z.object({
  account_id: z.string().uuid(),
  lines: z.array(z.object({ product_id: z.string().uuid(), qty: z.number().positive() })).min(1).max(200),
});

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    await requirePos(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    const { data, error } = await mapapClient().rpc('pos_resolve_cart_prices', {
      p_account_id: parsed.data.account_id,
      p_lines: parsed.data.lines,
    });
    if (error) throw new ApiError('DB_ERROR', `pos_resolve_cart_prices: ${error.message}`);
    return json(200, { prices: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
});
