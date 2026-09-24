import { env } from '@/lib/env';
import { isMockOffline } from '@/lib/mocks/mockNetwork';
import { useUiStore } from '@/stores/uiStore';

/**
 * Connectivité au projet Supabase « Pos » (lot 4). Sonde `GET /auth/v1/health` toutes les 15 s
 * hors ligne et toutes les 60 s en ligne, pilotée aussi par les événements `online`/`offline`
 * du navigateur et par toute erreur NETWORK/TIMEOUT d'une Edge Function.
 */

export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_INTERVAL_OFFLINE_MS = 15_000;
export const PROBE_INTERVAL_ONLINE_MS = 60_000;

export interface ConnectivityTransition {
  to: 'online' | 'offline';
  /** Début réel de la période hors ligne (ISO). */
  since: string | null;
  /** Instant de la transition (ISO). */
  at: string;
  reason: string;
}

type Listener = (t: ConnectivityTransition) => void;

const listeners = new Set<Listener>();
/** Dernier état notifié aux écouteurs (évite les doublons offline_enter / offline_exit). */
let reported: 'online' | 'offline' = 'online';
let monitorStarted = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let probing: Promise<boolean> | null = null;

export function onConnectivityTransition(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function emit(t: ConnectivityTransition): void {
  for (const l of listeners) {
    try {
      l(t);
    } catch (e) {
      console.warn('[connectivity] écouteur en erreur', e);
    }
  }
}

export function isOffline(): boolean {
  return useUiStore.getState().connectivity === 'offline';
}

/** Sonde de santé : `true` si le serveur répond (statut < 500) dans le délai. */
export async function probeHealth(): Promise<boolean> {
  if (env.e2eMock) return !isMockOffline();
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (!env.supabaseUrl) return true;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${env.supabaseUrl}/auth/v1/health`, {
      method: 'GET',
      headers: { apikey: env.supabaseAnonKey },
      cache: 'no-store',
      signal: controller.signal,
    });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/** Passe hors ligne (idempotent). `since` = début réel si connu. */
export function markOffline(reason: string, since?: string): void {
  const st = useUiStore.getState();
  const at = new Date().toISOString();
  if (st.connectivity !== 'offline') st.setConnectivity('offline', since ?? at);
  if (reported !== 'offline') {
    reported = 'offline';
    emit({ to: 'offline', since: useUiStore.getState().offlineSince ?? at, at, reason });
  }
  reschedule();
}

/** Repasse en ligne (idempotent). */
export function markOnline(reason = 'probe'): void {
  const st = useUiStore.getState();
  const since = st.offlineSince;
  if (st.connectivity === 'offline') st.setConnectivity('online');
  if (reported === 'offline') {
    reported = 'online';
    emit({ to: 'online', since, at: new Date().toISOString(), reason });
  }
  reschedule();
}

/** Erreur NETWORK/TIMEOUT d'une Edge Function : bascule hors ligne immédiatement. */
export function reportNetworkFailure(reason = 'edge'): void {
  markOffline(reason);
}

/** Sonde immédiate (mutualisée si une sonde est déjà en cours). */
export function probeNow(): Promise<boolean> {
  if (probing) return probing;
  probing = (async () => {
    const ok = await probeHealth();
    if (ok) markOnline('probe');
    else markOffline('probe');
    return ok;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

function reschedule(): void {
  if (!monitorStarted) return;
  if (timer) clearTimeout(timer);
  const delay = isOffline() ? PROBE_INTERVAL_OFFLINE_MS : PROBE_INTERVAL_ONLINE_MS;
  timer = setTimeout(() => {
    void probeNow().finally(reschedule);
  }, delay);
}

/** Démarre la surveillance (écouteurs navigateur + sonde périodique). Renvoie la fonction d'arrêt. */
export function startConnectivityMonitor(): () => void {
  if (monitorStarted) return () => undefined;
  monitorStarted = true;
  const on = (): void => {
    void probeNow();
  };
  const off = (): void => markOffline('browser');
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  // État initial connu hors ligne (navigateur) : notifier pour journaliser offline_enter.
  if (isOffline()) markOffline('startup', useUiStore.getState().offlineSince ?? undefined);
  void probeNow();
  reschedule();
  return () => {
    monitorStarted = false;
    if (timer) clearTimeout(timer);
    timer = null;
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
}

/** Réinitialisation (tests). */
export function resetConnectivityForTests(): void {
  reported = 'online';
  listeners.clear();
  useUiStore.getState().setConnectivity('online');
}
