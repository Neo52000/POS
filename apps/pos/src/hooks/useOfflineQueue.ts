import { useEffect, useState } from 'react';
import { db } from '@/lib/db';
import type { QueuedCheckout, QueuedEvent } from '@/lib/db';
import {
  DEFAULT_OFFLINE_LIMITS,
  evaluateOfflineLimits,
  getOfflineLimits,
  queueStats,
} from '@/lib/offlineQueue';
import type { OfflineLimitState, OfflineLimits, QueueStats } from '@/lib/offlineQueue';
import { useLiveQuery } from './useLiveQuery';

const EMPTY_STATS: QueueStats = {
  pending: 0,
  failed: 0,
  done: 0,
  abandoned: 0,
  oldestBusinessAt: null,
};

export interface OfflineQueueState {
  stats: QueueStats;
  limits: OfflineLimits;
  limitState: OfflineLimitState;
  /** Ventes en attente ou en échec. */
  unsynced: number;
}

/** Statistiques réactives de la file hors ligne + état des limites (réévalué chaque minute). */
export function useOfflineQueue(): OfflineQueueState {
  const stats = useLiveQuery(queueStats, [], EMPTY_STATS);
  const limits = useLiveQuery(getOfflineLimits, [], DEFAULT_OFFLINE_LIMITS);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return {
    stats,
    limits,
    limitState: evaluateOfflineLimits(stats, limits, now),
    unsynced: stats.pending + stats.failed,
  };
}

/** Éléments de la file (tous statuts), du plus ancien au plus récent. */
export function useQueueItems(): QueuedCheckout[] {
  return useLiveQuery(() => db.queue.orderBy('local_seq').toArray(), [], []);
}

/** Événements JET en attente / en échec. */
export function useQueuedEvents(): QueuedEvent[] {
  return useLiveQuery(() => db.events.orderBy('local_seq').toArray(), [], []);
}
