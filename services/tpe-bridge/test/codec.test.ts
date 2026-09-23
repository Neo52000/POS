import { describe, expect, it } from 'vitest';
import {
  buildPaymentRequest,
  CAISSE_AP_ACTIONS,
  CAISSE_AP_AF_CODES,
  decodeFields,
  encodeFields,
  parsePaymentResponse,
} from '../src/caisseap/tags.js';
import { buildResponse } from '../simulator/tpe-sim.js';

describe('codec Caisse-AP (round-trip via @pos/core)', () => {
  it('encode une demande de débit de 25,00 € conforme à SPEC §7', () => {
    const frame = buildPaymentRequest({ amountCents: 2500, action: 'debit' });
    expect(frame).toBe('CZ0040300CJ003012CA00201CB0042500CD0010CE003978');
    const decoded = decodeFields(frame);
    expect(decoded.truncated).toBe(false);
    expect(decoded.order).toEqual(['CZ', 'CJ', 'CA', 'CB', 'CD', 'CE']);
    expect(Object.fromEntries(decoded.fields)).toEqual({
      CZ: '0300',
      CJ: '012',
      CA: '01',
      CB: '2500',
      CD: CAISSE_AP_ACTIONS.debit,
      CE: '978',
    });
  });

  it('round-trip sur une réponse réelle acceptée (AE=10)', () => {
    const frame = 'CZ0040300CJ003012CA00201CB0042500CD0010CE003978AE00210';
    const decoded = decodeFields(frame);
    expect(decoded.truncated).toBe(false);
    expect(encodeFields(decoded.order.map((tag) => [tag, decoded.fields.get(tag) ?? '']))).toBe(
      frame,
    );
    const parsed = parsePaymentResponse(decoded);
    expect(parsed.status).toBe('approved');
    expect(parsed.ae).toBe('10');
    expect(parsed.af).toBeNull();
  });

  it('round-trip sur un refus motivé (AE=01, AF=11 abandon)', () => {
    const request = decodeFields(buildPaymentRequest({ amountCents: 1001, action: 'debit' }));
    const frame = buildResponse(request.fields, '01', '11');
    expect(frame).toBe('CZ0040300CJ003012CA00201CB0041001CD0010CE003978AE00201AF00211');
    const parsed = parsePaymentResponse(frame);
    expect(parsed.status).toBe('declined');
    expect(parsed.af).toBe('11');
    expect(CAISSE_AP_AF_CODES[parsed.af ?? '']).toBe('Abandon');
  });

  it('tolère une trame tronquée au milieu du champ AE', () => {
    const full = 'CZ0040300CJ003012CA00201CB0042500CD0010CE003978AE00210';
    const decoded = decodeFields(full.slice(0, -1));
    expect(decoded.truncated).toBe(true);
    expect(decoded.fields.has('AE')).toBe(false);
    expect(decoded.fields.get('CE')).toBe('978');
  });

  it('un crédit et une annulation portent CD=1 et CD=2', () => {
    expect(
      decodeFields(buildPaymentRequest({ amountCents: 100, action: 'credit' })).fields.get('CD'),
    ).toBe(CAISSE_AP_ACTIONS.credit);
    expect(
      decodeFields(buildPaymentRequest({ amountCents: 100, action: 'cancel' })).fields.get('CD'),
    ).toBe(CAISSE_AP_ACTIONS.cancel);
  });

  it('les valeurs à 999 caractères passent, 1000 échouent', () => {
    expect(() => encodeFields([['XX', 'a'.repeat(999)]])).not.toThrow();
    expect(() => encodeFields([['XX', 'a'.repeat(1000)]])).toThrow();
  });
});
