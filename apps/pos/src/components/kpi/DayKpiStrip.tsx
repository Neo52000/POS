import { useMemo } from 'react';
import { computeDayKpi } from '@/lib/dayKpi';
import { formatEurCents } from '@/lib/format';
import { weatherEmoji, weatherKind, WEATHER_LABELS } from '@/lib/weather';
import type { ForecastDay } from '@/lib/weather';
import { useShopWeather } from '@/hooks/useShopWeather';
import type { PosTransaction } from '@/types/pos';

export interface DayKpiStripProps {
  tickets: readonly PosTransaction[] | undefined;
}

function Kpi({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="text-2xl font-semibold tabular" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

const deg = (v: number) => `${Math.round(v)}°`;

function WeatherToday({ today, tomorrow }: { today: ForecastDay; tomorrow?: ForecastDay }) {
  const label = WEATHER_LABELS[weatherKind(today.weathercode, today.precipitation_mm)];
  return (
    <div className="flex items-center gap-3" data-testid="kpi-weather">
      <span className="text-4xl" role="img" aria-label={label}>
        {weatherEmoji(today)}
      </span>
      <div className="min-w-0">
        <p className="font-medium">
          {label} · {deg(today.tmin)} / {deg(today.tmax)}
        </p>
        <p className="text-sm text-muted">
          {today.precipitation_probability !== null
            ? `Risque de pluie ${today.precipitation_probability} %`
            : 'Chaumont'}
          {tomorrow && ` · demain ${weatherEmoji(tomorrow)} ${deg(tomorrow.tmax)}`}
        </p>
      </div>
    </div>
  );
}

/**
 * Encart « KPI du jour » : météo de la boutique + CA net, tickets, panier moyen de la caisse.
 * L'analyse ventes × météo (historique, prévision de CA) est sur le dashboard admin du site.
 */
export function DayKpiStrip({ tickets }: DayKpiStripProps) {
  const kpi = useMemo(() => computeDayKpi(tickets ?? []), [tickets]);
  const weather = useShopWeather();
  const [today, tomorrow] = weather.data?.days ?? [];

  return (
    <div
      className="grid grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))] items-center gap-4 rounded-2xl border border-border bg-surface px-4 py-3"
      data-testid="day-kpi"
    >
      {today ? (
        <WeatherToday today={today} tomorrow={tomorrow} />
      ) : (
        <p className="text-sm text-muted">Météo indisponible</p>
      )}
      <Kpi label="CA du jour" value={formatEurCents(kpi.net_ttc_cents)} testId="kpi-net" />
      <Kpi label="Tickets" value={String(kpi.sales_count)} testId="kpi-tickets" />
      <Kpi label="Panier moyen" value={formatEurCents(kpi.avg_basket_cents)} testId="kpi-basket" />
    </div>
  );
}
