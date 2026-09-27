import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { logEvent } from '@/lib/events';
import { uuidv4 } from '@/lib/uuid';
import { selectTotals, useCartStore } from '@/stores/cartStore';
import type { CartLine } from '@/stores/cartStore';
import { useCustomerStore } from '@/stores/customerStore';
import type { PosCustomer } from '@/types/pos';

export const MAX_PARKED = 10;

/** Panier mis en attente : aucune valeur fiscale (le ticket n'existe pas encore). */
export interface ParkedCart {
  id: string;
  parked_at: string;
  lines: CartLine[];
  quote_id: string | null;
  /** Remise globale du panier (%), 0 si aucune. Absente des tickets mis en attente avant son ajout. */
  global_discount_percent?: number;
  account: PosCustomer | null;
  total_ttc_cents: number;
}

interface ParkedState {
  parked: ParkedCart[];
  /** Met le panier courant en attente et le vide. `false` si vide ou limite atteinte. */
  park: () => boolean;
  /** Rappelle un panier ; le panier courant non vide est d'abord mis en attente (échange). */
  recall: (id: string) => boolean;
  /** Supprime un panier en attente (tracé comme abandon). */
  discard: (id: string) => void;
}

function snapshotCurrent(): ParkedCart | null {
  const cart = useCartStore.getState();
  if (cart.lines.length === 0) return null;
  return {
    id: uuidv4(),
    parked_at: new Date().toISOString(),
    lines: cart.lines,
    quote_id: cart.quote_id,
    global_discount_percent: cart.global_discount_percent,
    account: useCustomerStore.getState().account,
    total_ttc_cents: selectTotals(cart).total_ttc_cents,
  };
}

/** Vide le panier et détache le client sans tracer d'abandon (le panier est conservé). */
function resetCurrent(): void {
  useCartStore.getState().restore([], null);
  useCustomerStore.getState().detach();
}

export const useParkedStore = create<ParkedState>()(
  persist(
    (set, get) => ({
      parked: [],

      park: () => {
        if (get().parked.length >= MAX_PARKED) return false;
        const snap = snapshotCurrent();
        if (!snap) return false;
        set((s) => ({ parked: [...s.parked, snap] }));
        resetCurrent();
        void logEvent('sale_parked', {
          parked_id: snap.id,
          lines: snap.lines.length,
          total_ttc_cents: snap.total_ttc_cents,
          customer_account_id: snap.account?.id ?? null,
        });
        return true;
      },

      recall: (id) => {
        const target = get().parked.find((p) => p.id === id);
        if (!target) return false;
        const current = snapshotCurrent();
        // Échange : le panier courant prend la place du panier rappelé.
        set((s) => ({
          parked: [...s.parked.filter((p) => p.id !== id), ...(current ? [current] : [])],
        }));
        if (current) {
          void logEvent('sale_parked', {
            parked_id: current.id,
            lines: current.lines.length,
            total_ttc_cents: current.total_ttc_cents,
            customer_account_id: current.account?.id ?? null,
          });
        }
        resetCurrent();
        // Les lignes gardent leurs prix (y compris tarifs pro) : pas de nouvelle résolution.
        useCustomerStore.setState({ account: target.account, pricing: {}, error: null });
        useCartStore
          .getState()
          .restore(target.lines, target.quote_id, target.global_discount_percent ?? 0);
        void logEvent('sale_recalled', {
          parked_id: target.id,
          lines: target.lines.length,
          total_ttc_cents: target.total_ttc_cents,
          parked_at: target.parked_at,
        });
        return true;
      },

      discard: (id) => {
        const target = get().parked.find((p) => p.id === id);
        if (!target) return;
        set((s) => ({ parked: s.parked.filter((p) => p.id !== id) }));
        void logEvent('sale_abandoned', {
          reason: 'parked_discarded',
          lines: target.lines.length,
          total_ttc_cents: target.total_ttc_cents,
          quote_id: target.quote_id,
        });
      },
    }),
    {
      name: 'pos.parked.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
