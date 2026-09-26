import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishDisplay, resetDisplayForTests, subscribeDisplay } from './customerDisplay';
import type { DisplayMessage } from './customerDisplay';

const CART: DisplayMessage = {
  type: 'cart',
  lines: [
    {
      key: 'l1',
      label: 'Cahier',
      qty: 2,
      unit_price_ttc_cents: 245,
      discount_percent: 0,
      line_ttc_cents: 490,
    },
  ],
  total_ttc_cents: 490,
  global_discount_percent: 0,
  customer_name: null,
};

describe('customerDisplay', () => {
  afterEach(() => resetDisplayForTests());

  it('diffuse les états de la caisse vers l’écran client', async () => {
    const received = vi.fn();
    const unsubscribe = subscribeDisplay(received);
    publishDisplay(CART);
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(CART));
    unsubscribe();
  });

  it('rejoue le dernier état à un écran ouvert en cours de vente (hello)', async () => {
    publishDisplay({ type: 'payment', total_ttc_cents: 490, paid_cents: 0, remaining_cents: 490 });
    const received = vi.fn();
    const unsubscribe = subscribeDisplay(received);
    await vi.waitFor(() =>
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'payment', remaining_cents: 490 }),
      ),
    );
    unsubscribe();
  });

  it('ne rediffuse pas un état identique', async () => {
    const received = vi.fn();
    publishDisplay(CART);
    const unsubscribe = subscribeDisplay(received);
    await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(1)); // réponse au hello
    publishDisplay(CART);
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
