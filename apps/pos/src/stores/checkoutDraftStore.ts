import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { PaymentInput } from '@pos/core';
import type { CartLine } from '@/stores/cartStore';
import type { PosCustomer } from '@/types/pos';

/** Paiement saisi dans la feuille d'encaissement. */
export interface DraftPayment extends PaymentInput {
  key: string;
  /** CB capturée par le TPE : déjà débitée, non supprimable. */
  captured: boolean;
}

/**
 * Encaissement de vente en cours (lignes figées + paiements + `client_txn_id`).
 * Écrit de façon synchrone (localStorage) à chaque paiement : un rechargement, un crash ou une
 * mise à jour de la PWA après une CB captée ne perd ni le paiement ni l'identifiant idempotent.
 */
export interface CheckoutDraft {
  client_txn_id: string;
  /** Session où l'encaissement a commencé (message de blocage du Z). */
  session_id: string | null;
  lines: CartLine[];
  quote_id: string | null;
  global_discount_percent: number;
  account: PosCustomer | null;
  payments: DraftPayment[];
  change_cents: number;
  invoice_requested: boolean;
  updated_at: string;
}

interface CheckoutDraftState {
  draft: CheckoutDraft | null;
  save: (draft: Omit<CheckoutDraft, 'updated_at'>) => void;
  discard: () => void;
}

export const CHECKOUT_DRAFT_STORAGE_KEY = 'pos.checkout-draft.v1';

export const useCheckoutDraftStore = create<CheckoutDraftState>()(
  persist(
    (set) => ({
      draft: null,
      save: (draft) => set({ draft: { ...draft, updated_at: new Date().toISOString() } }),
      discard: () => set({ draft: null }),
    }),
    {
      name: CHECKOUT_DRAFT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

export function draftCapturedCents(draft: CheckoutDraft | null): number {
  return (draft?.payments ?? []).filter((p) => p.captured).reduce((s, p) => s + p.amount_cents, 0);
}
