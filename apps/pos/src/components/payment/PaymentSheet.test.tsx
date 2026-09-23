import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { computeCart } from '@pos/core';

vi.mock('@/lib/events', () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/edge', () => ({
  edge: { checkout: vi.fn(), resolvePrices: vi.fn(async () => []) },
  ApiError: class ApiError extends Error {
    constructor(public code: string) {
      super(code);
    }
  },
  isApiError: () => false,
  isNetworkError: () => false,
  describeApiError: (e: unknown) => (e instanceof Error ? e.message : 'err'),
}));
vi.mock('@/lib/bridge', () => ({
  bridge: {
    print: vi.fn(async () => ({ ok: true })),
    openDrawer: vi.fn(async () => ({ ok: true })),
    pay: vi.fn(),
    cancelPayment: vi.fn(),
    subscribeEvents: () => () => undefined,
    health: vi.fn(),
  },
}));
vi.mock('@/lib/db', () => ({
  saveReceipt: vi.fn(async () => undefined),
  enqueueCheckout: vi.fn(async () => undefined),
}));

import { PaymentSheet } from './PaymentSheet';
import { useSessionStore } from '@/stores/sessionStore';

const totals = computeCart([
  {
    line_no: 1,
    label: 'Stylo',
    qty: 1,
    unit_price_ttc_cents: 1000,
    vat_rate: 20,
    discount_percent: 0,
  },
]);

function renderSheet() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <PaymentSheet open onOpenChange={() => undefined} totals={totals} />
    </QueryClientProvider>,
  );
}

describe('PaymentSheet', () => {
  beforeEach(() => {
    useSessionStore.setState({
      register: {
        id: '11111111-1111-4111-8111-111111111111',
        code: 'TEST-01',
        label: null,
        is_active: true,
      },
      session: {
        id: '55555555-5555-4555-8555-000000000001',
        register_id: '11111111-1111-4111-8111-111111111111',
        session_number: 1,
        opened_by: null,
        opened_at: new Date().toISOString(),
        opening_float_cents: 0,
        closed_by: null,
        closed_at: null,
        counted_cash_cents: null,
        expected_cash_cents: null,
        variance_cents: null,
        closing_id: null,
        notes: null,
        status: 'open',
      },
    });
  });

  it('ajoute un paiement espèces avec rendu et active la validation', () => {
    renderSheet();
    expect(screen.getByTestId('remaining')).toHaveTextContent('10,00');
    expect(screen.getByTestId('validate-payment')).toBeDisabled();

    fireEvent.click(screen.getByTestId('pay-cash'));
    fireEvent.click(screen.getByTestId('cash-shortcut-2000'));
    expect(screen.getByTestId('cash-tendered')).toHaveTextContent('20,00');
    expect(screen.getByTestId('cash-change')).toHaveTextContent('10,00');
    fireEvent.click(screen.getByTestId('cash-confirm'));

    const list = screen.getByTestId('payment-list');
    expect(within(list).getByText('Espèces')).toBeInTheDocument();
    expect(screen.getByTestId('change-total')).toHaveTextContent('10,00');
    expect(screen.getByTestId('remaining')).toHaveTextContent('0,00');
    expect(screen.getByTestId('validate-payment')).toBeEnabled();
  });

  it('laisse la validation désactivée tant que les paiements ne couvrent pas le total', () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('pay-cheque'));
    const form = screen.getByTestId('reference-form-cheque');
    const inputs = within(form).getAllByRole('textbox');
    fireEvent.change(inputs[0] as HTMLElement, { target: { value: 'CHQ 123' } });
    fireEvent.change(inputs[1] as HTMLElement, { target: { value: '4,00' } });
    fireEvent.submit(form);

    expect(screen.getByTestId('remaining')).toHaveTextContent('6,00');
    expect(screen.getByTestId('validation-message')).toBeInTheDocument();
    expect(screen.getByTestId('validate-payment')).toBeDisabled();

    // Retrait du paiement partiel → retour à l'état initial.
    fireEvent.click(screen.getByLabelText('Retirer'));
    expect(screen.getByTestId('remaining')).toHaveTextContent('10,00');
    expect(screen.queryByTestId('validation-message')).not.toBeInTheDocument();
  });
});
