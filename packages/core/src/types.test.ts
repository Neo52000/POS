import { describe, expect, it } from 'vitest';

import { isIsoDate, isUuidV4, validateCheckoutPayload } from './types.js';
import type { CheckoutPayload } from './types.js';

function validPayload(): CheckoutPayload {
  return {
    client_txn_id: '3f2504e0-4f89-4d3c-9a6b-0f1e2d3c4b5a',
    register_id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    session_id: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
    kind: 'sale',
    business_at: '2026-09-23T14:05:07.123Z',
    offline_queued: false,
    invoice_requested: false,
    lines: [
      {
        line_no: 1,
        product_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        ean: '3000000000017',
        label: 'Cahier 96p',
        qty: 1,
        unit_price_ttc_cents: 1000,
        vat_rate: '20.00',
        discount_percent: 0,
        eco_tax_cents: 0,
      },
    ],
    payments: [{ method: 'cash', amount_cents: 1000 }],
    change_cents: 0,
    totals: { total_ht_cents: 833, total_vat_cents: 167, total_ttc_cents: 1000 },
    app_version: '0.1.0',
  };
}

function mutate(fn: (p: Record<string, unknown>) => void): unknown {
  const p = validPayload() as unknown as Record<string, unknown>;
  fn(p);
  return p;
}

function errorsOf(payload: unknown): string[] {
  const result = validateCheckoutPayload(payload);
  return result.ok ? [] : result.errors;
}

describe('helpers', () => {
  it('isUuidV4', () => {
    expect(isUuidV4('3f2504e0-4f89-4d3c-9a6b-0f1e2d3c4b5a')).toBe(true);
    expect(isUuidV4('3F2504E0-4F89-4D3C-9A6B-0F1E2D3C4B5A')).toBe(true);
    expect(isUuidV4('3f2504e0-4f89-1d3c-9a6b-0f1e2d3c4b5a')).toBe(false); // v1
    expect(isUuidV4('3f2504e0-4f89-4d3c-7a6b-0f1e2d3c4b5a')).toBe(false); // variant
    expect(isUuidV4('not-a-uuid')).toBe(false);
    expect(isUuidV4(42)).toBe(false);
  });

  it('isIsoDate', () => {
    expect(isIsoDate('2026-09-23T14:05:07.123Z')).toBe(true);
    expect(isIsoDate('2026-09-23T14:05:07Z')).toBe(true);
    expect(isIsoDate('2026-09-23T16:05:07.123+02:00')).toBe(true);
    expect(isIsoDate('2026-09-23')).toBe(false);
    expect(isIsoDate('2026-13-45T14:05:07.123Z')).toBe(false);
    expect(isIsoDate('yesterday')).toBe(false);
  });
});

describe('validateCheckoutPayload', () => {
  it('accepts a valid sale', () => {
    const payload = validPayload();
    const result = validateCheckoutPayload(payload);
    expect(result).toEqual({ ok: true, value: payload });
  });

  it('accepts a valid refund with optional fields', () => {
    const payload: CheckoutPayload = {
      ...validPayload(),
      kind: 'refund',
      refund_of_transaction_id: '16fd2706-8baf-433b-82eb-8c7fada847da',
      refund_reason: 'Article défectueux',
      customer_account_id: '7c1f4c2e-9a7b-4d3e-8f21-0b5c6d7e8f90',
      quote_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      provisional_ref: 'P-CAISSE-01-0001',
      offline_queued: true,
      lines: [{ line_no: 1, label: 'Cahier', qty: -1, unit_price_ttc_cents: 1000, vat_rate: 20 }],
      payments: [
        { method: 'cheque', amount_cents: -500, reference: 'CHQ-1' },
        { method: 'cb', amount_cents: -500, manual_fallback: true, tpe_response: { reason: 'x' } },
      ],
      totals: { total_ht_cents: -833, total_vat_cents: -167, total_ttc_cents: -1000 },
    };
    expect(validateCheckoutPayload(payload).ok).toBe(true);
  });

  it('rejects a non-object payload', () => {
    expect(validateCheckoutPayload(null)).toEqual({
      ok: false,
      errors: ['payload: must be an object'],
    });
    expect(validateCheckoutPayload('x').ok).toBe(false);
    expect(validateCheckoutPayload([]).ok).toBe(false);
  });

  const invalidCases: Array<[string, () => unknown, string]> = [
    ['invalid client_txn_id', () => mutate((p) => (p['client_txn_id'] = 'abc')), 'client_txn_id'],
    ['missing register_id', () => mutate((p) => delete p['register_id']), 'register_id'],
    [
      'uuid v1 session_id',
      () => mutate((p) => (p['session_id'] = '3f2504e0-4f89-1d3c-9a6b-0f1e2d3c4b5a')),
      'session_id',
    ],
    ['invalid kind', () => mutate((p) => (p['kind'] = 'void')), 'kind'],
    [
      'refund without refund_of_transaction_id / reason',
      () =>
        mutate((p) => {
          p['kind'] = 'refund';
          (p['lines'] as Array<Record<string, unknown>>)[0]!['qty'] = -1;
        }),
      'refund_of_transaction_id',
    ],
    [
      'refund with empty reason',
      () =>
        mutate((p) => {
          p['kind'] = 'refund';
          p['refund_of_transaction_id'] = '16fd2706-8baf-433b-82eb-8c7fada847da';
          p['refund_reason'] = '   ';
          (p['lines'] as Array<Record<string, unknown>>)[0]!['qty'] = -1;
        }),
      'refund_reason',
    ],
    ['invalid business_at', () => mutate((p) => (p['business_at'] = '23/09/2026')), 'business_at'],
    [
      'offline_queued not boolean',
      () => mutate((p) => (p['offline_queued'] = 'no')),
      'offline_queued',
    ],
    [
      'missing invoice_requested',
      () => mutate((p) => delete p['invoice_requested']),
      'invoice_requested',
    ],
    ['empty lines', () => mutate((p) => (p['lines'] = [])), 'lines'],
    [
      'line with empty label',
      () => mutate((p) => ((p['lines'] as Array<Record<string, unknown>>)[0]!['label'] = '')),
      'label',
    ],
    [
      'line with qty 0',
      () => mutate((p) => ((p['lines'] as Array<Record<string, unknown>>)[0]!['qty'] = 0)),
      'qty',
    ],
    [
      'line with 4-decimal qty',
      () => mutate((p) => ((p['lines'] as Array<Record<string, unknown>>)[0]!['qty'] = 1.0001)),
      'qty',
    ],
    [
      'sale with negative qty',
      () => mutate((p) => ((p['lines'] as Array<Record<string, unknown>>)[0]!['qty'] = -1)),
      'qty',
    ],
    [
      'line with float price',
      () =>
        mutate(
          (p) =>
            ((p['lines'] as Array<Record<string, unknown>>)[0]!['unit_price_ttc_cents'] = 10.5),
        ),
      'unit_price_ttc_cents',
    ],
    [
      'line with invalid vat_rate',
      () =>
        mutate((p) => ((p['lines'] as Array<Record<string, unknown>>)[0]!['vat_rate'] = '19.999')),
      'vat_rate',
    ],
    [
      'line with discount > 100',
      () =>
        mutate(
          (p) => ((p['lines'] as Array<Record<string, unknown>>)[0]!['discount_percent'] = 101),
        ),
      'discount_percent',
    ],
    [
      'line with invalid product_id',
      () => mutate((p) => ((p['lines'] as Array<Record<string, unknown>>)[0]!['product_id'] = 'x')),
      'product_id',
    ],
    ['empty payments', () => mutate((p) => (p['payments'] = [])), 'payments'],
    [
      'unknown payment method',
      () => mutate((p) => (p['payments'] = [{ method: 'bitcoin', amount_cents: 1000 }])),
      'method',
    ],
    [
      'cheque without reference',
      () => mutate((p) => (p['payments'] = [{ method: 'cheque', amount_cents: 1000 }])),
      'reference',
    ],
    [
      'gift_ucia with blank reference',
      () =>
        mutate(
          (p) => (p['payments'] = [{ method: 'gift_ucia', amount_cents: 1000, reference: ' ' }]),
        ),
      'reference',
    ],
    [
      'transfer without reference',
      () => mutate((p) => (p['payments'] = [{ method: 'transfer', amount_cents: 1000 }])),
      'reference',
    ],
    [
      'cb manual_fallback without reason',
      () =>
        mutate(
          (p) => (p['payments'] = [{ method: 'cb', amount_cents: 1000, manual_fallback: true }]),
        ),
      'tpe_response.reason',
    ],
    [
      'float amount_cents',
      () => mutate((p) => (p['payments'] = [{ method: 'cash', amount_cents: 10.5 }])),
      'amount_cents',
    ],
    ['negative change_cents', () => mutate((p) => (p['change_cents'] = -1)), 'change_cents'],
    ['missing totals', () => mutate((p) => delete p['totals']), 'totals'],
    [
      'non-integer totals',
      () =>
        mutate(
          (p) => (p['totals'] = { total_ht_cents: 1, total_vat_cents: 0.5, total_ttc_cents: 1 }),
        ),
      'total_vat_cents',
    ],
    ['empty app_version', () => mutate((p) => (p['app_version'] = '')), 'app_version'],
    [
      'invalid customer_account_id',
      () => mutate((p) => (p['customer_account_id'] = 'nope')),
      'customer_account_id',
    ],
  ];

  it.each(invalidCases)('rejects %s', (_name, build, expectedField) => {
    const errors = errorsOf(build());
    expect(errors.length).toBeGreaterThan(0);
    expect(
      errors.some((e) => e.includes(expectedField)),
      errors.join('; '),
    ).toBe(true);
  });

  it('collects several errors at once', () => {
    const errors = errorsOf(
      mutate((p) => {
        p['kind'] = 'x';
        p['lines'] = [];
        p['payments'] = [];
        p['change_cents'] = -5;
      }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(4);
  });
});
