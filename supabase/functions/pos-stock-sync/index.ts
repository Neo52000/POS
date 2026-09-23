// Cron (1 min) : rejoue la file pos_stock_sync vers ma-papeterie (pos_apply_stock_movements).
import { requireService } from '../_shared/auth.ts';
import { errorResponse, handleOptions, json } from '../_shared/http.ts';
import { syncPendingStock } from '../_shared/stockSync.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const { db } = requireService(req);
    const out = await syncPendingStock(db, 200);
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
});
