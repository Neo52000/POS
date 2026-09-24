import type { CheckoutPayload, TicketPayload } from '@pos/core';
import { ApiError, describeApiError, isApiError, isNetworkFailure } from '@/lib/apiError';
import { markOffline } from '@/lib/connectivity';
import { db, getMeta, replaceReceipt, saveReceipt, setMeta } from '@/lib/db';
import type { QueuedCheckout } from '@/lib/db';
import { edge } from '@/lib/edge';
import { logEvent, logEventNow, replayEvents } from '@/lib/events';
import { businessDate } from '@/lib/format';
import { queryClient } from '@/lib/queryClient';
import { supabase } from '@/lib/supabase';
import { buildProvisionalTicket } from '@/lib/ticket';
import type { ProvisionalTicketContext } from '@/lib/ticket';
import { useUiStore } from '@/stores/uiStore';
import type { PosClientSettings } from '@/types/pos';

/**
 * File des ventes hors ligne (lot 4) : référence provisoire `OFF-<caisse>-<YYYYMMDD>-<nnn>`,
 * limites (`pos_client_settings`), rejeu FIFO idempotent (`client_txn_id`) vers `pos-checkout`.
 */

// ---------------------------------------------------------------------------
// Réglages / limites
// ---------------------------------------------------------------------------

export interface OfflineLimits {
  offline_max_txns: number;
  offline_max_hours: number;
}

export const DEFAULT_OFFLINE_LIMITS: OfflineLimits = {
  offline_max_txns: 50,
  offline_max_hours: 24,
};

export interface CachedClientSettings extends PosClientSettings {
  fetched_at: string;
  /** `server_now − heure locale` au moment de la lecture (ms). */
  clock_skew_ms: number;
}

const CLIENT_SETTINGS_KEY = 'client_settings';

export async function getCachedClientSettings(): Promise<CachedClientSettings | null> {
  return (await getMeta<CachedClientSettings>(CLIENT_SETTINGS_KEY)) ?? null;
}

export async function getOfflineLimits(): Promise<OfflineLimits> {
  const s = await getCachedClientSettings();
  return {
    offline_max_txns: Number(s?.offline_max_txns) || DEFAULT_OFFLINE_LIMITS.offline_max_txns,
    offline_max_hours: Number(s?.offline_max_hours) || DEFAULT_OFFLINE_LIMITS.offline_max_hours,
  };
}

/** Relit `pos_client_settings()` (en ligne) et la met en cache dans `meta`. */
export async function refreshClientSettings(): Promise<CachedClientSettings | null> {
  try {
    const { data, error } = await supabase.rpc('pos_client_settings');
    if (error || !data) return getCachedClientSettings();
    const s = data as PosClientSettings;
    const now = Date.now();
    const serverNow = s.server_now ? new Date(s.server_now).getTime() : now;
    const cached: CachedClientSettings = {
      ...s,
      fetched_at: new Date(now).toISOString(),
      clock_skew_ms: Number.isFinite(serverNow) ? serverNow - now : 0,
    };
    await setMeta(CLIENT_SETTINGS_KEY, cached);
    return cached;
  } catch {
    return getCachedClientSettings();
  }
}

// ---------------------------------------------------------------------------
// Statistiques et limites
// ---------------------------------------------------------------------------

export interface QueueStats {
  /** `pending` + `replaying`. */
  pending: number;
  failed: number;
  done: number;
  /** Éléments en échec abandonnés par un admin (tracés au JET), exclus du blocage du Z. */
  abandoned: number;
  /** `business_at` le plus ancien des ventes en attente. */
  oldestBusinessAt: string | null;
}

export async function queueStats(): Promise<QueueStats> {
  const items = await db.queue.toArray();
  let pending = 0;
  let failed = 0;
  let done = 0;
  let abandoned = 0;
  let oldest: string | null = null;
  for (const it of items) {
    if (it.status === 'pending' || it.status === 'replaying') {
      pending += 1;
      if (!oldest || it.business_at < oldest) oldest = it.business_at;
    } else if (it.status === 'failed') failed += 1;
    else if (it.status === 'abandoned') abandoned += 1;
    else done += 1;
  }
  return { pending, failed, done, abandoned, oldestBusinessAt: oldest };
}

export interface OfflineLimitState {
  blocked: boolean;
  reason: 'max_txns' | 'max_hours' | null;
  message: string | null;
  limits: OfflineLimits;
}

/** Ventes hors ligne bloquées si `pending ≥ max` ou si la plus ancienne dépasse `max_hours`. */
export function evaluateOfflineLimits(
  stats: Pick<QueueStats, 'pending' | 'oldestBusinessAt'>,
  limits: OfflineLimits,
  now: Date = new Date(),
): OfflineLimitState {
  if (stats.pending >= limits.offline_max_txns) {
    return {
      blocked: true,
      reason: 'max_txns',
      message: `${stats.pending} ventes hors ligne en attente (maximum ${limits.offline_max_txns}) : rétablissez la connexion pour les synchroniser.`,
      limits,
    };
  }
  if (
    stats.oldestBusinessAt &&
    now.getTime() - new Date(stats.oldestBusinessAt).getTime() >=
      limits.offline_max_hours * 3600_000
  ) {
    return {
      blocked: true,
      reason: 'max_hours',
      message: `La plus ancienne vente hors ligne a plus de ${limits.offline_max_hours} h : synchronisez avant toute nouvelle vente.`,
      limits,
    };
  }
  return { blocked: false, reason: null, message: null, limits };
}

export async function offlineLimitState(now: Date = new Date()): Promise<OfflineLimitState> {
  const [stats, limits] = await Promise.all([queueStats(), getOfflineLimits()]);
  return evaluateOfflineLimits(stats, limits, now);
}

// ---------------------------------------------------------------------------
// Référence provisoire
// ---------------------------------------------------------------------------

export function formatProvisionalRef(registerCode: string, ymd: string, seq: number): string {
  return `OFF-${registerCode}-${ymd}-${String(seq).padStart(3, '0')}`;
}

/**
 * `OFF-<caisse>-<YYYYMMDD>-<nnn>` : compteur Dexie par caisse, remis à 1 chaque jour
 * (date Europe/Paris). Ne redescend jamais sous une référence déjà présente dans la file.
 */
export async function nextProvisionalRef(
  registerCode: string,
  date: Date = new Date(),
): Promise<string> {
  const ymd = businessDate(date).replace(/-/g, '');
  const key = `provisional_seq:${registerCode}`;
  const prefix = `OFF-${registerCode}-${ymd}-`;
  return db.transaction('rw', db.meta, db.queue, async () => {
    const cur = (await db.meta.get(key))?.value as { day: string; seq: number } | undefined;
    let seq = cur && cur.day === ymd ? cur.seq + 1 : 1;
    const existing = await db.queue
      .filter((q) => !!q.provisional_ref && q.provisional_ref.startsWith(prefix))
      .toArray();
    for (const q of existing) {
      const n = Number(q.provisional_ref?.slice(prefix.length));
      if (Number.isFinite(n) && n >= seq) seq = n + 1;
    }
    await db.meta.put({ key, value: { day: ymd, seq } });
    return formatProvisionalRef(registerCode, ymd, seq);
  });
}

// ---------------------------------------------------------------------------
// Mise en file
// ---------------------------------------------------------------------------

/** Ajoute une vente à la file (idempotent par `client_txn_id`). */
export async function enqueueSale(
  payload: CheckoutPayload,
  opts: { ticket?: TicketPayload | null; error?: string | null } = {},
): Promise<QueuedCheckout> {
  const existing = await db.queue.where('client_txn_id').equals(payload.client_txn_id).first();
  if (existing) return existing;
  const now = new Date().toISOString();
  const item: QueuedCheckout = {
    client_txn_id: payload.client_txn_id,
    payload,
    status: 'pending',
    created_at: now,
    updated_at: now,
    business_at: payload.business_at,
    provisional_ref: payload.provisional_ref ?? null,
    provisional_ticket: opts.ticket ?? null,
    attempts: 0,
    last_error: opts.error ?? null,
    last_error_code: null,
    server_ticket_code: null,
    server_transaction_id: null,
  };
  const local_seq = await db.queue.add(item);
  return { ...item, local_seq };
}

export interface QueuedSaleOutcome {
  ticket: TicketPayload;
  item: QueuedCheckout;
  provisionalRef: string;
}

/**
 * Vente hors ligne : `offline_queued: true`, référence provisoire, mise en file, ticket provisoire
 * (même `client_txn_id`, `business_at` inchangé). `force` : ignore les limites (CB déjà débitée).
 */
export async function queueOfflineSale(
  payload: CheckoutPayload,
  ctx: ProvisionalTicketContext,
  opts: { force?: boolean; error?: string | null } = {},
): Promise<QueuedSaleOutcome> {
  const existing = await db.queue.where('client_txn_id').equals(payload.client_txn_id).first();
  if (existing?.provisional_ticket && existing.provisional_ref) {
    return {
      ticket: existing.provisional_ticket,
      item: existing,
      provisionalRef: existing.provisional_ref,
    };
  }
  if (!opts.force) {
    const lim = await offlineLimitState();
    if (lim.blocked) throw new ApiError('OFFLINE_LIMIT_REACHED', lim.message ?? undefined, lim);
  }
  const ref =
    payload.provisional_ref ??
    (await nextProvisionalRef(ctx.register_code, new Date(payload.business_at)));
  const queued: CheckoutPayload = { ...payload, offline_queued: true, provisional_ref: ref };
  const ticket = buildProvisionalTicket(queued, ctx);
  const item = await enqueueSale(queued, { ticket, error: opts.error ?? null });
  await saveReceipt(payload.client_txn_id, ticket).catch(() => undefined);
  return { ticket, item, provisionalRef: ref };
}

// ---------------------------------------------------------------------------
// Rejeu
// ---------------------------------------------------------------------------

export type ReplayStop = 'network' | 'session_not_open' | 'unauthorized' | 'busy' | null;

export interface ReplayReport {
  attempted: number;
  done: number;
  failed: number;
  stopped: ReplayStop;
}

let replayInFlight = false;

async function withReplayLock(fn: () => Promise<ReplayReport>): Promise<ReplayReport> {
  const busy: ReplayReport = { attempted: 0, done: 0, failed: 0, stopped: 'busy' };
  if (replayInFlight) return busy;
  replayInFlight = true;
  try {
    const locks =
      typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined;
    if (locks && typeof locks.request === 'function') {
      return await locks.request('pos-replay', { ifAvailable: true }, async (lock) =>
        lock ? fn() : busy,
      );
    }
    return await fn();
  } finally {
    replayInFlight = false;
  }
}

/** Rafraîchit le JWT s'il expire dans la minute. */
async function ensureFreshAuth(): Promise<'ok' | 'network' | 'unauthorized'> {
  try {
    const { data } = await supabase.auth.getSession();
    const session = data.session;
    if (!session) return 'unauthorized';
    const exp = session.expires_at;
    if (exp && exp * 1000 - Date.now() < 60_000) {
      const r = await supabase.auth.refreshSession();
      if (r.error) return isNetworkFailure(r.error) ? 'network' : 'unauthorized';
      if (!r.data.session) return 'unauthorized';
    }
    return 'ok';
  } catch (e) {
    return isNetworkFailure(e) ? 'network' : 'unauthorized';
  }
}

async function runReplay(): Promise<ReplayReport> {
  const report: ReplayReport = { attempted: 0, done: 0, failed: 0, stopped: null };
  const ui = useUiStore.getState();
  const items = await db.queue.where('status').anyOf('pending', 'replaying').sortBy('local_seq');
  if (items.length > 0) {
    const auth = await ensureFreshAuth();
    if (auth !== 'ok') {
      report.stopped = auth;
      if (auth === 'unauthorized') ui.setReplayBlock('unauthorized');
      else markOffline('replay');
      return report;
    }
    if (useUiStore.getState().connectivity === 'online') ui.setConnectivity('replaying');
    try {
      for (const item of items) {
        const seq = item.local_seq;
        if (seq == null) continue;
        const now = new Date().toISOString();
        report.attempted += 1;
        await db.queue.update(seq, {
          status: 'replaying',
          attempts: (item.attempts ?? 0) + 1,
          last_attempt_at: now,
          updated_at: now,
        });
        try {
          const res = await edge.checkout(item.payload);
          await db.queue.update(seq, {
            status: 'done',
            server_ticket_code: res.ticket.ticket_code,
            server_transaction_id: res.transaction.id,
            done_at: new Date().toISOString(),
            last_error: null,
            last_error_code: null,
            updated_at: new Date().toISOString(),
          });
          await replaceReceipt(item.client_txn_id, res.transaction.id, res.ticket).catch(
            () => undefined,
          );
          report.done += 1;
        } catch (e) {
          const code = isApiError(e) ? e.code : isNetworkFailure(e) ? 'NETWORK' : 'INTERNAL';
          const message = describeApiError(e);
          if (isNetworkFailure(e)) {
            await db.queue.update(seq, { status: 'pending', last_error: message, updated_at: now });
            report.stopped = 'network';
            markOffline('replay');
            break;
          }
          if (code === 'SESSION_NOT_OPEN' || code === 'UNAUTHORIZED') {
            await db.queue.update(seq, {
              status: 'pending',
              last_error: message,
              last_error_code: code,
              updated_at: now,
            });
            report.stopped = code === 'SESSION_NOT_OPEN' ? 'session_not_open' : 'unauthorized';
            ui.setReplayBlock(report.stopped);
            break;
          }
          await db.queue.update(seq, {
            status: 'failed',
            last_error: message,
            last_error_code: code,
            updated_at: now,
          });
          report.failed += 1;
          void logEvent('offline_replay_failed', {
            client_txn_id: item.client_txn_id,
            provisional_ref: item.provisional_ref,
            code,
            message,
          });
        }
      }
      if (!report.stopped) ui.setReplayBlock(null);
    } finally {
      if (useUiStore.getState().connectivity === 'replaying') ui.setConnectivity('online');
    }
  }
  if (report.stopped !== 'network') await replayEvents().catch(() => undefined);
  if (report.done > 0) void queryClient.invalidateQueries({ queryKey: ['transactions'] });
  return report;
}

/**
 * Rejoue la file en FIFO (`local_seq`), une seule exécution à la fois (Web Locks si disponible).
 * `retry` : remet en attente un élément en échec (`client_txn_id`) ou tous (`'failed'`) avant le rejeu.
 */
export async function replayQueue(opts: { retry?: string } = {}): Promise<ReplayReport> {
  if (opts.retry) {
    const coll =
      opts.retry === 'failed'
        ? db.queue.where('status').equals('failed')
        : db.queue.where('client_txn_id').equals(opts.retry);
    await coll.modify((q) => {
      if (q.status === 'failed') q.status = 'pending';
    });
  }
  return withReplayLock(runReplay);
}

// ---------------------------------------------------------------------------
// Abandon tracé (admin)
// ---------------------------------------------------------------------------

export const ABANDON_REASON_MIN = 10;

/**
 * Abandon d'un élément en échec : l'événement JET `offline_sale_abandoned` (payload complet, motif,
 * dernier code d'erreur) est d'abord enregistré côté serveur — en ligne obligatoire — puis
 * seulement l'élément passe `abandoned` localement (conservé, exclu des compteurs et du Z).
 * Rien n'est supprimé : la preuve reste dans le journal chaîné et archivé. Si la vente doit être
 * comptabilisée, elle est ressaisie en ligne.
 */
export async function abandonQueueItem(
  clientTxnId: string,
  reason: string,
): Promise<QueuedCheckout> {
  const motive = reason.trim();
  if (motive.length < ABANDON_REASON_MIN) {
    throw new ApiError(
      'VALIDATION',
      `Motif obligatoire (${ABANDON_REASON_MIN} caractères minimum)`,
    );
  }
  if (useUiStore.getState().connectivity === 'offline') {
    throw new ApiError(
      'OFFLINE_FORBIDDEN',
      "Abandon impossible hors ligne : la trace doit d'abord être enregistrée au journal",
    );
  }
  const item = await db.queue.where('client_txn_id').equals(clientTxnId).first();
  if (!item || item.local_seq == null) throw new ApiError('NOT_FOUND', 'Élément introuvable');
  if (item.status !== 'failed') {
    throw new ApiError('VALIDATION', 'Seul un élément en échec peut être abandonné');
  }
  await logEventNow('offline_sale_abandoned', {
    client_txn_id: item.client_txn_id,
    provisional_ref: item.provisional_ref,
    business_at: item.business_at,
    last_error_code: item.last_error_code ?? null,
    last_error: item.last_error ?? null,
    attempts: item.attempts,
    reason: motive,
    payload: item.payload,
  });
  const now = new Date().toISOString();
  await db.queue.update(item.local_seq, {
    status: 'abandoned',
    abandoned_at: now,
    abandon_reason: motive,
    updated_at: now,
  });
  return {
    ...item,
    status: 'abandoned',
    abandoned_at: now,
    abandon_reason: motive,
    updated_at: now,
  };
}

export async function hasPendingQueue(): Promise<boolean> {
  return (await db.queue.where('status').anyOf('pending', 'replaying').count()) > 0;
}

/** Export JSON (diagnostic / support) : file, événements en attente, réglages. */
export async function exportQueueJson(): Promise<string> {
  const [queue, events, settings, stats] = await Promise.all([
    db.queue.orderBy('local_seq').toArray(),
    db.events.orderBy('local_seq').toArray(),
    getCachedClientSettings(),
    queueStats(),
  ]);
  return JSON.stringify(
    { exported_at: new Date().toISOString(), stats, settings, queue, events },
    null,
    2,
  );
}
