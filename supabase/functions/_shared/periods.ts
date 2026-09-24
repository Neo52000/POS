// Bornes de périodes fiscales (jour / mois / année) en Europe/Paris, calculées UNIQUEMENT
// côté SQL par la RPC `pos_period_bounds` (fin exclusive) : aucun calcul de fuseau en TS.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ApiError } from './http.ts';

export type PeriodType = 'daily' | 'monthly' | 'annual';

export interface PeriodBounds {
  /** ISO UTC millisecondes (`toISOString`). */
  start: string;
  /** ISO UTC millisecondes, exclusive. */
  end: string;
}

/** Période `type` contenant l'instant `ref` (Europe/Paris). */
export async function periodBounds(
  db: SupabaseClient,
  type: PeriodType,
  ref: Date | string,
): Promise<PeriodBounds> {
  const refIso = new Date(ref).toISOString();
  const { data, error } = await db.rpc('pos_period_bounds', { p_type: type, p_ref: refIso });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as
    | { period_start?: string; period_end?: string }
    | null
    | undefined;
  if (!row?.period_start || !row?.period_end) {
    throw new ApiError('DB_ERROR', 'pos_period_bounds : réponse vide', { type, ref: refIso });
  }
  return {
    start: new Date(row.period_start).toISOString(),
    end: new Date(row.period_end).toISOString(),
  };
}

/** Période complète précédant celle qui contient `now` (ex. le mois dernier, en heure de Paris). */
export async function previousPeriod(
  db: SupabaseClient,
  type: PeriodType,
  now: Date = new Date(),
): Promise<PeriodBounds> {
  const current = await periodBounds(db, type, now);
  return periodBounds(db, type, new Date(new Date(current.start).getTime() - 1));
}
