import { create } from 'zustand';
import { edge } from '@/lib/edge';
import { useCartStore } from '@/stores/cartStore';
import type { CustomerQuote, PosCustomer, ResolvedPrice } from '@/types/pos';

interface CustomerState {
  account: PosCustomer | null;
  /** product_id → dernier résultat de `pos_resolve_cart_prices`. */
  pricing: Record<string, ResolvedPrice>;
  quotes: CustomerQuote[];
  resolving: boolean;
  error: string | null;
  /** Attache un client pro et réapplique ses tarifs sur tout le panier. */
  attach: (account: PosCustomer) => Promise<void>;
  /** Détache le client et restaure les prix publics. */
  detach: () => void;
  /** Résout le tarif d'une ligne (appelé à chaque ajout/changement de quantité). */
  resolveLine: (lineKey: string, productId: string, qty: number) => Promise<ResolvedPrice | null>;
  setQuotes: (quotes: CustomerQuote[]) => void;
}

/** Tarifs pro via l'Edge Function `pos-resolve-prices` (JWT vendeur). */
async function resolvePrices(
  accountId: string,
  lines: Array<{ product_id: string; qty: number }>,
): Promise<ResolvedPrice[]> {
  if (lines.length === 0) return [];
  return edge.resolvePrices(accountId, lines);
}

export const useCustomerStore = create<CustomerState>()((set, get) => ({
  account: null,
  pricing: {},
  quotes: [],
  resolving: false,
  error: null,

  attach: async (account) => {
    set({ account, quotes: [], error: null, resolving: true });
    const cart = useCartStore.getState();
    const lines = cart.lines
      .filter((l) => l.product_id && !l.price_tier_title)
      .map((l) => ({ product_id: l.product_id as string, qty: l.qty }));
    try {
      const results = await resolvePrices(account.id, lines);
      // Le client a pu être détaché pendant l'appel.
      if (get().account?.id !== account.id) return;
      const pricing: Record<string, ResolvedPrice> = {};
      for (const r of results) pricing[r.product_id] = r;
      set({ pricing, resolving: false });
      useCartStore.getState().applyPricing(pricing);
    } catch (e) {
      set({ resolving: false, error: e instanceof Error ? e.message : 'Tarifs pro indisponibles' });
    }
  },

  detach: () => {
    set({ account: null, pricing: {}, quotes: [], error: null, resolving: false });
    useCartStore.getState().restorePublicPrices();
    useCartStore.getState().setQuoteId(null);
  },

  resolveLine: async (lineKey, productId, qty) => {
    const account = get().account;
    if (!account) return null;
    try {
      const [r] = await resolvePrices(account.id, [{ product_id: productId, qty }]);
      if (!r || get().account?.id !== account.id) return null;
      set((s) => ({ pricing: { ...s.pricing, [productId]: r } }));
      const cart = useCartStore.getState();
      const line = cart.lines.find((l) => l.key === lineKey);
      if (line) cart.applyPricing({ [productId]: r });
      return r;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'Tarif pro indisponible' });
      return null;
    }
  },

  setQuotes: (quotes) => set({ quotes }),
}));
