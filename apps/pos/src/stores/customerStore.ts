import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { edge } from '@/lib/edge';
import { useCartStore } from '@/stores/cartStore';
import type { CustomerQuote, PassageContact, PosCustomer, ResolvedPrice } from '@/types/pos';

/** Personne de passage attachée (hors périmètre fiscal : voyage à côté du ticket). */
export type PassageContactRef = Pick<PassageContact, 'id' | 'full_name' | 'phone'>;

/**
 * Compte porté par le ticket pour une personne de passage : la fiche « Client passage »
 * ma-papeterie (prix publics, aucune règle tarifaire, pas de devis).
 */
export function passageAccount(contact: PassageContact): PosCustomer {
  return {
    id: contact.passage_account_id,
    display_name: `Passage — ${contact.full_name}`,
    company_name: null,
    siret: null,
    vat_number: null,
    kind: 'b2c',
    customer_type: null,
    payment_terms_days: null,
    pricing_rules_count: 0,
    open_quotes_count: 0,
    revenue_ttc_12m: null,
    email: null,
    phone: contact.phone,
  };
}

interface CustomerState {
  account: PosCustomer | null;
  /** Personne de passage : `account` est alors la fiche « Client passage ». */
  passageContact: PassageContactRef | null;
  /** product_id → dernier résultat de `pos_resolve_cart_prices`. */
  pricing: Record<string, ResolvedPrice>;
  quotes: CustomerQuote[];
  resolving: boolean;
  /** Résolutions de tarif ligne en cours : l'encaissement attend qu'elles aboutissent. */
  pendingLines: number;
  error: string | null;
  /** Attache un client pro et réapplique ses tarifs sur tout le panier. */
  attach: (account: PosCustomer) => Promise<void>;
  /** Attache une personne de passage (fiche « Client passage » + contact). */
  attachPassage: (contact: PassageContact) => Promise<void>;
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

/** Dernière requête émise par ligne : une réponse plus ancienne est ignorée. */
const lineSeq = new Map<string, number>();
let seqCounter = 0;

export const useCustomerStore = create<CustomerState>()(
  persist(
    (set, get) => ({
      account: null,
      passageContact: null,
      pricing: {},
      quotes: [],
      resolving: false,
      pendingLines: 0,
      error: null,

      attach: async (account) => {
        set({ account, passageContact: null, quotes: [], error: null, resolving: true });
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
          set({
            resolving: false,
            error: e instanceof Error ? e.message : 'Tarifs pro indisponibles',
          });
        }
      },

      attachPassage: async (contact) => {
        const pending = get().attach(passageAccount(contact));
        // attach() remet passageContact à null de façon synchrone : on le pose juste après.
        set({
          passageContact: { id: contact.id, full_name: contact.full_name, phone: contact.phone },
        });
        await pending;
      },

      detach: () => {
        lineSeq.clear();
        set({
          account: null,
          passageContact: null,
          pricing: {},
          quotes: [],
          error: null,
          resolving: false,
        });
        useCartStore.getState().restorePublicPrices();
        useCartStore.getState().setQuoteId(null);
        useCartStore.getState().setOrderIds([]);
      },

      resolveLine: async (lineKey, productId, qty) => {
        const account = get().account;
        if (!account) return null;
        const seq = ++seqCounter;
        lineSeq.set(lineKey, seq);
        set((s) => ({ pendingLines: s.pendingLines + 1 }));
        try {
          const [r] = await resolvePrices(account.id, [{ product_id: productId, qty }]);
          if (!r || get().account?.id !== account.id) return null;
          // Une quantité plus récente a été demandée entre-temps : cette réponse est périmée.
          if (lineSeq.get(lineKey) !== seq) return null;
          set((s) => ({ pricing: { ...s.pricing, [productId]: r } }));
          useCartStore.getState().applyPricing({ [productId]: r }, lineKey);
          return r;
        } catch (e) {
          set({ error: e instanceof Error ? e.message : 'Tarif pro indisponible' });
          return null;
        } finally {
          set((s) => ({ pendingLines: Math.max(0, s.pendingLines - 1) }));
        }
      },

      setQuotes: (quotes) => set({ quotes }),
    }),
    {
      // Le client attaché suit le panier persistant (rechargement, reprise d'encaissement).
      name: 'pos.customer.v1',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        account: s.account,
        passageContact: s.passageContact,
        pricing: s.pricing,
      }),
    },
  ),
);
