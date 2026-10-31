import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/events', () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/edge', () => ({ edge: { resolvePrices: vi.fn(async () => []) } }));

import { usePwaUpdateStore } from '@/stores/pwaUpdateStore';
import { useCartStore } from '@/stores/cartStore';
import { UpdateBanner } from './UpdateBanner';

describe('UpdateBanner', () => {
  beforeEach(() => {
    useCartStore.setState({ locked: false });
  });

  it('caché tant qu’aucune nouvelle version n’est prête', () => {
    usePwaUpdateStore.setState({ available: false });
    render(<UpdateBanner />);
    expect(screen.queryByTestId('update-banner')).toBeNull();
  });

  it('« Mettre à jour » applique la nouvelle version', () => {
    const apply = vi.fn();
    usePwaUpdateStore.setState({ available: true, apply });
    render(<UpdateBanner />);
    expect(screen.getByTestId('update-banner')).toHaveTextContent('panier en cours est conservé');
    fireEvent.click(screen.getByTestId('update-apply'));
    expect(apply).toHaveBeenCalledOnce();
  });

  it('jamais pendant un encaissement', () => {
    const apply = vi.fn();
    usePwaUpdateStore.setState({ available: true, apply });
    useCartStore.setState({ locked: true });
    render(<UpdateBanner />);
    expect(screen.getByTestId('update-apply')).toBeDisabled();
    expect(screen.getByTestId('update-banner')).toHaveTextContent('après l’encaissement');
  });
});
