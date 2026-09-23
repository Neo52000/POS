// Cron nocturne : rapproche les clôtures Fiskaly (produites automatiquement côté Fiskaly)
// avec pos_closings (renseigne fiskaly_closing_id / fiskaly_payload).
import { requireService } from '../_shared/auth.ts';
import { getFiskalyClient } from '../_shared/fiskaly/index.ts';
import { errorResponse, handleOptions, json } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const { db } = requireService(req);
    const fiskaly = getFiskalyClient();
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86_400_000);
    const { data: registers, error } = await db
      .from('pos_registers')
      .select('id, code, fiskaly_system_id')
      .eq('is_active', true);
    if (error) throw error;

    let matched = 0;
    const unmatched: string[] = [];
    for (const r of (registers ?? []) as Array<{ id: string; code: string; fiskaly_system_id: string | null }>) {
      if (!r.fiskaly_system_id) continue;
      const closings = await fiskaly.listClosings(r.fiskaly_system_id, from.toISOString(), to.toISOString());
      for (const c of closings) {
        const { data: rows } = await db
          .from('pos_closings')
          .select('id, fiskaly_closing_id')
          .eq('register_id', r.id)
          .eq('period_type', c.period_type)
          .gte('period_start', c.period_start)
          .lt('period_start', c.period_end)
          .limit(1);
        const row = (rows ?? [])[0] as { id: string; fiskaly_closing_id: string | null } | undefined;
        if (!row) {
          unmatched.push(`${r.code}:${c.period_type}:${c.period_start}`);
          continue;
        }
        if (row.fiskaly_closing_id) continue;
        const { error: upErr } = await db.rpc('pos_mark_closing_synced', {
          p_closing_id: row.id,
          p_fiskaly_closing_id: c.closing_id,
          p_payload: c.raw ?? null,
        });
        if (upErr) throw upErr;
        matched++;
      }
    }
    return json(200, { mode: fiskaly.mode, matched, unmatched });
  } catch (e) {
    return errorResponse(e);
  }
});
