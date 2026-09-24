// Clôtures mensuelle / annuelle (ou journalière forcée) : agrège via pos_compute_closing.
// Appel cron (service role) ou vendeur/admin. Les bornes de période sont calculées en
// Europe/Paris par la RPC pos_period_bounds (aucun calcul de fuseau en TypeScript).
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { periodBounds, previousPeriod } from '../_shared/periods.ts';

const Schema = z.object({
  register_id: z.string().uuid().optional(),
  period_type: z.enum(['daily', 'monthly', 'annual']),
  // Instant quelconque de la période à clôturer (ISO) : la période qui le contient est retenue.
  // Absent (cron) : période précédente complète (jour / mois / année passés, Europe/Paris).
  period_start: z.string().datetime({ offset: true }).optional(),
});

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const auth = await requirePos(req);
    const parsed = Schema.safeParse(req.method === 'POST' ? await readJson(req) : {});
    if (!parsed.success) {
      throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    }
    const { period_type } = parsed.data;
    const period = parsed.data.period_start
      ? await periodBounds(auth.db, period_type, parsed.data.period_start)
      : await previousPeriod(auth.db, period_type);

    let registerIds: string[] = [];
    if (parsed.data.register_id) registerIds = [parsed.data.register_id];
    else {
      const { data, error } = await auth.db.from('pos_registers').select('id').eq(
        'is_active',
        true,
      );
      if (error) throw error;
      registerIds = (data ?? []).map((r: { id: string }) => r.id);
    }

    const closings = [];
    for (const registerId of registerIds) {
      const { data, error } = await auth.db.rpc('pos_compute_closing', {
        p_register_id: registerId,
        p_period_type: period_type,
        p_period_start: period.start,
        p_period_end: period.end,
        p_session_id: null,
        p_created_by: auth.userId,
      });
      if (error) throw error;
      closings.push(data);
    }
    return json(200, { period_type, period_start: period.start, period_end: period.end, closings });
  } catch (e) {
    return errorResponse(e);
  }
});
