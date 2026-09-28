// Clôtures Z2 (mensuelle) / Z3 (annuelle), ou journalière forcée. Appel cron (service role) ou
// vendeur/admin (écran Rapports). Les bornes de période sont calculées en Europe/Paris par SQL
// (aucun calcul de fuseau en TypeScript).
// - monthly / annual : RPC pos_close_period (garde-fous PERIOD_NOT_ENDED, SESSION_OPEN_IN_PERIOD,
//   NOTHING_TO_CLOSE, idempotence) puis pos_compute_closing. Une caisse bloquée est listée dans
//   `skipped` sans empêcher les autres ; le cron quotidien la rattrape le lendemain.
// - daily : pos_compute_closing sur la période (jamais une période non terminée).
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
  source: z.string().max(40).optional(),
});

/** Refus métier d'une caisse (n'interrompt pas les autres caisses). */
const SKIPPABLE = new Set(['SESSION_OPEN_IN_PERIOD', 'NOTHING_TO_CLOSE', 'PERIOD_NOT_ENDED']);

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
    if (new Date(period.end).getTime() > Date.now()) {
      throw new ApiError('PERIOD_NOT_ENDED', 'Période non terminée', period);
    }

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

    const closings: unknown[] = [];
    const skipped: Array<{ register_id: string; reason: string }> = [];
    for (const registerId of registerIds) {
      if (period_type === 'daily') {
        const { data, error } = await auth.db.rpc('pos_compute_closing', {
          p_register_id: registerId,
          p_period_type: period_type,
          p_period_start: period.start,
          p_period_end: period.end,
          p_session_id: null,
          p_created_by: auth.userId,
        });
        if (error) throw error;
        closings.push({ ...data, already_exists: false });
        continue;
      }
      const { data, error } = await auth.db.rpc('pos_close_period', {
        p_register_id: registerId,
        p_period_type: period_type,
        p_ref: period.start,
        p_created_by: auth.userId,
      });
      if (error) {
        // Une seule caisse demandée : l'erreur métier est renvoyée telle quelle (UI).
        if (SKIPPABLE.has(error.message) && !parsed.data.register_id) {
          skipped.push({ register_id: registerId, reason: error.message });
          continue;
        }
        throw error;
      }
      const result = data as { closing: Record<string, unknown>; already_exists: boolean };
      closings.push({ ...result.closing, already_exists: result.already_exists });
    }
    return json(200, {
      period_type,
      period_start: period.start,
      period_end: period.end,
      closings,
      skipped,
    });
  } catch (e) {
    return errorResponse(e);
  }
});
