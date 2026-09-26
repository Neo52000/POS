import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/events', () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/edge', () => ({ edge: { resolvePrices: vi.fn(async () => []) } }));
vi.mock('@/lib/supabase', () => ({ rpc: vi.fn(async () => false), supabase: {} }));

import { logEvent } from '@/lib/events';
import { useCartStore } from '@/stores/cartStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { PosProduct } from '@/types/pos';
import { CartPanel } from './CartPanel';

const BIC: PosProduct = {
  id: 'a0000000-0000-4000-8000-000000000001',
  name: 'Stylo BIC',
  brand: 'BIC',
  ean: '3086123101227',
  image_url: null,
  price_ttc_cents: 120,
  price_ht_cents: 100,
  vat_rate: 20,
  eco_tax_cents: 0,
  stock_boutique: 5,
  pos_price_tiers: null,
};

function renderPanel(overrides: Partial<Parameters<typeof CartPanel>[0]> = {}) {
  const props = {
    onCheckout: vi.fn(),
    onCustomer: vi.fn(),
    onQuotes: vi.fn(),
    onPark: vi.fn(),
    onShowParked: vi.fn(),
    parkedCount: 0,
    pricingBusy: false,
    onModalChange: vi.fn(),
    onGlobalDiscount: vi.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CartPanel {...props} />
    </QueryClientProvider>,
  );
  return props;
}

describe('CartPanel', () => {
  beforeEach(() => {
    localStorage.clear();
    useCartStore.setState({ lines: [], quote_id: null, locked: false });
    useSettingsStore.setState({ maxDiscountPercent: 30 });
    useSessionStore.setState({ user: null });
    vi.mocked(logEvent).mockClear();
  });

  it('demande confirmation avant de vider le panier', () => {
    useCartStore.getState().addProduct(BIC, { qty: 2 });
    const props = renderPanel();
    fireEvent.click(screen.getByTestId('clear-cart'));
    expect(props.onModalChange).toHaveBeenLastCalledWith(true);
    expect(useCartStore.getState().lines).toHaveLength(1);
    fireEvent.click(within(screen.getByTestId('confirm-dialog')).getByText('Annuler'));
    expect(useCartStore.getState().lines).toHaveLength(1);
    expect(logEvent).not.toHaveBeenCalledWith('sale_abandoned', expect.anything());

    fireEvent.click(screen.getByTestId('clear-cart'));
    fireEvent.click(screen.getByTestId('confirm-action'));
    expect(useCartStore.getState().lines).toHaveLength(0);
    expect(logEvent).toHaveBeenCalledWith(
      'sale_abandoned',
      expect.objectContaining({ reason: 'abandoned' }),
    );
  });

  it('saisit une quantité décimale au pavé', () => {
    useCartStore.getState().addProduct(BIC);
    renderPanel();
    fireEvent.click(screen.getByTestId('line-qty'));
    fireEvent.change(screen.getByTestId('qty-input'), { target: { value: '2,5' } });
    fireEvent.click(screen.getByTestId('apply-qty'));
    expect(useCartStore.getState().lines[0]?.qty).toBe(2.5);
    expect(screen.getByTestId('cart-total')).toHaveTextContent('3,00');
  });

  it('bloque une remise au-delà du plafond pour un vendeur', () => {
    useCartStore.getState().addProduct(BIC);
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Remise' }));
    fireEvent.change(screen.getByLabelText('Remise en pourcentage'), { target: { value: '40' } });
    expect(screen.getByTestId('discount-cap')).toBeInTheDocument();
    expect(screen.getByTestId('apply-discount')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Remise en pourcentage'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('apply-discount'));
    expect(useCartStore.getState().lines[0]?.discount_percent).toBe(30);
  });

  it('attend la fin des tarifs pro avant d’encaisser', () => {
    useCartStore.getState().addProduct(BIC);
    const props = renderPanel({ pricingBusy: true });
    const button = screen.getByTestId('checkout-button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Tarifs pro');
    fireEvent.click(button);
    expect(props.onCheckout).not.toHaveBeenCalled();
  });
});
