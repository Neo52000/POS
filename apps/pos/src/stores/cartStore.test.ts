import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/events', () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/edge', () => ({
  edge: { resolvePrices: vi.fn(async () => []) },
}));

import { logEvent } from '@/lib/events';
import { selectTotals, useCartStore } from './cartStore';
import { useCustomerStore } from './customerStore';
import { MAX_PARKED, useParkedStore } from './parkedStore';
import type { PosProduct } from '@/types/pos';

const BIC: PosProduct = {
  id: 'a0000000-0000-4000-8000-000000000001',
  name: 'Stylo BIC',
  brand: 'BIC',
  ean: '3086123101227',
  image_url: null,
  price_ttc_cents: 120,
  price_ht_cents: 100,
  vat_rate: 20,
  eco_tax_cents: 0,
  stock_boutique: 5,
  pos_price_tiers: null,
};

const LIVRE: PosProduct = {
  ...BIC,
  id: 'a0000000-0000-4000-8000-000000000005',
  name: 'Livre',
  ean: null,
  price_ttc_cents: 790,
  vat_rate: 5.5,
};

describe('cartStore', () => {
  beforeEach(() => {
    localStorage.clear();
    useCartStore.setState({ lines: [], quote_id: null, locked: false });
    useParkedStore.setState({ parked: [] });
    useCustomerStore.setState({
      account: null,
      pricing: {},
      quotes: [],
      resolving: false,
      error: null,
    });
    vi.mocked(logEvent).mockClear();
  });

  it('fusionne les ajouts du même produit au même prix', () => {
    const s = useCartStore.getState();
    s.addProduct(BIC);
    s.addProduct(BIC);
    s.addProduct(BIC, { qty: 3 });
    const lines = useCartStore.getState().lines;
    expect(lines).toHaveLength(1);
    expect(lines[0]?.qty).toBe(5);
    expect(lines[0]?.line_no).toBe(1);
    expect(lines[0]?.vat_rate).toBe('20.00');
    expect(lines[0]?.public_price_ttc_cents).toBe(120);
  });

  it('crée une nouvelle ligne si le prix diffère (palier)', () => {
    const s = useCartStore.getState();
    s.addProduct(BIC);
    s.addProduct(BIC, { unit_price_ttc_cents: 100, price_tier_title: 'Lot' });
    const lines = useCartStore.getState().lines;
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.line_no)).toEqual([1, 2]);
    expect(lines[1]?.price_tier_title).toBe('Lot');
  });

  it('gère quantité, remise et totaux (SPEC §2)', () => {
    const s = useCartStore.getState();
    const line = s.addProduct(BIC, { qty: 2 });
    s.setDiscount(line.key, 10);
    s.addProduct(LIVRE);
    const totals = selectTotals(useCartStore.getState());
    // 120 × 0.9 = 108 × 2 = 216 (HT 180, TVA 36) ; livre 790 (HT 749, TVA 41)
    expect(totals.total_ttc_cents).toBe(216 + 790);
    expect(totals.vat_breakdown.map((v) => v.rate)).toEqual(['5.50', '20.00']);
    expect(totals.vat_breakdown[1]?.vat_cents).toBe(36);
    s.setQty(line.key, 0.5);
    expect(useCartStore.getState().lines[0]?.qty).toBe(0.5);
    s.setQty(line.key, 0);
    expect(useCartStore.getState().lines).toHaveLength(1);
    expect(useCartStore.getState().lines[0]?.line_no).toBe(1);
  });

  it('ligne libre et prix forcé', () => {
    const s = useCartStore.getState();
    const free = s.addFreeLine({
      label: 'Photocopies',
      unit_price_ttc_cents: 20,
      vat_rate: 20,
      qty: 10,
    });
    expect(free.product_id).toBeNull();
    s.setUnitPrice(free.key, 30);
    expect(useCartStore.getState().lines[0]?.unit_price_ttc_cents).toBe(30);
    expect(selectTotals(useCartStore.getState()).total_ttc_cents).toBe(300);
  });

  it('journalise line_deleted à la suppression et sale_abandoned au vidage', () => {
    const s = useCartStore.getState();
    const a = s.addProduct(BIC);
    s.addProduct(LIVRE);
    s.remove(a.key);
    expect(logEvent).toHaveBeenCalledWith(
      'line_deleted',
      expect.objectContaining({ product_id: BIC.id, qty: 1 }),
    );
    expect(useCartStore.getState().lines).toHaveLength(1);
    s.clear('abandoned');
    expect(logEvent).toHaveBeenCalledWith(
      'sale_abandoned',
      expect.objectContaining({ reason: 'abandoned', lines: 1, total_ttc_cents: 790 }),
    );
    expect(useCartStore.getState().lines).toHaveLength(0);
  });

  it('ne journalise pas sale_abandoned pour une vente terminée ni pour un panier vide', () => {
    const s = useCartStore.getState();
    s.clear('abandoned');
    s.addProduct(BIC);
    s.clear('sale_completed');
    expect(logEvent).not.toHaveBeenCalledWith('sale_abandoned', expect.anything());
  });

  it('applique et restaure les tarifs pro', () => {
    const s = useCartStore.getState();
    const line = s.addProduct(BIC);
    s.applyPricing({
      [BIC.id]: {
        product_id: BIC.id,
        qty: 1,
        unit_price_ht_cents: 90,
        unit_price_ttc_cents: 108,
        vat_rate: 20,
        rule_id: 'e0000000-0000-4000-8000-000000000001',
        rule_scope: 'product',
        rule_mode: 'percent',
        rule_value: 10,
        public_price_ht_cents: 100,
      },
    });
    let l = useCartStore.getState().lines[0];
    expect(l?.unit_price_ttc_cents).toBe(108);
    expect(l?.pricing_rule_id).toBe('e0000000-0000-4000-8000-000000000001');
    expect(l?.public_price_ttc_cents).toBe(120);
    s.restorePublicPrices();
    l = useCartStore.getState().lines[0];
    expect(l?.key).toBe(line.key);
    expect(l?.unit_price_ttc_cents).toBe(120);
    expect(l?.pricing_rule_id).toBeNull();
  });

  it('refuse une quantité invalide et accepte les décimales (3 max)', () => {
    const s = useCartStore.getState();
    expect(() => s.addProduct(BIC, { qty: 0 })).toThrow('Quantité invalide');
    expect(() => s.addProduct(BIC, { qty: -2 })).toThrow('Quantité invalide');
    expect(() => s.addProduct(BIC, { qty: Number.NaN })).toThrow('Quantité invalide');
    expect(() =>
      s.addFreeLine({ label: 'X', unit_price_ttc_cents: 100, vat_rate: 20, qty: 0 }),
    ).toThrow();
    expect(useCartStore.getState().lines).toHaveLength(0);
    const line = s.addProduct(BIC, { qty: 1.23456 });
    expect(line.qty).toBe(1.235);
    s.setQty(line.key, Number.NaN);
    expect(useCartStore.getState().lines[0]?.qty).toBe(1.235);
  });

  it('journalise remise, prix forcé et baisse de quantité', () => {
    const s = useCartStore.getState();
    const line = s.addProduct(BIC, { qty: 3 });
    s.setDiscount(line.key, 15);
    expect(logEvent).toHaveBeenCalledWith(
      'line_discount',
      expect.objectContaining({ from_percent: 0, to_percent: 15 }),
    );
    s.setUnitPrice(line.key, 99);
    expect(logEvent).toHaveBeenCalledWith(
      'price_override',
      expect.objectContaining({ from_cents: 120, to_cents: 99 }),
    );
    s.setQty(line.key, 2);
    expect(logEvent).toHaveBeenCalledWith(
      'qty_decreased',
      expect.objectContaining({ from_qty: 3, to_qty: 2 }),
    );
    vi.mocked(logEvent).mockClear();
    s.setQty(line.key, 5);
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('fusionne un nouveau scan avec une ligne passée au tarif pro', () => {
    const s = useCartStore.getState();
    s.addProduct(BIC);
    s.applyPricing({
      [BIC.id]: {
        product_id: BIC.id,
        qty: 1,
        unit_price_ht_cents: 90,
        unit_price_ttc_cents: 108,
        vat_rate: 20,
        rule_id: 'rule',
        rule_scope: 'product',
        rule_mode: 'percent',
        rule_value: 10,
        public_price_ht_cents: 100,
      },
    });
    s.addProduct(BIC);
    expect(useCartStore.getState().lines).toHaveLength(1);
    expect(useCartStore.getState().lines[0]?.qty).toBe(2);
  });

  it('persiste le panier dans localStorage', () => {
    useCartStore.getState().addProduct(BIC, { qty: 2 });
    const raw = JSON.parse(localStorage.getItem('pos.cart.v1') ?? '{}') as {
      state?: { lines?: Array<{ qty: number }> };
    };
    expect(raw.state?.lines?.[0]?.qty).toBe(2);
  });

  it('met en attente puis rappelle un panier (échange avec le panier courant)', () => {
    const s = useCartStore.getState();
    s.addProduct(BIC, { qty: 2 });
    expect(useParkedStore.getState().park()).toBe(true);
    expect(useCartStore.getState().lines).toHaveLength(0);
    expect(logEvent).toHaveBeenCalledWith(
      'sale_parked',
      expect.objectContaining({ lines: 1, total_ttc_cents: 240 }),
    );
    expect(logEvent).not.toHaveBeenCalledWith('sale_abandoned', expect.anything());

    s.addProduct(LIVRE);
    const first = useParkedStore.getState().parked[0];
    expect(useParkedStore.getState().recall(first?.id ?? '')).toBe(true);
    expect(useCartStore.getState().lines.map((l) => l.label)).toEqual(['Stylo BIC']);
    // Le panier « Livre » a pris sa place en attente.
    expect(useParkedStore.getState().parked.map((p) => p.lines[0]?.label)).toEqual(['Livre']);
    expect(logEvent).toHaveBeenCalledWith('sale_recalled', expect.objectContaining({ lines: 1 }));
  });

  it('limite le nombre de tickets en attente et trace leur suppression', () => {
    for (let i = 0; i < MAX_PARKED; i++) {
      useCartStore.getState().addProduct(BIC);
      expect(useParkedStore.getState().park()).toBe(true);
    }
    useCartStore.getState().addProduct(BIC);
    expect(useParkedStore.getState().park()).toBe(false);
    expect(useCartStore.getState().lines).toHaveLength(1);
    const id = useParkedStore.getState().parked[0]?.id ?? '';
    useParkedStore.getState().discard(id);
    expect(useParkedStore.getState().parked).toHaveLength(MAX_PARKED - 1);
    expect(logEvent).toHaveBeenCalledWith(
      'sale_abandoned',
      expect.objectContaining({ reason: 'parked_discarded' }),
    );
  });
});
