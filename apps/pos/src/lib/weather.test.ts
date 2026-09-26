import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchShopWeather,
  parseForecast,
  readCachedWeather,
  weatherKind,
  WEATHER_CACHE_KEY,
} from './weather';

const BODY = {
  daily: {
    time: ['2026-09-26', '2026-09-27', '2026-09-28'],
    temperature_2m_max: [14.2, 17.5, null],
    temperature_2m_min: [9.1, 8.0, 7],
    weathercode: [63, 0, 3],
    precipitation_sum: [7.4, null, 0],
    precipitation_probability_max: [90, 5, 20],
  },
};

const NOW = Date.parse('2026-09-26T08:00:00Z');

beforeEach(() => localStorage.clear());

describe('weatherKind', () => {
  it('classe comme le dashboard du site', () => {
    expect(weatherKind(0, 0)).toBe('soleil');
    expect(weatherKind(3, 0)).toBe('nuageux');
    expect(weatherKind(2, 3)).toBe('pluie');
    expect(weatherKind(73, 0)).toBe('neige');
    expect(weatherKind(95, 0)).toBe('orage');
  });
});

describe('parseForecast', () => {
  it('écarte les jours incomplets', () => {
    const days = parseForecast(BODY);
    expect(days.map((d) => d.date)).toEqual(['2026-09-26', '2026-09-27']);
    expect(days[1]).toMatchObject({ precipitation_mm: 0, precipitation_probability: 5 });
  });
});

describe('fetchShopWeather', () => {
  const ok = () =>
    vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(BODY)),
    );

  it('interroge Open-Meteo puis sert le cache pendant une heure', async () => {
    const fetcher = ok();
    const first = await fetchShopWeather({ fetcher, now: () => NOW });
    expect(first?.days).toHaveLength(2);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get('latitude')).toBe('48.1122');
    expect(url.searchParams.get('forecast_days')).toBe('3');

    await fetchShopWeather({ fetcher, now: () => NOW + 30 * 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await fetchShopWeather({ fetcher, now: () => NOW + 61 * 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('hors ligne ou en échec : dernier relevé (même périmé), sinon null', async () => {
    const fail = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await fetchShopWeather({ fetcher: fail, now: () => NOW })).toBeNull();

    await fetchShopWeather({ fetcher: ok(), now: () => NOW });
    const later = NOW + 5 * 3600_000;
    expect((await fetchShopWeather({ fetcher: fail, now: () => later }))?.days).toHaveLength(2);
    const offline = vi.fn();
    expect(
      (await fetchShopWeather({ offline: true, fetcher: offline, now: () => later }))?.days,
    ).toHaveLength(2);
    expect(offline).not.toHaveBeenCalled();
  });

  it('ignore un cache illisible', () => {
    localStorage.setItem(WEATHER_CACHE_KEY, '{oops');
    expect(readCachedWeather()).toBeNull();
  });
});
