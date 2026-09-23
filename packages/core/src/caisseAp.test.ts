import { describe, expect, it } from 'vitest';

import {
  CAISSE_AP_ACTIONS,
  CAISSE_AP_AF_CODES,
  CaisseApEncodeError,
  buildPaymentRequest,
  buildPaymentRequestFields,
  decodeFields,
  encodeFields,
  parsePaymentResponse,
} from './caisseAp.js';

const REFERENCE_FRAME = 'CZ0040300CJ012247300123456CA00201CB0042500CD0010CE003978';

describe('encodeFields / decodeFields', () => {
  it('round-trips', () => {
    const fields: Array<[string, string]> = [
      ['CZ', '0300'],
      ['CJ', '247300123456'],
      ['CA', '01'],
      ['CB', '2500'],
      ['CD', '0'],
      ['CE', '978'],
      ['XX', ''],
    ];
    const frame = encodeFields(fields);
    const decoded = decodeFields(frame);
    expect(decoded.truncated).toBe(false);
    expect(decoded.order).toEqual(fields.map(([t]) => t));
    expect([...decoded.fields.entries()]).toEqual(fields);
    expect(encodeFields([...decoded.fields.entries()])).toBe(frame);
  });

  it('decodes the reference frame', () => {
    const decoded = decodeFields(REFERENCE_FRAME);
    expect(decoded.truncated).toBe(false);
    expect(Object.fromEntries(decoded.fields)).toEqual({
      CZ: '0300',
      CJ: '247300123456',
      CA: '01',
      CB: '2500',
      CD: '0',
      CE: '978',
    });
    expect(decoded.order).toEqual(['CZ', 'CJ', 'CA', 'CB', 'CD', 'CE']);
  });

  it('flags a truncated frame and keeps the complete fields', () => {
    const truncated = decodeFields(REFERENCE_FRAME.slice(0, -2));
    expect(truncated.truncated).toBe(true);
    expect(truncated.fields.get('CD')).toBe('0');
    expect(truncated.fields.has('CE')).toBe(false);
    expect(decodeFields('CZ00').truncated).toBe(true);
    expect(decodeFields('CZ0x40300').truncated).toBe(true);
    expect(decodeFields('')).toEqual({ fields: new Map(), order: [], truncated: false });
  });

  it('encodes with 3-digit zero-padded length up to 999 chars', () => {
    const long = 'a'.repeat(999);
    expect(encodeFields([['AA', long]])).toBe(`AA999${long}`);
    expect(encodeFields([['AB', '']])).toBe('AB000');
  });

  it('rejects invalid tags and values', () => {
    expect(() => encodeFields([['C', '1']])).toThrow(CaisseApEncodeError);
    expect(() => encodeFields([['CAB', '1']])).toThrow(CaisseApEncodeError);
    expect(() => encodeFields([['CA', 'a'.repeat(1000)]])).toThrow(CaisseApEncodeError);
    expect(() => encodeFields([['CA', 'é']])).toThrow(CaisseApEncodeError);
    expect(() => encodeFields([['CA', '\n']])).toThrow(CaisseApEncodeError);
    expect(() => encodeFields([['Cé', '1']])).toThrow(CaisseApEncodeError);
  });
});

describe('buildPaymentRequest', () => {
  it('reproduces the reference frame', () => {
    expect(
      buildPaymentRequest({ amountCents: 2500, action: 'debit', protocolId: '247300123456' }),
    ).toBe(REFERENCE_FRAME);
  });

  it('applies defaults and action codes', () => {
    expect(buildPaymentRequestFields({ amountCents: 5, action: 'credit' })).toEqual([
      ['CZ', '0300'],
      ['CJ', '012'],
      ['CA', '01'],
      ['CB', '5'],
      ['CD', CAISSE_AP_ACTIONS.credit],
      ['CE', '978'],
    ]);
    expect(buildPaymentRequest({ amountCents: 0, action: 'cancel', posNumber: '02' })).toBe(
      'CZ0040300CJ003012CA00202CB0010CD0012CE003978',
    );
  });

  it('rejects invalid amounts', () => {
    expect(() => buildPaymentRequest({ amountCents: -1, action: 'debit' })).toThrow(RangeError);
    expect(() => buildPaymentRequest({ amountCents: 1.5, action: 'debit' })).toThrow(RangeError);
  });
});

describe('parsePaymentResponse', () => {
  it('maps AE codes to statuses', () => {
    expect(parsePaymentResponse(encodeFields([['AE', '10']]))).toEqual({
      status: 'approved',
      ae: '10',
      af: null,
      raw: { AE: '10' },
    });
    expect(
      parsePaymentResponse(
        encodeFields([
          ['AE', '01'],
          ['AF', '11'],
        ]),
      ),
    ).toMatchObject({
      status: 'declined',
      ae: '01',
      af: '11',
    });
    expect(parsePaymentResponse(decodeFields(encodeFields([['AE', '11']])))).toMatchObject({
      status: 'pending',
    });
    expect(parsePaymentResponse(encodeFields([['AE', '99']]))).toMatchObject({
      status: 'unknown',
      ae: '99',
    });
    expect(parsePaymentResponse('')).toEqual({ status: 'unknown', ae: null, af: null, raw: {} });
  });

  it('exposes known AF codes', () => {
    expect(Object.keys(CAISSE_AP_AF_CODES).sort()).toEqual(['09', '10', '11', '12', '13']);
    expect(CAISSE_AP_AF_CODES['09']).toBe('Erreur de format');
  });
});
