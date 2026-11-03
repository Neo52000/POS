import { describe, expect, it } from 'vitest';

import {
  buildCashMovementVoucher,
  cashMovementSign,
  cashMovementTotals,
  type CashMovementFigure,
} from './cashMovement.js';
import { formatEurCents } from './money.js';
import { buildReport, type ReportFigures } from './report.js';

const header = {
  company_name: 'Ma Papeterie',
  address_lines: ['Chaumont'],
  siret: '1',
  vat_number: 'FR1',
};

const mv = (
  kind: CashMovementFigure['kind'],
  amount: number,
  patch: Partial<CashMovementFigure> = {},
): CashMovementFigure => ({
  kind,
  amount_cents: amount,
  reason: 'Remise BNP',
  reference: null,
  created_at: '2026-11-03T14:05:00.000Z',
  ...patch,
});

const base: ReportFigures = {
  txn_count: 1,
  first_ticket_number: 1,
  last_ticket_number: 1,
  total_ht_cents: 1000,
  total_vat_cents: 200,
  total_ttc_cents: 1200,
  refunds_ttc_cents: 0,
  vat_breakdown: [],
  payments: [{ method: 'cash', amount_cents: 1200, count: 1 }],
};

const rows = (r: ReturnType<typeof buildReport>) =>
  r.sections.flatMap((s) => s.rows.map((x) => `${s.title ?? ''}|${x.label}|${x.value ?? ''}`));

describe('mouvements d’espèces', () => {
  it('sens et totaux : apports positifs, remises et retraits négatifs', () => {
    expect(cashMovementSign('cash_in')).toBe(1);
    expect(cashMovementSign('bank_deposit')).toBe(-1);
    expect(
      cashMovementTotals([mv('bank_deposit', 25000), mv('withdrawal', 2000), mv('cash_in', 5000)]),
    ).toEqual({ in_cents: 5000, out_cents: 27000, net_cents: -22000 });
    expect(cashMovementTotals([])).toEqual({ in_cents: 0, out_cents: 0, net_cents: 0 });
  });

  it('rapport : apports / sorties au tiroir et section détaillée, rien sans mouvement', () => {
    const r = buildReport(
      {
        ...base,
        cash: {
          opening_float_cents: 10000,
          expected_cash_cents: 10000 + 1200 - 25000 + 5000,
          movements: [mv('bank_deposit', 25000, { reference: 'B-42' }), mv('cash_in', 5000)],
        },
      },
      {
        kind: 'X',
        register_code: 'C1',
        header,
        period_start: '2026-11-03T07:00:00.000Z',
        period_end: null,
        printed_at: '2026-11-03T16:00:00.000Z',
        app_version: '0.5.0',
      },
    );
    const lines = rows(r);
    expect(lines).toContain(`Tiroir espèces|Apports|${formatEurCents(5000)}`);
    expect(lines).toContain(`Tiroir espèces|Sorties (banque, retraits)|${formatEurCents(-25000)}`);
    expect(lines).toContain(`Tiroir espèces|Espèces attendues|${formatEurCents(-8800)}`);
    expect(lines).toContain(
      `Mouvements d'espèces|15:05 Remise en banque|${formatEurCents(-25000)}`,
    );
    expect(lines).toContain("Mouvements d'espèces|  Remise BNP · réf. B-42|");
    expect(lines).toContain(`Mouvements d'espèces|Total sorties|${formatEurCents(-25000)}`);

    const none = buildReport(
      { ...base, cash: { opening_float_cents: 0, expected_cash_cents: 1200 } },
      {
        kind: 'X',
        register_code: 'C1',
        header,
        period_start: '2026-11-03T07:00:00.000Z',
        period_end: null,
        printed_at: '2026-11-03T16:00:00.000Z',
        app_version: '0.5.0',
      },
    );
    expect(none.sections.some((s) => s.title === "Mouvements d'espèces")).toBe(false);
    expect(rows(none).some((l) => l.includes('Apports'))).toBe(false);
  });

  it('bon imprimé : compatible pont (kind X), non fiscal, montant et motif', () => {
    const v = buildCashMovementVoucher(mv('bank_deposit', 25000, { reference: 'B-42' }), {
      register_code: 'C1',
      header,
      session_number: 7,
      operator: 'vendeur',
      app_version: '0.5.0',
    });
    expect(v.kind).toBe('X');
    expect(v.title).toBe("MOUVEMENT D'ESPÈCES");
    expect(v.subtitle).toBe('Document non fiscal');
    const flat = v.sections.flatMap((s) => s.rows.map((x) => `${x.label}=${x.value ?? ''}`));
    expect(flat).toEqual(
      expect.arrayContaining([
        'Session=n°7',
        'Type=Remise en banque',
        `Montant=${formatEurCents(25000)}`,
        'Sens=Sortie tiroir',
        'Référence=B-42',
      ]),
    );
  });
});
