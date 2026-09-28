import { describe, expect, it } from 'vitest';

import {
  buildReport,
  formatReportPeriod,
  normalizePaymentFigures,
  summarizeTickets,
  type ReportContext,
  type ReportFigures,
} from './report.js';

const header = {
  company_name: 'Ma Papeterie',
  address_lines: ['Chaumont'],
  siret: '1',
  vat_number: 'FR1',
};

const figures: ReportFigures = {
  txn_count: 3,
  sales_count: 2,
  refunds_count: 1,
  first_ticket_number: 10,
  last_ticket_number: 12,
  total_ht_cents: 2500,
  total_vat_cents: 500,
  total_ttc_cents: 3000,
  refunds_ttc_cents: -600,
  vat_breakdown: [{ rate: '20.00', base_ht_cents: 2500, vat_cents: 500, ttc_cents: 3000 }],
  payments: [
    { method: 'cash', amount_cents: 2000, count: 1 },
    { method: 'cb', amount_cents: 1600, count: 1 },
  ],
  change_cents: 0,
  cash: { opening_float_cents: 10000, expected_cash_cents: 12000 },
  grand_total_perpetual_cents: 99000,
};

const ctx = (patch: Partial<ReportContext> = {}): ReportContext => ({
  kind: 'X',
  register_code: 'C1',
  header,
  period_start: '2026-09-28T07:00:00.000Z',
  period_end: null,
  printed_at: '2026-09-28T16:30:00.000Z',
  app_version: '0.3.0',
  ...patch,
});

const flat = (r: ReturnType<typeof buildReport>): string =>
  r.sections
    .flatMap((s) => [s.title ?? '', ...s.rows.map((x) => `${x.label}=${x.value ?? ''}`)])
    .join('\n');

describe('buildReport', () => {
  it('X : non fiscal, période ouverte, GT projeté, tiroir', () => {
    const r = buildReport(figures, ctx({ number: 42, session_number: 7, operator: 'marie' }));
    expect(r.title).toBe('LECTURE X');
    expect(r.subtitle).toBe('Document non fiscal');
    const text = flat(r);
    expect(text).toContain('Lecture n°=42');
    expect(text).toContain('Session=n°7');
    expect(text).toContain('Période=depuis 28/09/2026 09:00');
    expect(text).toContain('Ventes TTC=36,00');
    expect(text).toContain('Remboursements TTC=-6,00');
    expect(text).toContain('TOTAL TTC NET=30,00');
    expect(text).toContain('Espèces (1)=20,00');
    expect(text).toContain('Carte bancaire (1)=16,00');
    expect(text).toContain('Espèces attendues=120,00');
    expect(text).toContain('Grand total perpétuel (projeté)=990,00');
    expect(r.footer.join(' ')).toContain('seul le Z fait foi');
    expect(r.training).toBeUndefined();
  });

  it('Z2 / Z3 : libellé de période et empreinte', () => {
    const z2 = buildReport(
      { ...figures, cash: undefined },
      ctx({
        kind: 'Z2',
        period_start: '2026-08-31T22:00:00.000Z',
        period_end: '2026-09-30T22:00:00.000Z',
        hash: 'abcdef0123456789abcdef',
        number: 31,
      }),
    );
    expect(z2.title).toBe('CLÔTURE MENSUELLE Z2');
    expect(flat(z2)).toContain('Période=septembre 2026');
    expect(flat(z2)).not.toContain('Tiroir');
    expect(z2.footer).toEqual(['Empreinte abcdef0123456789']);
    const z3 = buildReport(
      figures,
      ctx({
        kind: 'Z3',
        period_start: '2025-12-31T23:00:00.000Z',
        period_end: '2026-12-31T23:00:00.000Z',
      }),
    );
    expect(z3.title).toBe('CLÔTURE ANNUELLE Z3');
    expect(flat(z3)).toContain('Période=2026');
  });

  it('formation et duplicata marqués', () => {
    const r = buildReport(figures, ctx({ kind: 'Z1', training: true, duplicate: true }));
    expect(r.training).toBe(true);
    expect(r.duplicate).toBe(true);
    expect(r.footer.at(-1)).toContain('MODE FORMATION');
  });
});

describe('formatReportPeriod', () => {
  it('Z1 : bornes en heure de Paris', () => {
    expect(formatReportPeriod('Z1', '2026-09-28T07:00:00.000Z', '2026-09-28T17:05:00.000Z')).toBe(
      '28/09/2026 09:00 → 28/09/2026 19:05',
    );
  });
});

describe('normalizePaymentFigures', () => {
  it('accepte les formats tableau (SQL) et objet (mock)', () => {
    expect(normalizePaymentFigures([{ method: 'cb', amount_cents: 100, count: 2 }])).toEqual([
      { method: 'cb', amount_cents: 100, count: 2 },
    ]);
    expect(normalizePaymentFigures({ cash: 50 })).toEqual([{ method: 'cash', amount_cents: 50 }]);
    expect(normalizePaymentFigures(null)).toEqual([]);
  });
});

describe('summarizeTickets', () => {
  it('additionne tickets, TVA et paiements', () => {
    const sale = {
      kind: 'sale' as const,
      ticket_number: 1,
      total_ht_cents: 1000,
      total_vat_cents: 200,
      total_ttc_cents: 1200,
      change_cents: 800,
      vat_breakdown: [{ rate: '20.00', base_ht_cents: 1000, vat_cents: 200, ttc_cents: 1200 }],
      payments: [{ method: 'cash', amount_cents: 2000 }],
    };
    const refund = {
      ...sale,
      kind: 'refund' as const,
      ticket_number: 2,
      total_ht_cents: -500,
      total_vat_cents: -100,
      total_ttc_cents: -600,
      change_cents: 0,
      vat_breakdown: [{ rate: '20.00', base_ht_cents: -500, vat_cents: -100, ttc_cents: -600 }],
      payments: [{ method: 'cash', amount_cents: -600 }],
    };
    const f = summarizeTickets([sale, refund]);
    expect(f).toMatchObject({
      txn_count: 2,
      sales_count: 1,
      refunds_count: 1,
      first_ticket_number: 1,
      last_ticket_number: 2,
      total_ttc_cents: 600,
      refunds_ttc_cents: -600,
      change_cents: 800,
      vat_breakdown: [{ rate: '20.00', base_ht_cents: 500, vat_cents: 100, ttc_cents: 600 }],
      payments: [{ method: 'cash', amount_cents: 1400, count: 2 }],
    });
  });
});
