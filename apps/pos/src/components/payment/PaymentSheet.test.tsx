import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
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
vi.mock('@/lib/offlineQueue', () => ({
  DEFAULT_OFFLINE_LIMITS: { offline_max_txns: 50, offline_max_hours: 24 },
  queueStats: vi.fn(async () => ({
    pending: 0,
    failed: 0,
    done: 0,
    abandoned: 0,
    oldestBusinessAt: null,
  })),
  getOfflineLimits: vi.fn(async () => ({ offline_max_txns: 50, offline_max_hours: 24 })),
  evaluateOfflineLimits: () => ({ blocked: false, reason: null, message: null, limits: {} }),
  queueOfflineSale: vi.fn(),
  enqueueSale: vi.fn(),
}));

import { PaymentSheet } from './PaymentSheet';
import { edge } from '@/lib/edge';
import { useCheckoutDraftStore } from '@/stores/checkoutDraftStore';
import type { CheckoutDraft } from '@/stores/checkoutDraftStore';
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

function renderSheet(t = totals, onOpenChange: (open: boolean) => void = () => undefined) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <PaymentSheet open onOpenChange={onOpenChange} totals={t} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const CAPTURED_DRAFT: CheckoutDraft = {
  client_txn_id: '99999999-9999-4999-8999-999999999999',
  lines: [],
  quote_id: null,
  account: null,
  payments: [
    {
      key: 'p1',
      method: 'cb',
      amount_cents: 1000,
      tpe_response: { approved: true },
      captured: true,
    },
  ],
  change_cents: 0,
  invoice_requested: false,
  updated_at: '2026-09-26T10:00:00.000Z',
};

describe('PaymentSheet', () => {
  beforeEach(() => {
    localStorage.clear();
    useCheckoutDraftStore.setState({ draft: null });
    vi.mocked(edge.checkout).mockReset();
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

  it('persiste un brouillon dès le premier paiement', () => {
    renderSheet();
    fireEvent.click(screen.getByTestId('pay-cash'));
    fireEvent.click(screen.getByTestId('cash-shortcut-2000'));
    fireEvent.click(screen.getByTestId('cash-confirm'));
    const draft = useCheckoutDraftStore.getState().draft;
    expect(draft?.payments).toHaveLength(1);
    expect(draft?.change_cents).toBe(1000);
    expect(localStorage.getItem('pos.checkout-draft.v1')).toContain(draft?.client_txn_id);
  });

  it('reprend un brouillon avec CB captée et interdit le retour au panier', () => {
    useCheckoutDraftStore.setState({ draft: CAPTURED_DRAFT });
    const onOpenChange = vi.fn();
    renderSheet(totals, onOpenChange);
    expect(screen.getByTestId('remaining')).toHaveTextContent('0,00');
    expect(screen.getByLabelText('Paiement CB capturé')).toBeInTheDocument();
    expect(screen.getByTestId('back-to-cart')).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('payment-sheet'), { key: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId('validate-payment')).toBeEnabled();
  });

  it('ne soumet qu’une fois sur un double tap et réutilise le client_txn_id du brouillon', async () => {
    useCheckoutDraftStore.setState({ draft: CAPTURED_DRAFT });
    vi.mocked(edge.checkout).mockImplementation(() => new Promise(() => undefined));
    renderSheet();
    const validate = screen.getByTestId('validate-payment');
    fireEvent.click(validate);
    fireEvent.click(validate);
    await waitFor(() => expect(edge.checkout).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(edge.checkout).toHaveBeenCalledTimes(1);
    expect(vi.mocked(edge.checkout).mock.calls[0]?.[0]).toMatchObject({
      client_txn_id: CAPTURED_DRAFT.client_txn_id,
      payments: [{ method: 'cb', amount_cents: 1000 }],
    });
  });

  it('valide une vente à 0 € sans paiement (espèces 0 € enregistré)', async () => {
    const free = computeCart([
      {
        line_no: 1,
        label: 'Cadeau',
        qty: 1,
        unit_price_ttc_cents: 500,
        vat_rate: 20,
        discount_percent: 100,
      },
    ]);
    vi.mocked(edge.checkout).mockImplementation(() => new Promise(() => undefined));
    renderSheet(free);
    expect(screen.getByTestId('payment-list')).toHaveTextContent('aucun paiement requis');
    const validate = screen.getByTestId('validate-payment');
    expect(validate).toBeEnabled();
    fireEvent.click(validate);
    await waitFor(() => expect(edge.checkout).toHaveBeenCalled());
    expect(vi.mocked(edge.checkout).mock.calls[0]?.[0]).toMatchObject({
      payments: [{ method: 'cash', amount_cents: 0 }],
      change_cents: 0,
    });
  });

  it('conserve les paiements d’un remboursement quand le parent se re-rend', () => {
    const refundTotals = computeCart([
      {
        line_no: 1,
        label: 'Stylo',
        qty: -1,
        unit_price_ttc_cents: 1000,
        vat_rate: 20,
        discount_percent: 0,
      },
    ]);
    const qc = new QueryClient();
    const ui = (reason: string) => (
      <QueryClientProvider client={qc}>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <PaymentSheet
            open
            onOpenChange={() => undefined}
            totals={refundTotals}
            refund={{ transaction_id: '77777777-7777-4777-8777-777777777777', reason }}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { rerender } = render(ui('Défaut'));
    fireEvent.click(screen.getByTestId('pay-cash'));
    fireEvent.click(screen.getByTestId('cash-confirm'));
    expect(screen.getByTestId('remaining')).toHaveTextContent('0,00');
    // Nouvel objet `refund` (littéral recréé par le parent) : les paiements restent.
    rerender(ui('Défaut'));
    expect(screen.getByTestId('remaining')).toHaveTextContent('0,00');
    expect(within(screen.getByTestId('payment-list')).getByText('Espèces')).toBeInTheDocument();
    expect(useCheckoutDraftStore.getState().draft).toBeNull();
  });
});
