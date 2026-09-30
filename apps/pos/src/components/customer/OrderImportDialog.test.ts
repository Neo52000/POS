import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/events', () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/edge', () => ({
  edge: { resolvePrices: vi.fn(async () => []) },
}));

import { MOCK_ORDERS } from '@/lib/mocks/mockData';
import { selectTotals, useCartStore } from '@/stores/cartStore';
import type { CustomerQuoteItem } from '@/types/pos';
import { importOrderIntoCart, orderCartTotalCents } from './OrderImportDialog';

const ORDER = MOCK_ORDERS['c0000000-0000-4000-8000-000000000001']![0]!;
const [CAHIER, RELIURE] = ORDER.items as [CustomerQuoteItem, CustomerQuoteItem];

describe('importOrderIntoCart', () => {
  beforeEach(() => {
    localStorage.clear();
    useCartStore.setState({
      lines: [],
      quote_id: 'stale',
      global_discount_percent: 0,
      locked: false,
    });
  });

  it('remplace le panier par les lignes de la commande + frais de port, tracées « Commande … »', () => {
    importOrderIntoCart(ORDER);
    const { lines, quote_id } = useCartStore.getState();
    expect(quote_id).toBeNull();
    expect(lines.map((l) => [l.label, l.qty, l.unit_price_ttc_cents, l.vat_rate])).toEqual([
      ['Cahier Clairefontaine 96p grands carreaux', 10, 216, '20.00'],
      ['Reliure spirale A4 (atelier)', 2, 270, '20.00'],
      ['Frais de port', 1, 899, '20.00'],
    ]);
    expect(lines.every((l) => l.price_tier_title === 'Commande CO-2026-00529')).toBe(true);
    expect(lines[0]!.product_id).toBe('a0000000-0000-4000-8000-000000000004');
    expect(lines[1]!.product_id).toBeNull();
  });

  it('le total annoncé dans la liste = total du panier après transfert (= total commande)', () => {
    importOrderIntoCart(ORDER);
    const total = selectTotals(useCartStore.getState()).total_ttc_cents;
    expect(orderCartTotalCents(ORDER)).toBe(total);
    expect(total).toBe(3599);
  });

  it('ignore les lignes soldées et l’absence de port', () => {
    importOrderIntoCart({
      ...ORDER,
      shipping_ttc: 0,
      items: [{ ...CAHIER, quantity: 0 }, RELIURE],
    });
    expect(useCartStore.getState().lines.map((l) => l.label)).toEqual([
      'Reliure spirale A4 (atelier)',
    ]);
  });
});
