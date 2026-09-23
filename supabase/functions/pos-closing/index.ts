// Clôtures mensuelle / annuelle (ou journalière forcée) : agrège via pos_compute_closing.
// Appel cron (service role) ou vendeur/admin.
import { z } from 'npm:zod@3';
import { requirePos } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';

const Schema = z.object({
  register_id: z.string().uuid().optional(),
  period_type: z.enum(['daily', 'monthly', 'annual']),
  // Début de période (ISO). Par défaut : période précédente complète (mois/année passés).
  period_start: z.string().datetime({ offset: true }).optional(),
});

function parisOffsetIso(d: Date): string {
  return d.toISOString();
}

function defaultPeriod(type: 'daily' | 'monthly' | 'annual'): { start: Date; end: Date } {
  const now = new Date();
  if (type === 'daily') {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start: new Date(end.getTime() - 86_400_000), end };
  }
  if (type === 'monthly') {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return { start, end };
  }
  const end = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const start = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));
  return { start, end };
}

function addPeriod(start: Date, type: 'daily' | 'monthly' | 'annual'): Date {
  if (type === 'daily') return new Date(start.getTime() + 86_400_000);
  if (type === 'monthly') return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return new Date(Date.UTC(start.getUTCFullYear() + 1, 0, 1));
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    const auth = await requirePos(req);
    const parsed = Schema.safeParse(req.method === 'POST' ? await readJson(req) : {});
    if (!parsed.success) throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    const { period_type } = parsed.data;
    const period = parsed.data.period_start
      ? { start: new Date(parsed.data.period_start), end: addPeriod(new Date(parsed.data.period_start), period_type) }
      : defaultPeriod(period_type);

    let registerIds: string[] = [];
    if (parsed.data.register_id) registerIds = [parsed.data.register_id];
    else {
      const { data, error } = await auth.db.from('pos_registers').select('id').eq('is_active', true);
      if (error) throw error;
      registerIds = (data ?? []).map((r: { id: string }) => r.id);
    }

    const closings = [];
    for (const registerId of registerIds) {
      const { data, error } = await auth.db.rpc('pos_compute_closing', {
        p_register_id: registerId,
        p_period_type: period_type,
        p_period_start: parisOffsetIso(period.start),
        p_period_end: parisOffsetIso(period.end),
        p_session_id: null,
        p_created_by: auth.userId,
      });
      if (error) throw error;
      closings.push(data);
    }
    return json(200, { period_type, period_start: period.start.toISOString(), period_end: period.end.toISOString(), closings });
  } catch (e) {
    return errorResponse(e);
  }
});
