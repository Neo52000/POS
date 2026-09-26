import { describe, expect, it } from 'vitest';
import { sanitizeProducts } from './catalog';

const OK = {
  id: 'p1',
  name: 'Stylo',
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

describe('sanitizeProducts', () => {
  it('conserve un produit valide et arrondit des centimes numériques', () => {
    const [p] = sanitizeProducts([{ ...OK, price_ttc_cents: '119.6', vat_rate: '5.5' }]);
    expect(p?.price_ttc_cents).toBe(120);
    expect(p?.vat_rate).toBe(5.5);
  });
  it('complète les champs optionnels manquants', () => {
    const [p] = sanitizeProducts([
      { id: 'p2', name: 'Cahier', price_ttc_cents: 245, vat_rate: 20 },
    ]);
    expect(p).toMatchObject({ brand: null, ean: null, eco_tax_cents: 0, pos_price_tiers: null });
  });
  it('écarte les lignes au prix ou à la TVA inexploitables', () => {
    const rows = [
      OK,
      { ...OK, id: 'bad-vat', vat_rate: 19.6 },
      { ...OK, id: 'null-vat', vat_rate: null },
      { ...OK, id: 'neg', price_ttc_cents: -5 },
      { ...OK, id: 'nan', price_ttc_cents: 'abc' },
    ];
    expect(sanitizeProducts(rows).map((p) => p.id)).toEqual(['p1']);
  });
});
