import { useEffect, useState } from 'react';
import { businessDate } from '@/lib/format';
import { useSessionStore } from '@/stores/sessionStore';
import { useTrainingStore } from '@/stores/trainingStore';
import { useUiStore } from '@/stores/uiStore';

/**
 * Session périmée (0.4.0, lot 2) : ouverte un jour précédent (date métier Europe/Paris). Le
 * serveur refuse alors toute vente (`SESSION_STALE`) tant que son Z1 n'est pas établi.
 */
export function isSessionStale(
  openedAt: string | null | undefined,
  now: Date | number = new Date(),
): boolean {
  if (!openedAt) return false;
  const opened = businessDate(openedAt);
  const today = businessDate(now);
  return opened !== '' && today !== '' && opened < today;
}

/**
 * Vrai si la session ouverte est périmée : date locale (réévaluée chaque minute, passage de
 * minuit) ou refus serveur `SESSION_STALE` reçu pour cette session (horloge du poste fausse).
 * Jamais en mode formation (aucune session réelle).
 */
export function useSessionStale(): boolean {
  const session = useSessionStore((s) => s.session);
  const training = useTrainingStore((s) => s.active);
  const flagged = useUiStore((s) => s.staleSessionId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  if (!session || training) return false;
  return flagged === session.id || isSessionStale(session.opened_at, now);
}
