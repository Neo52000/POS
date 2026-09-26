import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PosTransaction } from '@/types/pos';

const weatherState: { data: unknown } = { data: undefined };
vi.mock('@/hooks/useShopWeather', () => ({ useShopWeather: () => weatherState }));

import { DayKpiStrip } from './DayKpiStrip';

const t = (kind: 'sale' | 'refund', total: number) =>
  ({ kind, total_ttc_cents: total }) as unknown as PosTransaction;

describe('DayKpiStrip', () => {
  beforeEach(() => {
    weatherState.data = undefined;
  });

  it('affiche CA net, tickets, panier moyen et la météo du jour', () => {
    weatherState.data = {
      fetched_at: '2026-09-26T06:00:00Z',
      days: [
        {
          date: '2026-09-26',
          tmin: 9.4,
          tmax: 15.6,
          precipitation_mm: 4,
          precipitation_probability: 80,
          weathercode: 61,
        },
        {
          date: '2026-09-27',
          tmin: 7,
          tmax: 19,
          precipitation_mm: 0,
          precipitation_probability: 10,
          weathercode: 0,
        },
      ],
    };
    render(<DayKpiStrip tickets={[t('sale', 1000), t('sale', 3000), t('refund', -500)]} />);
    expect(screen.getByTestId('kpi-net')).toHaveTextContent('35,00');
    expect(screen.getByTestId('kpi-tickets')).toHaveTextContent('2');
    expect(screen.getByTestId('kpi-basket')).toHaveTextContent('20,00');
    const weather = screen.getByTestId('kpi-weather');
    expect(weather).toHaveTextContent('Pluie · 9° / 16°');
    expect(weather).toHaveTextContent('Risque de pluie 80 %');
    expect(weather).toHaveTextContent('demain ☀️ 19°');
  });

  it('reste utile sans météo ni ticket', () => {
    render(<DayKpiStrip tickets={undefined} />);
    expect(screen.getByText('Météo indisponible')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-tickets')).toHaveTextContent('0');
  });
});
