import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/edge', () => ({ edge: {} }));

import { shopifyDayKpi } from './useShopifyPosHistory';
import type { ShopifyPosOrder } from '@/types/pos';

const o = (total: number, status: string | null): ShopifyPosOrder => ({
  id: String(total),
  name: '#1',
  created_at: '2026-10-31T10:00:00Z',
  financial_status: status,
  total_ttc_cents: total,
  total_tax_cents: 0,
  total_discount_cents: 0,
  payment_methods: [],
  customer_name: null,
  lines: [],
});

describe('KPI d’un jour Shopify POS', () => {
  it('exclut remboursées et annulées, comme le dashboard', () => {
    expect(
      shopifyDayKpi([o(1000, 'paid'), o(500, 'refunded'), o(300, 'voided'), o(2000, 'paid')]),
    ).toEqual({ net_ttc_cents: 3000, orders: 2, avg_basket_cents: 1500 });
  });

  it('jour vide', () => {
    expect(shopifyDayKpi([])).toEqual({ net_ttc_cents: 0, orders: 0, avg_basket_cents: 0 });
  });
});
