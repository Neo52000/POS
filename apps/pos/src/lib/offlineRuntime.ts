import { isOffline, onConnectivityTransition, startConnectivityMonitor } from '@/lib/connectivity';
import { logEvent, replayEvents } from '@/lib/events';
import { DELTA_SYNC_INTERVAL_MS, syncCatalog } from '@/lib/offlineCatalog';
import {
  hasPendingQueue,
  queueStats,
  refreshClientSettings,
  replayQueue,
} from '@/lib/offlineQueue';
import { refreshTicketSettings } from '@/lib/ticketSettings';
import { db } from '@/lib/db';

/** Intervalle de rejeu automatique tant que des ventes attendent. */
export const REPLAY_INTERVAL_MS = 30_000;
/** Délai avant la première synchro catalogue après connexion (ne bloque jamais l'UI). */
const CATALOG_FIRST_SYNC_DELAY_MS = 500;

let persistRequested = false;

/** Demande (une fois) un stockage persistant pour IndexedDB (file hors ligne, catalogue). */
export function requestPersistentStorage(): void {
  if (persistRequested) return;
  persistRequested = true;
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    // API absente
  }
}

/**
 * Services hors ligne d'une session connectée : sonde de connectivité, journalisation
 * offline_enter / offline_exit, rejeu de la file (au retour en ligne et toutes les 30 s),
 * réglages client, synchro catalogue (au démarrage puis toutes les 30 min).
 * Renvoie la fonction d'arrêt.
 */
export function startOfflineRuntime(): () => void {
  requestPersistentStorage();

  const unsubscribe = onConnectivityTransition((t) => {
    if (t.to === 'offline') {
      void logEvent('offline_enter', { reason: t.reason }, { clientAt: t.since ?? t.at });
      return;
    }
    void (async () => {
      const stats = await queueStats().catch(() => null);
      const durationS = t.since
        ? Math.max(0, Math.round((Date.parse(t.at) - Date.parse(t.since)) / 1000))
        : null;
      await logEvent('offline_exit', {
        since: t.since,
        duration_s: durationS,
        pending_sales: stats?.pending ?? null,
      });
      await refreshClientSettings();
      await replayQueue();
      await refreshTicketSettings();
    })();
  });

  const stopMonitor = startConnectivityMonitor();

  // Démarrage : réglages, puis rejeu éventuel (file laissée par une session précédente).
  void (async () => {
    if (isOffline()) return;
    await refreshClientSettings();
    await refreshTicketSettings();
    if (await hasPendingQueue()) await replayQueue();
    else if ((await db.events.where('status').equals('pending').count()) > 0) await replayEvents();
  })();

  const replayTimer = setInterval(() => {
    if (isOffline()) return;
    void (async () => {
      if (await hasPendingQueue()) await replayQueue();
      else if ((await db.events.where('status').equals('pending').count()) > 0)
        await replayEvents();
    })();
  }, REPLAY_INTERVAL_MS);

  const runCatalogSync = (): void => {
    if (isOffline()) return;
    void syncCatalog();
  };
  const firstSync = setTimeout(runCatalogSync, CATALOG_FIRST_SYNC_DELAY_MS);
  const catalogTimer = setInterval(runCatalogSync, DELTA_SYNC_INTERVAL_MS);

  return () => {
    unsubscribe();
    stopMonitor();
    clearInterval(replayTimer);
    clearTimeout(firstSync);
    clearInterval(catalogTimer);
  };
}
