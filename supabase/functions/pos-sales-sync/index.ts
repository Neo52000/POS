// Cron (5 min) : pont ventes NF525 → dashboard ma-papeterie (pos_record_sales). Hors périmètre
// fiscal : lecture seule des tickets validés (PERIMETRE-NF525.md §1.2).
import { requireService } from '../_shared/auth.ts';
import { errorResponse, handleOptions, json } from '../_shared/http.ts';
import { syncPendingSales } from '../_shared/salesSync.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const { db } = requireService(req);
    const out = await syncPendingSales(db, 200);
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
});
