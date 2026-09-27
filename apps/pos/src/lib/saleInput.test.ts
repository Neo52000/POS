import { describe, expect, it } from 'vitest';
import { impliedDiscountPercent, parseMultiplier, parsePercent, parseQty } from './saleInput';

describe('parseMultiplier', () => {
  it('extrait la quantité et le terme de recherche', () => {
    expect(parseMultiplier('3*')).toEqual({ qty: 3, term: '' });
    expect(parseMultiplier('3* cahier')).toEqual({ qty: 3, term: 'cahier' });
    expect(parseMultiplier(' 2,5 × ruban')).toEqual({ qty: 2.5, term: 'ruban' });
  });
  it('laisse une recherche ordinaire intacte', () => {
    expect(parseMultiplier('stylo')).toEqual({ qty: null, term: 'stylo' });
    expect(parseMultiplier('3086123101227')).toEqual({ qty: null, term: '3086123101227' });
    expect(parseMultiplier('0* cahier')).toEqual({ qty: null, term: '0* cahier' });
    expect(parseMultiplier('A4*')).toEqual({ qty: null, term: 'A4*' });
  });
});

describe('parseQty', () => {
  it('accepte entiers et décimales (3 max)', () => {
    expect(parseQty('12')).toBe(12);
    expect(parseQty('2,5')).toBe(2.5);
    expect(parseQty('0.125')).toBe(0.125);
  });
  it('refuse 0, négatif, notation scientifique et trop de décimales', () => {
    for (const bad of ['0', '-1', '1e2', '1,2345', '', 'abc']) expect(parseQty(bad)).toBeNull();
  });
});

describe('parsePercent', () => {
  it('accepte 0 à 100 avec 2 décimales', () => {
    expect(parsePercent('10')).toBe(10);
    expect(parsePercent('12,5')).toBe(12.5);
    expect(parsePercent('100')).toBe(100);
  });
  it('refuse les saisies ambiguës', () => {
    for (const bad of ['1e2', '-5', '101', '12,345', '', '.5'])
      expect(parsePercent(bad)).toBeNull();
  });
});

describe('impliedDiscountPercent', () => {
  it('calcule la remise d’un prix forcé', () => {
    expect(impliedDiscountPercent(1000, 700)).toBe(30);
    expect(impliedDiscountPercent(120, 99)).toBe(17.5);
    expect(impliedDiscountPercent(1000, 1200)).toBe(0);
    expect(impliedDiscountPercent(0, 0)).toBe(0);
  });
});
