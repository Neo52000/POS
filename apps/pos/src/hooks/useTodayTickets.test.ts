import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ rpc: vi.fn(), supabase: {} }));

import { formatEurCents } from '@pos/core';
import { groupPayments, paymentSummary, type TicketPayment } from './useTodayTickets';

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
