import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutPayload } from '@pos/core';

const checkoutMock = vi.fn();
const rpcMock = vi.fn(async (..._args: unknown[]) => ({ data: 1, error: null }));
const payMock = vi.fn();

vi.mock('@/lib/edge', () => ({ edge: { checkout: (p: unknown) => checkoutMock(p) } }));
vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
    from: () => ({ select: async () => ({ data: [], error: null }) }),
  },
  rpc: vi.fn(),
}));
vi.mock('@/lib/bridge', () => ({
  bridge: { pay: (r: unknown) => payMock(r), subscribeEvents: () => () => undefined },
}));

import { renderHook, act } from '@testing-library/react';
import { submitCheckout } from '@/hooks/useCheckout';
import { useTpePayment } from '@/hooks/useTpePayment';
import { logEvent } from '@/lib/events';
import { trainingXReport } from '@/lib/reports';
import { startTraining, stopTraining, trainingSwitchBlocker } from '@/lib/training';
import { useCartStore } from '@/stores/cartStore';
import { useParkedStore } from '@/stores/parkedStore';
import { useTrainingStore } from '@/stores/trainingStore';
import type { ParkedCart } from '@/stores/parkedStore';

function payload(): CheckoutPayload {
  return {
    client_txn_id: '00000000-0000-4000-8000-000000000001',
    register_id: '11111111-1111-4111-8111-111111111111',
    session_id: '00000000-0000-4000-8000-000000000000',
    kind: 'sale',
    business_at: new Date().toISOString(),
    offline_queued: false,
    invoice_requested: false,
    lines: [
      {
        line_no: 1,
        label: 'Stylo',
        qty: 2,
        unit_price_ttc_cents: 150,
        vat_rate: '20.00',
        discount_percent: 0,
        eco_tax_cents: 0,
      },
    ],
    payments: [{ method: 'cash', amount_cents: 500 }],
    change_cents: 200,
    totals: { total_ht_cents: 250, total_vat_cents: 50, total_ttc_cents: 300 },
    app_version: 'test',
  };
}

const CTX = { register_code: 'C1', cashier_name: 'marie', settings: null };

const eventTypes = (): unknown[] =>
  rpcMock.mock.calls
    .filter((c) => c[0] === 'pos_log_event')
    .map((c) => (c[1] as { p_event_type: string }).p_event_type);

beforeEach(() => {
  localStorage.clear();
  rpcMock.mockClear();
  checkoutMock.mockReset();
  payMock.mockReset();
  useCartStore.setState({ lines: [], quote_id: null, global_discount_percent: 0 });
  useParkedStore.setState({ parked: [] });
  useTrainingStore.getState().end();
});

describe('mode formation', () => {
  it('refuse d’entrer avec un panier non vide', () => {
    useCartStore.setState({ lines: [{ key: 'x' } as never] });
    expect(trainingSwitchBlocker()).toMatch(/panier/);
    expect(() => startTraining()).toThrow(/panier/);
    expect(useTrainingStore.getState().active).toBe(false);
  });

  it('vente locale FORM-0001, jamais envoyée, TPE simulé, journal muet', async () => {
    const parked = [{ id: 'p1' } as ParkedCart];
    useParkedStore.setState({ parked });
    startTraining();
    await vi.waitFor(() => expect(eventTypes()).toEqual(['training_mode_start']));
    expect(useTrainingStore.getState().active).toBe(true);
    expect(useParkedStore.getState().parked).toEqual([]);

    const outcome = await submitCheckout({ payload: payload(), context: CTX });
    expect(outcome.status).toBe('training');
    expect(outcome.ticket.ticket_code).toBe('FORM-0001');
    expect(outcome.ticket.compliance).toMatchObject({ training: true, hash_short: '' });
    expect(outcome.ticket.total_ttc_cents).toBe(300);
    expect(checkoutMock).not.toHaveBeenCalled();

    const { result } = renderHook(() => useTpePayment());
    let tpe: Awaited<ReturnType<typeof result.current.pay>> | undefined;
    await act(async () => {
      tpe = await result.current.pay(300);
    });
    expect(tpe?.status).toBe('approved');
    expect(payMock).not.toHaveBeenCalled();

    await logEvent('line_discount', { x: 1 });
    await logEvent('drawer_opened', { reason: 'test' });
    expect(eventTypes()).toEqual(['training_mode_start', 'drawer_opened']);
    const drawer = rpcMock.mock.calls.find(
      (c) => (c[1] as { p_event_type: string }).p_event_type === 'drawer_opened',
    );
    expect((drawer?.[1] as { p_payload: { training?: boolean } }).p_payload.training).toBe(true);

    const x = trainingXReport(useTrainingStore.getState().tickets, {
      registerCode: 'C1',
      startedAt: useTrainingStore.getState().startedAt,
    });
    expect(x.training).toBe(true);
    expect(x.sections.flatMap((s) => s.rows).find((r) => r.label === 'Tickets')?.value).toBe('1');

    stopTraining();
    expect(useTrainingStore.getState()).toMatchObject({ active: false, tickets: [] });
    expect(useParkedStore.getState().parked).toEqual(parked);
    await vi.waitFor(() =>
      expect(eventTypes()).toEqual(['training_mode_start', 'drawer_opened', 'training_mode_end']),
    );
  });
});
