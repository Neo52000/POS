import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ rpc: vi.fn(), supabase: {} }));

import { formatEurCents } from '@pos/core';
import { closedDays, groupPayments, paymentSummary, type TicketPayment } from './useTodayTickets';

const p = (transaction_id: string, method: TicketPayment['method'], amount_cents: number) => ({
  transaction_id,
  method,
  amount_cents,
});

describe('règlements des tickets du jour', () => {
  it('regroupe par ticket', () => {
    const m = groupPayments([p('t1', 'cb', 500), p('t2', 'cash', 100), p('t1', 'cheque', 200)]);
    expect(m.get('t1')?.map((x) => x.method)).toEqual(['cb', 'cheque']);
    expect(m.get('t2')).toHaveLength(1);
  });

  it('libellé : un moyen seul, plusieurs avec montants, remboursement en absolu, aucun', () => {
    expect(paymentSummary([p('t', 'cb', 8718)])).toBe('Carte bancaire');
    expect(paymentSummary([p('t', 'cb', 5000), p('t', 'cash', 3718)])).toBe(
      `Carte bancaire ${formatEurCents(5000)} · Espèces ${formatEurCents(3718)}`,
    );
    expect(paymentSummary([p('t', 'cheque', -1200), p('t', 'transfer', -100)])).toBe(
      `Chèque ${formatEurCents(1200)} · Virement ${formatEurCents(100)}`,
    );
    expect(paymentSummary([])).toBe('');
  });
});

describe('jours clôturés', () => {
  const z = (n: number, start: string, ttc: number, count = 1) => ({
    closing_number: n,
    period_start: start,
    total_ttc_cents: ttc,
    txn_count: count,
  });

  it('du plus récent au plus ancien, hors aujourd’hui, date métier Europe/Paris', () => {
    const days = closedDays(
      [
        z(3, '2026-11-03T07:00:00Z', 900),
        z(2, '2026-11-02T07:00:00Z', 500),
        // 23h30 UTC le 31/10 = 00h30 Paris le 01/11
        z(1, '2026-10-31T23:30:00Z', 100),
      ],
      '2026-11-03',
    );
    expect(days.map((d) => d.date)).toEqual(['2026-11-02', '2026-11-01']);
  });

  it('agrège plusieurs Z le même jour', () => {
    const [d] = closedDays(
      [z(5, '2026-11-02T07:00:00Z', 500, 2), z(6, '2026-11-02T14:00:00Z', 300, 1)],
      '2026-11-03',
    );
    expect(d).toEqual({
      date: '2026-11-02',
      closing_number: 6,
      total_ttc_cents: 800,
      txn_count: 3,
    });
  });
});
