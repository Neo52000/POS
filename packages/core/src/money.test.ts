import { describe, expect, it } from 'vitest';

import { formatEurCents, parseEuroToCents, roundHalfAwayFromZero } from './money.js';

const normalizeSpaces = (s: string): string => s.replace(/[\u00a0\u202f]/g, ' ');

describe('roundHalfAwayFromZero', () => {
  it('rounds halves away from zero (positives and negatives)', () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(1.5)).toBe(2);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(-1.5)).toBe(-2);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(-833.3333)).toBe(-833);
    expect(roundHalfAwayFromZero(833.3333)).toBe(833);
    expect(roundHalfAwayFromZero(0.4)).toBe(0);
    expect(roundHalfAwayFromZero(-0.4)).toBe(0);
  });

  it('never returns -0', () => {
    expect(Object.is(roundHalfAwayFromZero(-0.2), 0)).toBe(true);
    expect(Object.is(roundHalfAwayFromZero(-0), 0)).toBe(true);
  });

  it('rejects non-finite values', () => {
    expect(() => roundHalfAwayFromZero(Number.NaN)).toThrow(RangeError);
    expect(() => roundHalfAwayFromZero(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('formatEurCents', () => {
  it('formats fr-FR with thousands separator and euro sign', () => {
    expect(normalizeSpaces(formatEurCents(123456))).toBe('1 234,56 €');
    expect(normalizeSpaces(formatEurCents(0))).toBe('0,00 €');
    expect(normalizeSpaces(formatEurCents(5))).toBe('0,05 €');
    expect(normalizeSpaces(formatEurCents(-1050))).toBe('-10,50 €');
  });

  it('accepts another locale', () => {
    expect(normalizeSpaces(formatEurCents(123456, 'en-US'))).toBe('€1,234.56');
  });
});

describe('parseEuroToCents', () => {
  it('accepts comma, dot and integer inputs', () => {
    expect(parseEuroToCents('12,50')).toBe(1250);
    expect(parseEuroToCents('12.50')).toBe(1250);
    expect(parseEuroToCents('12')).toBe(1200);
    expect(parseEuroToCents('12,5')).toBe(1250);
    expect(parseEuroToCents(' 1 234,56 € ')).toBe(123456);
    expect(parseEuroToCents('-3,20')).toBe(-320);
    expect(parseEuroToCents('0')).toBe(0);
    expect(Object.is(parseEuroToCents('-0,00'), 0)).toBe(true);
  });

  it('rejects invalid inputs', () => {
    expect(parseEuroToCents('')).toBeNull();
    expect(parseEuroToCents('abc')).toBeNull();
    expect(parseEuroToCents('12,345')).toBeNull();
    expect(parseEuroToCents('1,2,3')).toBeNull();
    expect(parseEuroToCents('12.')).toBeNull();
  });
});
