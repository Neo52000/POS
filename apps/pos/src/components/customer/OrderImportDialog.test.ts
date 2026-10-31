import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/events', () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/edge', () => ({
  edge: { resolvePrices: vi.fn(async () => []) },
}));

import { MOCK_ORDERS } from '@/lib/mocks/mockData';
import { selectTotals, useCartStore } from '@/stores/cartStore';
import type { CustomerOrder, CustomerQuoteItem } from '@/types/pos';
import {
  importOrderIntoCart,
  importOrdersIntoCart,
  orderCartTotalCents,
} from './OrderImportDialog';

const [ORDER, ORDER_2] = MOCK_ORDERS['c0000000-0000-4000-8000-000000000001']! as [
  CustomerOrder,
  CustomerOrder,
];
const [CAHIER, RELIURE] = ORDER.items as [CustomerQuoteItem, CustomerQuoteItem];

describe('importOrderIntoCart', () => {
  beforeEach(() => {
    localStorage.clear();
    useCartStore.setState({
      lines: [],
      quote_id: 'stale',
      order_ids: [],
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

  it('rattache la commande au panier (réglée après encaissement), effacée au vidage', () => {
    importOrderIntoCart(ORDER);
    expect(useCartStore.getState().order_ids).toEqual([ORDER.id]);
    useCartStore.getState().clear('manual');
    expect(useCartStore.getState().order_ids).toEqual([]);
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

describe('importOrdersIntoCart (encaissement groupé)', () => {
  beforeEach(() => {
    localStorage.clear();
    useCartStore.setState({
      lines: [],
      quote_id: null,
      order_ids: [],
      global_discount_percent: 0,
      locked: false,
    });
  });

  it('regroupe les commandes sur un seul panier, plus ancienne d’abord, lignes tracées par commande', () => {
    importOrdersIntoCart([ORDER_2, ORDER]);
    const { lines, order_ids } = useCartStore.getState();
    expect(order_ids).toEqual([ORDER.id, ORDER_2.id]);
    expect(lines.map((l) => [l.label, l.qty, l.price_tier_title])).toEqual([
      ['Cahier Clairefontaine 96p grands carreaux', 10, 'Commande CO-2026-00529'],
      ['Reliure spirale A4 (atelier)', 2, 'Commande CO-2026-00529'],
      ['Frais de port', 1, 'Commande CO-2026-00529'],
      // Même produit, autre commande : ligne distincte (traçabilité par commande).
      ['Cahier Clairefontaine 96p grands carreaux', 2, 'Commande CO-2026-00541'],
      ['Étiquettes adhésives (lot)', 1, 'Commande CO-2026-00541'],
    ]);
    expect(lines.map((l) => l.line_no)).toEqual([1, 2, 3, 4, 5]);
  });

  it('total du panier = somme des totaux annoncés par commande', () => {
    importOrdersIntoCart([ORDER, ORDER_2]);
    const total = selectTotals(useCartStore.getState()).total_ttc_cents;
    expect(total).toBe(orderCartTotalCents(ORDER) + orderCartTotalCents(ORDER_2));
    expect(total).toBe(3599 + 600);
  });

  it('ignore les commandes sans ligne due ; sélection vide = panier inchangé', () => {
    importOrdersIntoCart([ORDER]);
    importOrdersIntoCart([]);
    expect(useCartStore.getState().order_ids).toEqual([ORDER.id]);
    importOrdersIntoCart([
      { ...ORDER_2, items: ORDER_2.items.map((it) => ({ ...it, quantity: 0 })) },
      ORDER,
    ]);
    expect(useCartStore.getState().order_ids).toEqual([ORDER.id]);
  });
});
