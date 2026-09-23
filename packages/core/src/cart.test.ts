import { describe, expect, it } from 'vitest';

import { PAYMENT_METHOD_LABELS, computeCart, computeLine, validatePayments } from './cart.js';
import type { CartLineInput, PaymentInput } from './cart.js';

const line = (overrides: Partial<CartLineInput> = {}): CartLineInput => ({
  line_no: 1,
  label: 'Article',
  qty: 1,
  unit_price_ttc_cents: 1000,
  vat_rate: 20,
  discount_percent: 0,
  ...overrides,
});

describe('computeLine', () => {
  it('1 ligne 20 % à 10,00 € → HT 833, TVA 167', () => {
    const l = computeLine(line());
    expect(l.unit_after_discount_cents).toBe(1000);
    expect(l.line_ttc_cents).toBe(1000);
    expect(l.line_ht_cents).toBe(833);
    expect(l.line_vat_cents).toBe(167);
    expect(l.unit_price_ht_cents).toBe(833);
    expect(l.vat_rate).toBe('20.00');
    expect(l.discount_percent).toBe(0);
    expect(l.eco_tax_cents).toBe(0);
  });

  it('3 × 2,50 € à 5,5 %', () => {
    const l = computeLine(line({ qty: 3, unit_price_ttc_cents: 250, vat_rate: '5.5' }));
    expect(l.line_ttc_cents).toBe(750);
    expect(l.line_ht_cents).toBe(711);
    expect(l.line_vat_cents).toBe(39);
    expect(l.unit_price_ht_cents).toBe(237);
    expect(l.vat_rate).toBe('5.50');
  });

  it('remise 10 %', () => {
    const l = computeLine(line({ discount_percent: 10 }));
    expect(l.unit_after_discount_cents).toBe(900);
    expect(l.line_ttc_cents).toBe(900);
    expect(l.line_ht_cents).toBe(750);
    expect(l.line_vat_cents).toBe(150);
    expect(l.unit_price_ht_cents).toBe(833);
  });

  it('remise 100 %', () => {
    const l = computeLine(line({ discount_percent: 100 }));
    expect(l.unit_after_discount_cents).toBe(0);
    expect(l.line_ttc_cents).toBe(0);
    expect(l.line_ht_cents).toBe(0);
    expect(l.line_vat_cents).toBe(0);
  });

  it('remise à 2 décimales (12.34 % sur 99,99 €)', () => {
    const l = computeLine(line({ unit_price_ttc_cents: 9999, discount_percent: 12.34 }));
    // 9999 × 0.8766 = 8765.12… → 8765
    expect(l.unit_after_discount_cents).toBe(8765);
  });

  it('quantité 2.5', () => {
    const l = computeLine(line({ qty: 2.5 }));
    expect(l.line_ttc_cents).toBe(2500);
    expect(l.line_ht_cents).toBe(2083);
    expect(l.line_vat_cents).toBe(417);
    const half = computeLine(line({ qty: 2.5, unit_price_ttc_cents: 399 }));
    expect(half.line_ttc_cents).toBe(998); // 997.5 → 998 (half-up)
  });

  it('refund : quantité négative → montants négatifs (half away from zero)', () => {
    const l = computeLine(line({ qty: -1 }));
    expect(l.line_ttc_cents).toBe(-1000);
    expect(l.line_ht_cents).toBe(-833);
    expect(l.line_vat_cents).toBe(-167);
    const half = computeLine(line({ qty: -2.5, unit_price_ttc_cents: 399 }));
    expect(half.line_ttc_cents).toBe(-998);
  });

  it('rejects invalid inputs', () => {
    expect(() => computeLine(line({ discount_percent: 101 }))).toThrow(RangeError);
    expect(() => computeLine(line({ discount_percent: -1 }))).toThrow(RangeError);
    expect(() => computeLine(line({ discount_percent: 10.123 }))).toThrow(RangeError);
    expect(() => computeLine(line({ qty: 1.0005 }))).toThrow(RangeError);
    expect(() => computeLine(line({ qty: Number.NaN }))).toThrow(RangeError);
    expect(() => computeLine(line({ unit_price_ttc_cents: 10.5 }))).toThrow(RangeError);
    expect(() => computeLine(line({ vat_rate: 'x' }))).toThrow(RangeError);
  });
});

describe('computeCart', () => {
  it('multi-taux : groupes triés numériquement et sommes des lignes', () => {
    const cart = computeCart([
      line({ line_no: 1, qty: 3, unit_price_ttc_cents: 250, vat_rate: '5.5' }),
      line({ line_no: 2, unit_price_ttc_cents: 2490, vat_rate: '20.00', discount_percent: 10 }),
      line({ line_no: 3, unit_price_ttc_cents: 1000, vat_rate: 0 }),
      line({ line_no: 4, unit_price_ttc_cents: 500, vat_rate: 5.5 }),
    ]);
    expect(cart.vat_breakdown.map((g) => g.rate)).toEqual(['0.00', '5.50', '20.00']);
    expect(cart.vat_breakdown[0]).toEqual({
      rate: '0.00',
      base_ht_cents: 1000,
      vat_cents: 0,
      ttc_cents: 1000,
    });
    expect(cart.vat_breakdown[1]).toEqual({
      rate: '5.50',
      base_ht_cents: 711 + 474,
      vat_cents: 39 + 26,
      ttc_cents: 1250,
    });
    expect(cart.vat_breakdown[2]).toEqual({
      rate: '20.00',
      base_ht_cents: 1868,
      vat_cents: 373,
      ttc_cents: 2241,
    });
    expect(cart.total_ttc_cents).toBe(1000 + 1250 + 2241);
    expect(cart.total_vat_cents).toBe(0 + 65 + 373);
    expect(cart.total_ht_cents).toBe(cart.total_ttc_cents - cart.total_vat_cents);
  });

  it('somme des groupes = totaux', () => {
    const cart = computeCart([
      line({ line_no: 1, qty: 2, unit_price_ttc_cents: 4500 }),
      line({ line_no: 2, unit_price_ttc_cents: 320, vat_rate: 5.5 }),
    ]);
    const sum = (key: 'base_ht_cents' | 'vat_cents' | 'ttc_cents'): number =>
      cart.vat_breakdown.reduce((acc, g) => acc + g[key], 0);
    expect(sum('base_ht_cents')).toBe(cart.total_ht_cents);
    expect(sum('vat_cents')).toBe(cart.total_vat_cents);
    expect(sum('ttc_cents')).toBe(cart.total_ttc_cents);
    expect(cart.total_ttc_cents).toBe(9320);
  });

  it('empty cart → zero totals', () => {
    const cart = computeCart([]);
    expect(cart).toEqual({
      lines: [],
      vat_breakdown: [],
      total_ht_cents: 0,
      total_vat_cents: 0,
      total_ttc_cents: 0,
    });
  });

  it('property: 200 random lines keep HT + TVA = TTC and Σ groups = totals', () => {
    let seed = 20260923;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const rates = [20, '10', 5.5, '2.10', 0];
    const lines: CartLineInput[] = [];
    for (let i = 0; i < 200; i += 1) {
      const qtyMilli = Math.floor(rand() * 20000) - 5000 || 1;
      lines.push(
        line({
          line_no: i + 1,
          qty: qtyMilli / 1000,
          unit_price_ttc_cents: Math.floor(rand() * 100000),
          vat_rate: rates[Math.floor(rand() * rates.length)] ?? 20,
          discount_percent: Math.floor(rand() * 10001) / 100,
        }),
      );
    }
    const cart = computeCart(lines);
    expect(cart.lines).toHaveLength(200);
    for (const l of cart.lines) {
      expect(Number.isInteger(l.line_ttc_cents)).toBe(true);
      expect(l.line_ht_cents + l.line_vat_cents).toBe(l.line_ttc_cents);
    }
    expect(cart.total_ht_cents + cart.total_vat_cents).toBe(cart.total_ttc_cents);
    expect(cart.lines.reduce((a, l) => a + l.line_ttc_cents, 0)).toBe(cart.total_ttc_cents);
    expect(cart.lines.reduce((a, l) => a + l.line_vat_cents, 0)).toBe(cart.total_vat_cents);
    const sum = (key: 'base_ht_cents' | 'vat_cents' | 'ttc_cents'): number =>
      cart.vat_breakdown.reduce((acc, g) => acc + g[key], 0);
    expect(sum('base_ht_cents')).toBe(cart.total_ht_cents);
    expect(sum('vat_cents')).toBe(cart.total_vat_cents);
    expect(sum('ttc_cents')).toBe(cart.total_ttc_cents);
    const numericRates = cart.vat_breakdown.map((g) => Number(g.rate));
    expect([...numericRates].sort((a, b) => a - b)).toEqual(numericRates);
  });
});

describe('validatePayments', () => {
  const cash = (amount_cents: number): PaymentInput => ({ method: 'cash', amount_cents });

  it('exact payment', () => {
    expect(validatePayments(1000, [cash(1000)], 0)).toEqual({ ok: true, tendered_cents: 1000 });
    expect(validatePayments(1000, [{ method: 'cb', amount_cents: 600 }, cash(400)], 0)).toEqual({
      ok: true,
      tendered_cents: 1000,
    });
  });

  it('cash with change', () => {
    expect(validatePayments(9320, [{ method: 'cb', amount_cents: 5000 }, cash(5000)], 680)).toEqual(
      { ok: true, tendered_cents: 10000 },
    );
  });

  it('refund: negative amounts', () => {
    expect(validatePayments(-1000, [cash(-1000)], 0)).toEqual({ ok: true, tendered_cents: -1000 });
  });

  it('mismatch', () => {
    const r = validatePayments(1000, [cash(900)], 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PAYMENTS_MISMATCH');
    expect(validatePayments(1000, [cash(1000)], 10)).toMatchObject({
      ok: false,
      code: 'PAYMENTS_MISMATCH',
    });
    expect(validatePayments(1000, [], 0)).toMatchObject({ ok: false, code: 'PAYMENTS_MISMATCH' });
    expect(validatePayments(1000, [cash(1000)], -1)).toMatchObject({
      ok: false,
      code: 'PAYMENTS_MISMATCH',
    });
    expect(validatePayments(1000, [cash(1000.5)], 0)).toMatchObject({
      ok: false,
      code: 'PAYMENTS_MISMATCH',
    });
  });

  it('change without cash', () => {
    expect(validatePayments(1000, [{ method: 'cb', amount_cents: 1200 }], 200)).toMatchObject({
      ok: false,
      code: 'CHANGE_WITHOUT_CASH',
    });
  });

  it('missing reference for cheque / gift_ucia / transfer', () => {
    for (const method of ['cheque', 'gift_ucia', 'transfer'] as const) {
      expect(validatePayments(1000, [{ method, amount_cents: 1000 }], 0)).toMatchObject({
        ok: false,
        code: 'MISSING_REFERENCE',
      });
      expect(
        validatePayments(1000, [{ method, amount_cents: 1000, reference: '  ' }], 0),
      ).toMatchObject({ ok: false, code: 'MISSING_REFERENCE' });
      expect(
        validatePayments(1000, [{ method, amount_cents: 1000, reference: 'REF-1' }], 0),
      ).toEqual({
        ok: true,
        tendered_cents: 1000,
      });
    }
  });

  it('cb manual fallback requires tpe_response.reason', () => {
    expect(
      validatePayments(1000, [{ method: 'cb', amount_cents: 1000, manual_fallback: true }], 0),
    ).toMatchObject({ ok: false, code: 'MANUAL_FALLBACK_REASON_REQUIRED' });
    expect(
      validatePayments(
        1000,
        [
          {
            method: 'cb',
            amount_cents: 1000,
            manual_fallback: true,
            tpe_response: { reason: 'TPE hors ligne' },
          },
        ],
        0,
      ),
    ).toEqual({ ok: true, tendered_cents: 1000 });
  });

  it('exposes payment labels', () => {
    expect(PAYMENT_METHOD_LABELS.gift_ucia).toBe('Bon cadeau UCIA');
  });
});
