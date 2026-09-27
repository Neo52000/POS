import { describe, expect, it } from 'vitest';
import { computeDayKpi } from './dayKpi';
import type { PosTransaction } from '@/types/pos';

const t = (kind: 'sale' | 'refund', total: number | string) =>
  ({ kind, total_ttc_cents: total }) as unknown as PosTransaction;

describe('computeDayKpi', () => {
  it('CA net, tickets de vente, panier moyen et remboursements', () => {
    const kpi = computeDayKpi([
      t('sale', 1000),
      t('sale', '2450'),
      t('refund', -450),
      t('sale', 551),
    ]);
    expect(kpi).toEqual({
      net_ttc_cents: 1000 + 2450 + 551 - 450,
      sales_count: 3,
      refunds_count: 1,
      refunds_ttc_cents: 450,
      avg_basket_cents: Math.round((1000 + 2450 + 551) / 3),
    });
  });

  it('journée vide : zéros, sans division par zéro', () => {
    expect(computeDayKpi([])).toEqual({
      net_ttc_cents: 0,
      sales_count: 0,
      refunds_count: 0,
      refunds_ttc_cents: 0,
      avg_basket_cents: 0,
    });
  });
});
