import { useCallback, useEffect, useRef, useState } from 'react';
import { isNetworkFailure } from '@/lib/apiError';
import { isOffline } from '@/lib/connectivity';
import { syncInventory } from '@/lib/inventory';

export type InventorySyncState = 'idle' | 'syncing' | 'ok' | 'offline' | 'error';

export const INVENTORY_SYNC_INTERVAL_MS = 5_000;

/**
 * Synchronise le lot d'inventaire avec le serveur (partagé entre les postes) : à l'ouverture, toutes
 * les 5 s page visible, au retour du réseau et à la demande (`syncNow`, après chaque modification).
 * Hors ligne, la saisie continue en local ; la synchro reprend seule.
 */
export function useInventorySync(enabled: boolean) {
  const [state, setState] = useState<InventorySyncState>('idle');
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const running = useRef(false);
  const again = useRef(false);

  const syncNow = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    if (isOffline()) {
      setState('offline');
      return;
    }
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    setState('syncing');
    try {
      await syncInventory();
      setState('ok');
      setLastSyncAt(new Date());
    } catch (e) {
      setState(isNetworkFailure(e) ? 'offline' : 'error');
    } finally {
      running.current = false;
      if (again.current) {
        again.current = false;
        void syncNow();
      }
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;
    void syncNow();
    const timer = setInterval(() => {
      if (!document.hidden) void syncNow();
    }, INVENTORY_SYNC_INTERVAL_MS);
    const onOnline = (): void => void syncNow();
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, syncNow]);

  return { state, lastSyncAt, syncNow };
}
