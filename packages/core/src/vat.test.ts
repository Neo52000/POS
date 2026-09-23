import { describe, expect, it } from 'vitest';

import {
  VAT_RATES_FR,
  htToTtcCents,
  isVatRateFr,
  normalizeVatRate,
  ttcToHtCents,
  vatRateToBasisPoints,
} from './vat.js';

describe('normalizeVatRate', () => {
  it('normalizes numbers and strings to 2 decimals', () => {
    expect(normalizeVatRate('20')).toBe('20.00');
    expect(normalizeVatRate(20)).toBe('20.00');
    expect(normalizeVatRate(20.0)).toBe('20.00');
    expect(normalizeVatRate('20.0')).toBe('20.00');
    expect(normalizeVatRate('5.5')).toBe('5.50');
    expect(normalizeVatRate(5.5)).toBe('5.50');
    expect(normalizeVatRate('5,5')).toBe('5.50');
    expect(normalizeVatRate('2.1')).toBe('2.10');
    expect(normalizeVatRate(0)).toBe('0.00');
    expect(normalizeVatRate('10 %')).toBe('10.00');
  });

  it('rejects invalid rates', () => {
    expect(() => normalizeVatRate('abc')).toThrow(RangeError);
    expect(() => normalizeVatRate(-1)).toThrow(RangeError);
    expect(() => normalizeVatRate(101)).toThrow(RangeError);
    expect(() => normalizeVatRate(5.555)).toThrow(RangeError);
    expect(() => normalizeVatRate('')).toThrow(RangeError);
  });
});

describe('vatRateToBasisPoints', () => {
  it('converts to integer basis points', () => {
    expect(vatRateToBasisPoints('20.00')).toBe(2000);
    expect(vatRateToBasisPoints(5.5)).toBe(550);
    expect(vatRateToBasisPoints('2.10')).toBe(210);
    expect(vatRateToBasisPoints(0)).toBe(0);
  });
});

describe('ttcToHtCents / htToTtcCents', () => {
  it('matches SPEC examples', () => {
    expect(ttcToHtCents(1000, 20)).toBe(833);
    expect(ttcToHtCents(-1000, 20)).toBe(-833);
    expect(ttcToHtCents(750, '5.5')).toBe(711);
    expect(ttcToHtCents(1000, 0)).toBe(1000);
    expect(htToTtcCents(833, 20)).toBe(1000);
    expect(htToTtcCents(1000, '5.50')).toBe(1055);
  });
});

describe('VAT_RATES_FR', () => {
  it('lists the canonical French rates', () => {
    expect(VAT_RATES_FR).toEqual(['20.00', '10.00', '5.50', '2.10', '0.00']);
    expect(isVatRateFr(5.5)).toBe(true);
    expect(isVatRateFr('7')).toBe(false);
    expect(isVatRateFr('x')).toBe(false);
  });
});
