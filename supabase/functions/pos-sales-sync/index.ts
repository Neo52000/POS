// Cron (5 min) : pont ventes NF525 → dashboard ma-papeterie (pos_record_sales) et rejeu des
// règlements de commandes transférées (pos_settle_orders). Hors périmètre fiscal : lecture seule
// des tickets validés (PERIMETRE-NF525.md §1.2).
import { requireService } from '../_shared/auth.ts';
import { errorResponse, handleOptions, json } from '../_shared/http.ts';
import { syncPendingOrderSettlements } from '../_shared/orderSettlement.ts';
import { syncPendingSales } from '../_shared/salesSync.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const { db } = requireService(req);
    const out = await syncPendingSales(db, 200);
    const orders = await syncPendingOrderSettlements(db, { limit: 200 });
    return json(200, { ...out, order_settlements: orders });
  } catch (e) {
    return errorResponse(e);
  }
});
