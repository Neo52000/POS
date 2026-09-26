/**
 * Météo de la boutique (Chaumont) pour l'encart « KPI du jour ». Open-Meteo : gratuit, sans clé ;
 * seules les coordonnées fixes de la boutique sont envoyées (aucune donnée de vente ni
 * personnelle). Toujours facultative : échec réseau ou hors ligne ⇒ dernier relevé en cache, sinon
 * rien d'affiché. L'analyse ventes × météo vit sur le dashboard admin du site (historique).
 */

export const SHOP_LAT = 48.1122;
export const SHOP_LON = 5.1391;
export const WEATHER_CACHE_KEY = 'pos.weather.v1';
const CACHE_TTL_MS = 60 * 60_000;
const TIMEOUT_MS = 4000;

export interface ForecastDay {
  date: string;
  tmin: number;
  tmax: number;
  precipitation_mm: number;
  precipitation_probability: number | null;
  weathercode: number;
}

export interface WeatherSnapshot {
  fetched_at: string;
  days: ForecastDay[];
}

export type WeatherKind = 'soleil' | 'nuageux' | 'pluie' | 'neige' | 'orage';

export const WEATHER_LABELS: Record<WeatherKind, string> = {
  soleil: 'Ensoleillé',
  nuageux: 'Nuageux',
  pluie: 'Pluie',
  neige: 'Neige',
  orage: 'Orage',
};

/** Même classement que le dashboard du site (`weather-correlation.ts`), pour des libellés cohérents. */
export function weatherKind(code: number, precipitationMm: number): WeatherKind {
  if (code >= 95) return 'orage';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'neige';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || precipitationMm >= 1) {
    return 'pluie';
  }
  if (code >= 2) return 'nuageux';
  return 'soleil';
}

const EMOJI: Record<WeatherKind, string> = {
  soleil: '☀️',
  nuageux: '⛅',
  pluie: '🌧️',
  neige: '🌨️',
  orage: '⛈️',
};

export function weatherEmoji(day: Pick<ForecastDay, 'weathercode' | 'precipitation_mm'>): string {
  return EMOJI[weatherKind(day.weathercode, day.precipitation_mm)];
}

interface DailyBody {
  daily?: {
    time?: string[];
    temperature_2m_max?: (number | null)[];
    temperature_2m_min?: (number | null)[];
    weathercode?: (number | null)[];
    precipitation_sum?: (number | null)[];
    precipitation_probability_max?: (number | null)[];
  };
}

export function parseForecast(body: DailyBody): ForecastDay[] {
  const d = body.daily;
  if (!d?.time) return [];
  return d.time.flatMap((date, i) => {
    const tmax = d.temperature_2m_max?.[i];
    const tmin = d.temperature_2m_min?.[i];
    const weathercode = d.weathercode?.[i];
    if (tmax == null || tmin == null || weathercode == null) return [];
    return [
      {
        date,
        tmin,
        tmax,
        weathercode,
        precipitation_mm: d.precipitation_sum?.[i] ?? 0,
        precipitation_probability: d.precipitation_probability_max?.[i] ?? null,
      },
    ];
  });
}

export function readCachedWeather(): WeatherSnapshot | null {
  try {
    const raw = localStorage.getItem(WEATHER_CACHE_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw) as WeatherSnapshot;
    return Array.isArray(snap.days) && typeof snap.fetched_at === 'string' ? snap : null;
  } catch {
    return null;
  }
}

function writeCache(snap: WeatherSnapshot): void {
  try {
    localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(snap));
  } catch {
    // stockage indisponible : la météo sera simplement relue
  }
}

export interface FetchWeatherOptions {
  offline?: boolean;
  now?: () => number;
  fetcher?: typeof fetch;
}

/**
 * Prévision du jour et des 2 suivants. Cache d'une heure ; hors ligne ou en échec, renvoie le
 * dernier relevé (même périmé) plutôt que rien, sinon `null`.
 */
export async function fetchShopWeather(
  opts: FetchWeatherOptions = {},
): Promise<WeatherSnapshot | null> {
  const now = opts.now ?? Date.now;
  const cached = readCachedWeather();
  if (cached && now() - Date.parse(cached.fetched_at) < CACHE_TTL_MS) return cached;
  if (opts.offline) return cached;

  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(SHOP_LAT));
  url.searchParams.set('longitude', String(SHOP_LON));
  url.searchParams.set(
    'daily',
    'temperature_2m_max,temperature_2m_min,weathercode,precipitation_sum,precipitation_probability_max',
  );
  url.searchParams.set('timezone', 'Europe/Paris');
  url.searchParams.set('forecast_days', '3');
  try {
    const res = await (opts.fetcher ?? fetch)(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return cached;
    const days = parseForecast((await res.json()) as DailyBody);
    if (days.length === 0) return cached;
    const snap = { fetched_at: new Date(now()).toISOString(), days };
    writeCache(snap);
    return snap;
  } catch {
    return cached;
  }
}
