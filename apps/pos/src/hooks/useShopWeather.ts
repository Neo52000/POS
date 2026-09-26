import { useQuery } from '@tanstack/react-query';
import { env } from '@/lib/env';
import { fetchShopWeather } from '@/lib/weather';
import type { WeatherSnapshot } from '@/lib/weather';
import { useUiStore } from '@/stores/uiStore';

/** Relevé fixe du mode e2e (aucun appel réseau vers Open-Meteo). */
const MOCK_WEATHER: WeatherSnapshot = {
  fetched_at: '2026-09-26T06:00:00.000Z',
  days: [
    {
      date: '2026-09-26',
      tmin: 9,
      tmax: 16,
      precipitation_mm: 4.2,
      precipitation_probability: 80,
      weathercode: 61,
    },
    {
      date: '2026-09-27',
      tmin: 7,
      tmax: 19,
      precipitation_mm: 0,
      precipitation_probability: 10,
      weathercode: 1,
    },
  ],
};

/** Météo de la boutique (encart KPI du jour) : cache 1 h, jamais bloquante. */
export function useShopWeather() {
  const offline = useUiStore((s) => s.connectivity === 'offline');
  return useQuery({
    queryKey: ['shop-weather', offline],
    queryFn: () => (env.e2eMock ? Promise.resolve(MOCK_WEATHER) : fetchShopWeather({ offline })),
    staleTime: 30 * 60_000,
    refetchInterval: 60 * 60_000,
    retry: false,
  });
}
