import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  convertRows,
  deterministicUuid,
  legacyTicketNumber,
  parseCsv,
  parseDateTime,
  parseNumber,
  parseVatRate,
  paymentMethod,
  resolveColumns,
  summarize,
} from './convert.ts';

const OPTS = { source: 'test', register: '1', before: null, defaultVatRate: 20 };

function load(file = new URL('./exemple.csv', import.meta.url)) {
  const [header, ...rows] = parseCsv(readFileSync(file, 'utf8'));
  return { header: header!, rows, columns: resolveColumns(header!) };
}

describe('lecture', () => {
  it('CSV : séparateur ; détecté, guillemets, BOM', () => {
    expect(parseCsv('﻿a;b\n"x;y";"z ""q"""\n')).toEqual([
      ['a', 'b'],
      ['x;y', 'z "q"'],
    ]);
  });

  it('nombres français et anglo-saxons', () => {
    expect(parseNumber('1 234,56 €')).toBe(1234.56);
    expect(parseNumber('1,234.56')).toBe(1234.56);
    expect(parseNumber('(3,20)')).toBe(-3.2);
    expect(parseNumber('abc')).toBeNull();
  });

  it('dates en heure de Paris (été / hiver)', () => {
    expect(parseDateTime('02/07/2026', '09:41')).toEqual({
      iso: '2026-07-02T07:41:00.000Z',
      day: '2026-07-02',
    });
    expect(parseDateTime('2026-01-15 09:41')?.iso).toBe('2026-01-15T08:41:00.000Z');
    expect(parseDateTime('15/01/26')?.day).toBe('2026-01-15');
    expect(parseDateTime('32/01/2026')).toBeNull();
  });

  it('TVA, moyens de paiement, identifiants stables', () => {
    expect(parseVatRate('5,5%')).toBe(5.5);
    expect(parseVatRate('0.2')).toBe(20);
    expect(parseVatRate('7')).toBeNull();
    expect(paymentMethod('Carte bancaire')).toBe('cb');
    expect(paymentMethod('Espèces')).toBe('cash');
    expect(paymentMethod('Chèque cadeau UCIA')).toBe('gift_ucia');
    expect(deterministicUuid('a')).toBe(deterministicUuid('a'));
    expect(deterministicUuid('a')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(legacyTicketNumber('2026-07-02', '1')).toBe(20260702000001);
  });

  it('colonnes françaises reconnues automatiquement, --map prioritaire', () => {
    const { header, columns } = load();
    expect(columns).toMatchObject({
      date: 0,
      time: 1,
      ticket: 2,
      register: 3,
      label: 4,
      ean: 5,
      qty: 6,
      line_ttc: 7,
      vat_rate: 8,
      payment: 9,
    });
    expect(resolveColumns(header, { label: 'EAN' }).label).toBe(5);
    expect(() => resolveColumns(header, { label: 'Absente' })).toThrow(/absente/);
  });
});

describe('conversion', () => {
  it('regroupe en tickets, calcule HT/TVA, remboursement négatif', () => {
    const { rows, columns } = load();
    const r = convertRows(rows, columns, OPTS);
    expect(r.rejected).toEqual([]);
    expect(r.sales).toHaveLength(4);
    const t1 = r.sales[0]!;
    expect(t1).toMatchObject({
      register_code: 'HIST-1',
      kind: 'sale',
      business_date: '2026-07-02',
      total_ttc_cents: 1290,
      signature_status: 'legacy_import',
      payments: [{ method: 'cash', amount_cents: 1290 }],
    });
    expect(t1.vat_breakdown).toEqual([
      { rate: '5.50', base_ht_cents: 749, vat_cents: 41, ttc_cents: 790 },
      { rate: '20.00', base_ht_cents: 417, vat_cents: 83, ttc_cents: 500 },
    ]);
    expect(t1.total_ht_cents + t1.total_vat_cents).toBe(t1.total_ttc_cents);
    const refund = r.sales.find((s) => s.kind === 'refund')!;
    expect(refund).toMatchObject({ total_ttc_cents: -250, total_ht_cents: -208 });
    expect(refund.lines[0]!.qty).toBe(-1);
    expect(r.sales.at(-1)!.total_ttc_cents).toBe(123456);
    const sum = summarize(r.sales);
    expect(sum).toMatchObject({
      tickets: 3,
      refunds: 1,
      lines: 5,
      totalTtcCents: 1290 + 2691 - 250 + 123456,
    });
    expect(sum.byMonth).toEqual([
      { month: '2026-07', tickets: 3, ttc_cents: 1290 + 2691 - 250 + 123456 },
    ]);
  });

  it('écarte la période déjà présente dans le dashboard', () => {
    const { rows, columns } = load();
    const r = convertRows(rows, columns, { ...OPTS, before: '2026-07-03' });
    expect(r.skippedOverlap).toBe(2);
    expect(r.sales.every((s) => s.business_date < '2026-07-03')).toBe(true);
  });

  it('rejets et avertissements ligne par ligne, sans bloquer les autres', () => {
    const { columns } = load();
    const rows = [
      ['xx/07/2026', '', '1', '1', 'A', '', '1', '1,00', '20', ''],
      ['02/07/2026', '', '', '1', 'B', '', '1', '1,00', '20', ''],
      ['02/07/2026', '', '9', '1', 'C', '', '1', 'n/a', '20', ''],
      ['02/07/2026', '', '9', '1', 'D', '', '1', '2,00', '', ''],
    ];
    const r = convertRows(rows, columns, OPTS);
    expect(r.rejected.map((x) => x.row)).toEqual([2, 3, 4]);
    expect(r.warnings).toHaveLength(1);
    expect(r.sales).toHaveLength(1);
  });

  it('prix unitaire × quantité si pas de total ligne', () => {
    const header = ['Date', 'Ticket', 'Article', 'Qté', 'PU TTC'];
    const r = convertRows(
      [['01/06/2026', '4', 'Gomme', '3', '0,80']],
      resolveColumns(header),
      OPTS,
    );
    expect(r.sales[0]!.total_ttc_cents).toBe(240);
    expect(r.warnings).toHaveLength(1); // TVA absente → 20 %
  });
});
