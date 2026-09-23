import { describe, expect, it } from 'vitest';

import vectorsFile from './__fixtures__/hash-vectors.json';
import { computeCart } from './cart.js';
import {
  buildCanonicalString,
  buildCanonicalStringAsync,
  canonicalDiscount,
  canonicalIsoDate,
  canonicalQty,
  canonicalVatBreakdown,
  computeTransactionHash,
  computeTransactionHashAsync,
  linesCanonicalText,
  linesDigest,
  paymentsCanonicalText,
  paymentsDigest,
  verifyChain,
} from './hashChain.js';
import type { CanonicalTxnInput, ChainedTxn } from './hashChain.js';
import { sha256Hex } from './sha256.js';

const HEX64 = /^[0-9a-f]{64}$/;

function baseInput(overrides: Partial<CanonicalTxnInput> = {}): CanonicalTxnInput {
  const cart = computeCart([
    {
      line_no: 2,
      product_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
      ean: '3000000000024',
      label: 'Agenda 2027',
      qty: 1,
      unit_price_ttc_cents: 2490,
      vat_rate: 20,
      discount_percent: 10,
    },
    { line_no: 1, label: 'Crayons', qty: 3, unit_price_ttc_cents: 250, vat_rate: '5.5' },
  ]);
  return {
    ticket_number: 42,
    register_code: 'CAISSE-01',
    client_txn_id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    business_at: '2026-09-23T09:02:44.000Z',
    kind: 'sale',
    total_ht_cents: cart.total_ht_cents,
    total_vat_cents: cart.total_vat_cents,
    total_ttc_cents: cart.total_ttc_cents,
    vat_breakdown: cart.vat_breakdown,
    customer_account_id: null,
    lines: cart.lines,
    payments: [
      { method: 'cash', amount_cents: 1000 },
      { method: 'cb', amount_cents: 1991 },
    ],
    prev_hash: '',
    ...overrides,
  };
}

describe('canonical helpers', () => {
  it('canonicalQty strips useless zeros', () => {
    expect(canonicalQty(1)).toBe('1');
    expect(canonicalQty(2.5)).toBe('2.5');
    expect(canonicalQty(-1)).toBe('-1');
    expect(canonicalQty(0.125)).toBe('0.125');
    expect(canonicalQty(10)).toBe('10');
    expect(canonicalQty(1.1)).toBe('1.1');
    expect(canonicalQty(-0.5)).toBe('-0.5');
    expect(canonicalQty(0)).toBe('0');
    expect(canonicalQty(-0)).toBe('0');
    expect(canonicalQty(1234.5)).toBe('1234.5');
  });

  it('canonicalDiscount has 2 decimals', () => {
    expect(canonicalDiscount(0)).toBe('0.00');
    expect(canonicalDiscount(10)).toBe('10.00');
    expect(canonicalDiscount(12.5)).toBe('12.50');
    expect(canonicalDiscount(100)).toBe('100.00');
    expect(canonicalDiscount(0.1)).toBe('0.10');
  });

  it('canonicalIsoDate normalizes to UTC with milliseconds', () => {
    expect(canonicalIsoDate('2026-09-23T14:05:07.123Z')).toBe('2026-09-23T14:05:07.123Z');
    expect(canonicalIsoDate('2026-09-23T16:05:07+02:00')).toBe('2026-09-23T14:05:07.000Z');
    expect(() => canonicalIsoDate('nope')).toThrow(RangeError);
  });

  it('canonicalVatBreakdown sorts numerically and normalizes rates', () => {
    expect(
      canonicalVatBreakdown([
        { rate: '20.00', base_ht_cents: 2500, vat_cents: 500, ttc_cents: 3000 },
        { rate: '5.5', base_ht_cents: 1000, vat_cents: 55, ttc_cents: 1055 },
        { rate: '10', base_ht_cents: 1, vat_cents: 0, ttc_cents: 1 },
      ]),
    ).toBe('5.50:1000:55:1055;10.00:1:0:1;20.00:2500:500:3000');
    expect(canonicalVatBreakdown([])).toBe('');
  });

  it('linesCanonicalText sorts by line_no and formats per SPEC', () => {
    const text = linesCanonicalText(baseInput().lines);
    expect(text).toBe(
      [
        '1|||Crayons|3|250|5.50|0.00|750',
        '2|b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e|3000000000024|Agenda 2027|1|2490|20.00|10.00|2241',
      ].join('\n'),
    );
    expect(linesDigest(baseInput().lines)).toBe(sha256Hex(text));
  });

  it('paymentsCanonicalText sorts by (method, amount, reference)', () => {
    const text = paymentsCanonicalText([
      { method: 'cash', amount_cents: 1000 },
      { method: 'cb', amount_cents: 500, reference: 'B' },
      { method: 'cb', amount_cents: 500, reference: 'A' },
      { method: 'cb', amount_cents: 100 },
    ]);
    expect(text).toBe(['cash|1000|', 'cb|100|', 'cb|500|A', 'cb|500|B'].join('\n'));
    expect(paymentsDigest([])).toBe(sha256Hex(''));
  });
});

describe('computeTransactionHash', () => {
  it('is deterministic and independent of line/payment order', () => {
    const a = baseInput();
    const b = baseInput({
      lines: [...a.lines].reverse(),
      payments: [...a.payments].reverse(),
    });
    expect(computeTransactionHash(a)).toMatch(HEX64);
    expect(computeTransactionHash(a)).toBe(computeTransactionHash(b));
    expect(buildCanonicalString(a)).toBe(buildCanonicalString(b));
  });

  it('builds the canonical string per SPEC §3', () => {
    const input = baseInput();
    const canonical = buildCanonicalString(input);
    const parts = canonical.split('|');
    expect(parts).toHaveLength(14);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe('42');
    expect(parts[2]).toBe('CAISSE-01');
    expect(parts[4]).toBe('2026-09-23T09:02:44.000Z');
    expect(parts[5]).toBe('sale');
    expect(parts[9]).toBe('5.50:711:39:750;20.00:1868:373:2241');
    expect(parts[10]).toBe('');
    expect(parts[11]).toBe(linesDigest(input.lines));
    expect(parts[12]).toBe(paymentsDigest(input.payments));
    expect(parts[13]).toBe('');
    expect(computeTransactionHash(input)).toBe(sha256Hex(canonical));
  });

  it('async variant equals sync variant', async () => {
    const input = baseInput();
    expect(await buildCanonicalStringAsync(input)).toBe(buildCanonicalString(input));
    expect(await computeTransactionHashAsync(input)).toBe(computeTransactionHash(input));
  });

  it('is sensitive to every field', () => {
    const reference = computeTransactionHash(baseInput());
    const base = baseInput();
    const firstLine = base.lines[0];
    const firstPayment = base.payments[0];
    if (!firstLine || !firstPayment) throw new Error('fixture');
    const mutations: Array<[string, Partial<CanonicalTxnInput>]> = [
      ['ticket_number', { ticket_number: 43 }],
      ['register_code', { register_code: 'CAISSE-02' }],
      ['client_txn_id', { client_txn_id: '3f2504e0-4f89-4d3c-9a6b-0f1e2d3c4b5a' }],
      ['business_at', { business_at: '2026-09-23T09:02:44.001Z' }],
      ['kind', { kind: 'refund' }],
      ['total_ht_cents', { total_ht_cents: base.total_ht_cents + 1 }],
      ['total_vat_cents', { total_vat_cents: base.total_vat_cents + 1 }],
      ['total_ttc_cents', { total_ttc_cents: base.total_ttc_cents + 1 }],
      [
        'vat_breakdown',
        { vat_breakdown: base.vat_breakdown.map((g) => ({ ...g, vat_cents: g.vat_cents + 1 })) },
      ],
      ['customer_account_id', { customer_account_id: '7c1f4c2e-9a7b-4d3e-8f21-0b5c6d7e8f90' }],
      ['line.label', { lines: [{ ...firstLine, label: 'X' }, ...base.lines.slice(1)] }],
      ['line.qty', { lines: [{ ...firstLine, qty: 2 }, ...base.lines.slice(1)] }],
      ['line.product_id', { lines: [{ ...firstLine, product_id: null }, ...base.lines.slice(1)] }],
      ['line.ean', { lines: [{ ...firstLine, ean: '1' }, ...base.lines.slice(1)] }],
      [
        'line.unit_price',
        { lines: [{ ...firstLine, unit_price_ttc_cents: 1 }, ...base.lines.slice(1)] },
      ],
      ['line.vat_rate', { lines: [{ ...firstLine, vat_rate: '10' }, ...base.lines.slice(1)] }],
      ['line.discount', { lines: [{ ...firstLine, discount_percent: 5 }, ...base.lines.slice(1)] }],
      ['line.line_ttc', { lines: [{ ...firstLine, line_ttc_cents: 1 }, ...base.lines.slice(1)] }],
      ['line.line_no', { lines: [{ ...firstLine, line_no: 9 }, ...base.lines.slice(1)] }],
      ['lines removed', { lines: base.lines.slice(1) }],
      [
        'payment.method',
        { payments: [{ ...firstPayment, method: 'cb' }, ...base.payments.slice(1)] },
      ],
      [
        'payment.amount',
        { payments: [{ ...firstPayment, amount_cents: 1 }, ...base.payments.slice(1)] },
      ],
      [
        'payment.reference',
        { payments: [{ ...firstPayment, reference: 'R' }, ...base.payments.slice(1)] },
      ],
      ['payments removed', { payments: base.payments.slice(1) }],
      ['prev_hash', { prev_hash: 'a'.repeat(64) }],
    ];
    const seen = new Set<string>([reference]);
    for (const [name, mutation] of mutations) {
      const hash = computeTransactionHash(baseInput(mutation));
      expect(hash, name).not.toBe(reference);
      expect(seen.has(hash), `${name} collides`).toBe(false);
      seen.add(hash);
    }
  });

  it('treats null / undefined / empty prev_hash and customer identically', () => {
    const a = computeTransactionHash(baseInput({ prev_hash: null, customer_account_id: null }));
    const b = computeTransactionHash(
      baseInput({ prev_hash: undefined, customer_account_id: undefined }),
    );
    const c = computeTransactionHash(baseInput({ prev_hash: '', customer_account_id: '' }));
    expect(a).toBe(b);
    expect(a).toBe(c);
  });
});

describe('hash-vectors.json', () => {
  const vectors = vectorsFile.vectors.map((v) => ({
    ...v,
    input: v.input as CanonicalTxnInput,
  }));

  it('has 6 vectors', () => {
    expect(vectorsFile.version).toBe(1);
    expect(vectors).toHaveLength(6);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('replays %s', (_name, v) => {
    expect(linesDigest(v.input.lines)).toBe(v.lines_digest);
    expect(paymentsDigest(v.input.payments)).toBe(v.payments_digest);
    expect(buildCanonicalString(v.input)).toBe(v.canonical_string);
    expect(computeTransactionHash(v.input)).toBe(v.hash);
    expect(sha256Hex(v.canonical_string)).toBe(v.hash);
    expect(v.hash).toMatch(HEX64);
  });

  it('totals of each vector match computeCart on its lines', () => {
    for (const v of vectors) {
      const cart = computeCart(v.input.lines.map((l) => ({ ...l, vat_rate: l.vat_rate })));
      expect(cart.total_ht_cents, v.name).toBe(v.input.total_ht_cents);
      expect(cart.total_vat_cents, v.name).toBe(v.input.total_vat_cents);
      expect(cart.total_ttc_cents, v.name).toBe(v.input.total_ttc_cents);
      expect(cart.vat_breakdown, v.name).toEqual(v.input.vat_breakdown);
    }
  });

  it('forms a valid chain', () => {
    const chain: ChainedTxn[] = vectors.map((v) => ({ ...v.input, hash: v.hash }));
    expect(verifyChain(chain)).toEqual({ ok: true });
    expect(chain[0]?.prev_hash).toBe('');
    expect(chain[4]?.prev_hash).toBe(chain[3]?.hash);
  });
});

describe('verifyChain', () => {
  function makeChain(count: number): ChainedTxn[] {
    const chain: ChainedTxn[] = [];
    let prev = '';
    for (let i = 1; i <= count; i += 1) {
      const input = baseInput({ ticket_number: i, prev_hash: prev });
      const hash = computeTransactionHash(input);
      chain.push({ ...input, hash });
      prev = hash;
    }
    return chain;
  }

  it('accepts a valid chain (any input order) and an empty one', () => {
    const chain = makeChain(5);
    expect(verifyChain(chain)).toEqual({ ok: true });
    expect(verifyChain([...chain].reverse())).toEqual({ ok: true });
    expect(verifyChain([])).toEqual({ ok: true });
  });

  it('detects a tampered transaction', () => {
    const chain = makeChain(4);
    const target = chain[2];
    if (!target) throw new Error('fixture');
    chain[2] = { ...target, total_ttc_cents: target.total_ttc_cents + 1 };
    const result = verifyChain(chain);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.first_break.ticket_number).toBe(3);
    expect(result.first_break.reason).toBe('HASH_MISMATCH');
    expect(result.first_break.actual).toBe(target.hash);
    expect(result.first_break.expected).toMatch(HEX64);
    expect(result.first_break.expected).not.toBe(target.hash);
  });

  it('detects a broken prev_hash link', () => {
    const chain = makeChain(3);
    const third = chain[2];
    if (!third) throw new Error('fixture');
    const rewritten = { ...third, prev_hash: 'b'.repeat(64) };
    chain[2] = { ...rewritten, hash: computeTransactionHash(rewritten) };
    const result = verifyChain(chain);
    expect(result).toMatchObject({
      ok: false,
      first_break: {
        ticket_number: 3,
        reason: 'PREV_HASH_MISMATCH',
        expected: chain[1]?.hash,
        actual: 'b'.repeat(64),
      },
    });
  });

  it('detects a ticket numbering gap', () => {
    const chain = makeChain(4);
    const result = verifyChain(
      [chain[0], chain[1], chain[3]].filter((t): t is ChainedTxn => t !== undefined),
    );
    expect(result).toMatchObject({
      ok: false,
      first_break: { ticket_number: 4, reason: 'TICKET_GAP', expected: '3', actual: '4' },
    });
  });
});
