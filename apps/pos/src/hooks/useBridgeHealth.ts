import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { bridge } from '@/lib/bridge';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

export const BRIDGE_HEALTH_INTERVAL_MS = 15_000;

/** Sonde `/health` du pont toutes les 15 s et alimente `uiStore.bridgeStatus`. */
export function useBridgeHealth(enabled = true) {
  const bridgeUrl = useSettingsStore((s) => s.bridgeUrl);
  const setBridgeHealth = useUiStore((s) => s.setBridgeHealth);
  const query = useQuery({
    queryKey: ['bridge', 'health', bridgeUrl],
    queryFn: () => bridge.health(),
    enabled,
    refetchInterval: BRIDGE_HEALTH_INTERVAL_MS,
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    if (query.data) {
      setBridgeHealth({
        ok: query.data.ok,
        version: query.data.version,
        tpe: query.data.tpe?.reachable,
        printer: query.data.printer?.reachable,
        simulate: query.data.simulate,
      });
    } else if (query.isError) {
      setBridgeHealth(null);
    }
  }, [query.data, query.isError, setBridgeHealth]);

  return query;
}
