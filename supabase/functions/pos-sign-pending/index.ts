// Cron (toutes les 2 min) : rejoue la signature Fiskaly des transactions pending_signature,
// dans l'ordre des numéros de ticket (ordre du chaînage).
import { requireService } from '../_shared/auth.ts';
import { errorResponse, handleOptions, json } from '../_shared/http.ts';
import { signTransaction } from '../_shared/signing.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const { db } = requireService(req);
    const { data, error } = await db.rpc('pos_pending_signatures', { p_limit: 50 });
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string }>;
    let signed = 0;
    let failed = 0;
    for (const row of rows) {
      const out = await signTransaction(db, row.id);
      if (out.status === 'signed') signed++;
      else if (out.status === 'failed') failed++;
      else break; // Fiskaly indisponible : on garde l'ordre, on réessaiera au prochain tick
    }
    return json(200, { retried: rows.length, signed, failed });
  } catch (e) {
    return errorResponse(e);
  }
});
