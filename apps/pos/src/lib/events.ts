import { isNetworkFailure } from '@/lib/apiError';
import { isOffline, probeNow } from '@/lib/connectivity';
import { db } from '@/lib/db';
import type { QueuedEvent } from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { useSessionStore } from '@/stores/sessionStore';
import type { PosEventType } from '@/types/pos';

type SendOutcome = { kind: 'ok' } | { kind: 'network' } | { kind: 'error'; message: string };

async function sendEvent(ev: QueuedEvent): Promise<SendOutcome> {
  try {
    const { error } = await supabase.rpc('pos_log_event', {
      p_event_type: ev.event_type,
      p_payload: ev.payload,
      p_client_at: ev.client_at,
      p_register_id: ev.register_id,
      p_session_id: ev.session_id,
    });
    if (!error) return { kind: 'ok' };
    if (isNetworkFailure(error)) return { kind: 'network' };
    return { kind: 'error', message: error.message };
  } catch (e) {
    if (isNetworkFailure(e)) return { kind: 'network' };
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

async function hasPendingEvents(): Promise<boolean> {
  return (await db.events.where('status').equals('pending').count()) > 0;
}

/**
 * Journal des événements (JET, `pos_events`) via `pos_log_event`. Non bloquant : une erreur
 * est tracée en console mais n'interrompt jamais l'UI. Hors ligne (ou en cas d'échec réseau),
 * l'événement est mis en file Dexie `events` et rejoué plus tard en FIFO avec son `client_at`
 * d'origine. Tant que des événements attendent, les nouveaux sont aussi mis en file (ordre JET).
 */
export async function logEvent(
  type: PosEventType,
  payload: Record<string, unknown> = {},
  opts: { clientAt?: string } = {},
): Promise<void> {
  const { register, session } = useSessionStore.getState();
  const now = new Date().toISOString();
  const ev: QueuedEvent = {
    event_type: type,
    payload,
    client_at: opts.clientAt ?? now,
    register_id: register?.id ?? null,
    session_id: session?.id ?? null,
    status: 'pending',
    attempts: 0,
    created_at: now,
  };
  try {
    if (isOffline() || (await hasPendingEvents())) {
      await db.events.add(ev);
      if (!isOffline()) void replayEvents();
      return;
    }
    const outcome = await sendEvent(ev);
    if (outcome.kind === 'network') {
      await db.events.add(ev);
      void probeNow();
    } else if (outcome.kind === 'error') {
      console.warn(`[events] ${type}:`, outcome.message);
    }
  } catch (e) {
    console.warn(`[events] ${type}:`, e);
  }
}

export interface EventsReplayReport {
  sent: number;
  failed: number;
  stoppedByNetwork: boolean;
}

let eventsReplaying: Promise<EventsReplayReport> | null = null;

/** Rejoue les événements en attente (FIFO par `local_seq`). Mutualisé si déjà en cours. */
export function replayEvents(): Promise<EventsReplayReport> {
  if (eventsReplaying) return eventsReplaying;
  eventsReplaying = (async () => {
    const report: EventsReplayReport = { sent: 0, failed: 0, stoppedByNetwork: false };
    // Boucle jusqu'à épuisement : des événements ajoutés pendant le rejeu partent aussi.
    for (;;) {
      const pending = await db.events.where('status').equals('pending').sortBy('local_seq');
      if (pending.length === 0) break;
      for (const ev of pending) {
        const outcome = await sendEvent(ev);
        if (outcome.kind === 'network') {
          report.stoppedByNetwork = true;
          return report;
        }
        if (outcome.kind === 'ok') {
          if (ev.local_seq != null) await db.events.delete(ev.local_seq);
          report.sent += 1;
        } else {
          if (ev.local_seq != null) {
            await db.events.update(ev.local_seq, {
              status: 'failed',
              attempts: ev.attempts + 1,
              last_error: outcome.message,
            });
          }
          report.failed += 1;
        }
      }
    }
    return report;
  })().finally(() => {
    eventsReplaying = null;
  });
  return eventsReplaying;
}
