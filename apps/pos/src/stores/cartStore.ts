import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { computeCart, normalizeVatRate } from '@pos/core';
import type { CartLineInput, CartTotals } from '@pos/core';
import { logEvent } from '@/lib/events';
import { uuidv4 } from '@/lib/uuid';
import type { PosProduct, ResolvedPrice } from '@/types/pos';
import { useCustomerStore } from '@/stores/customerStore';

/** Ligne de panier : `CartLineInput` (SPEC §2) + données d'affichage. */
export interface CartLine extends CartLineInput {
  key: string;
  product_name: string;
  image_url: string | null;
  stock_boutique: number | null;
  price_tier_title?: string | null;
  pricing_rule_id?: string | null;
  public_price_ttc_cents?: number | null;
  /** Prix unitaire saisi à la main : jamais écrasé par un tarif pro. */
  price_overridden?: boolean;
}

export interface AddProductOptions {
  qty?: number;
  /** Prix TTC forcé (palier, devis, tarif pro). */
  unit_price_ttc_cents?: number;
  price_tier_title?: string | null;
  pricing_rule_id?: string | null;
  public_price_ttc_cents?: number | null;
  discount_percent?: number;
  /** Si `false`, n'appelle pas la résolution de prix client (déjà résolu). */
  resolvePricing?: boolean;
}

export interface FreeLineInput {
  label: string;
  unit_price_ttc_cents: number;
  vat_rate: number | string;
  qty?: number;
  /** Code-barres scanné mais inconnu du catalogue. */
  ean?: string | null;
}

export type ClearReason = 'sale_completed' | 'abandoned' | 'quote_import' | 'logout' | 'manual';

interface CartState {
  lines: CartLine[];
  quote_id: string | null;
  /** Encaissement en cours : les mises à jour tarifaires asynchrones sont ignorées. */
  locked: boolean;
  setLocked: (locked: boolean) => void;
  /** Remplace le panier (reprise d'un encaissement interrompu, rappel d'un ticket en attente). */
  restore: (lines: CartLine[], quoteId: string | null) => void;
  addProduct: (product: PosProduct, opts?: AddProductOptions) => CartLine;
  addFreeLine: (input: FreeLineInput) => CartLine;
  setQty: (key: string, qty: number) => void;
  setDiscount: (key: string, percent: number) => void;
  setUnitPrice: (key: string, cents: number, opts?: { price_tier_title?: string | null }) => void;
  remove: (key: string) => void;
  clear: (reason: ClearReason) => void;
  setQuoteId: (quoteId: string | null) => void;
  /**
   * Applique les prix pro résolus (product_id → résultat). Les lignes absentes, à palier ou à prix
   * forcé restent inchangées ; `lineKey` restreint l'application à une seule ligne.
   */
  applyPricing: (pricing: Record<string, ResolvedPrice>, lineKey?: string) => void;
  /** Restaure les prix publics sur toutes les lignes tarifées. */
  restorePublicPrices: () => void;
}

function renumber(lines: CartLine[]): CartLine[] {
  return lines.map((l, i) => ({ ...l, line_no: i + 1 }));
}

function roundDiscount(percent: number): number {
  const p = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return Math.round(p * 100) / 100;
}

function roundQty(qty: number): number {
  return Math.round(qty * 1000) / 1000;
}

/** Quantité de vente valide : nombre fini > 0, 3 décimales max (SPEC §1). */
export function validQty(qty: number): number {
  const q = roundQty(qty);
  if (!Number.isFinite(q) || q <= 0) throw new Error(`Quantité invalide : ${String(qty)}`);
  return q;
}

export const CART_STORAGE_KEY = 'pos.cart.v1';

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      lines: [],
      quote_id: null,
      locked: false,

      setLocked: (locked) => set({ locked }),

      restore: (lines, quoteId) => set({ lines: renumber(lines), quote_id: quoteId }),

      addProduct: (product, opts = {}) => {
        const qty = validQty(opts.qty ?? 1);
        const unitPrice = opts.unit_price_ttc_cents ?? product.price_ttc_cents;
        const tier = opts.price_tier_title ?? null;
        const discount = opts.discount_percent ?? 0;
        // Sans prix imposé, on fusionne avec la ligne « catalogue » du produit même si un tarif pro
        // l'a modifiée (le tarif est réévalué sur la quantité totale).
        const existing = get().lines.find(
          (l) =>
            l.product_id === product.id &&
            (l.price_tier_title ?? null) === tier &&
            (l.discount_percent ?? 0) === discount &&
            (opts.unit_price_ttc_cents === undefined
              ? !l.price_overridden &&
                (l.public_price_ttc_cents ?? l.unit_price_ttc_cents) === product.price_ttc_cents
              : l.unit_price_ttc_cents === unitPrice),
        );
        let line: CartLine;
        if (existing) {
          line = { ...existing, qty: roundQty(existing.qty + qty) };
          set((s) => ({ lines: s.lines.map((l) => (l.key === existing.key ? line : l)) }));
        } else {
          line = {
            key: uuidv4(),
            line_no: get().lines.length + 1,
            product_id: product.id,
            ean: product.ean,
            sku: null,
            label: product.name,
            qty,
            unit_price_ttc_cents: unitPrice,
            vat_rate: normalizeVatRate(product.vat_rate),
            discount_percent: discount,
            eco_tax_cents: product.eco_tax_cents ?? 0,
            pricing_rule_id: opts.pricing_rule_id ?? null,
            price_tier_title: tier,
            public_price_ttc_cents: opts.public_price_ttc_cents ?? product.price_ttc_cents,
            product_name: product.name,
            image_url: product.image_url,
            stock_boutique: product.stock_boutique,
          };
          set((s) => ({ lines: renumber([...s.lines, line]) }));
        }
        // Client pro attaché : résolution du tarif négocié pour cette ligne (asynchrone).
        if (opts.resolvePricing !== false && !tier) {
          const customer = useCustomerStore.getState();
          if (customer.account) void customer.resolveLine(line.key, product.id, line.qty);
        }
        return line;
      },

      addFreeLine: (input) => {
        const qty = validQty(input.qty ?? 1);
        const line: CartLine = {
          key: uuidv4(),
          line_no: get().lines.length + 1,
          product_id: null,
          ean: input.ean ?? null,
          sku: null,
          label: input.label.trim() || 'Article libre',
          qty,
          unit_price_ttc_cents: Math.max(0, Math.round(input.unit_price_ttc_cents)),
          vat_rate: normalizeVatRate(input.vat_rate),
          discount_percent: 0,
          eco_tax_cents: 0,
          pricing_rule_id: null,
          price_tier_title: null,
          public_price_ttc_cents: null,
          product_name: input.label,
          image_url: null,
          stock_boutique: null,
        };
        set((s) => ({ lines: renumber([...s.lines, line]) }));
        return line;
      },

      setQty: (key, qty) => {
        if (!Number.isFinite(qty)) return;
        const q = roundQty(qty);
        if (q <= 0) {
          get().remove(key);
          return;
        }
        const before = get().lines.find((l) => l.key === key);
        if (!before || before.qty === q) return;
        set((s) => ({ lines: s.lines.map((l) => (l.key === key ? { ...l, qty: q } : l)) }));
        if (q < before.qty) {
          void logEvent('qty_decreased', {
            product_id: before.product_id,
            label: before.label,
            from_qty: before.qty,
            to_qty: q,
            unit_price_ttc_cents: before.unit_price_ttc_cents,
          });
        }
        const customer = useCustomerStore.getState();
        if (
          before.product_id &&
          customer.account &&
          !before.price_tier_title &&
          !before.price_overridden
        ) {
          void customer.resolveLine(key, before.product_id, q);
        }
      },

      setDiscount: (key, percent) => {
        const p = roundDiscount(percent);
        const before = get().lines.find((l) => l.key === key);
        if (!before || (before.discount_percent ?? 0) === p) return;
        set((s) => ({
          lines: s.lines.map((l) => (l.key === key ? { ...l, discount_percent: p } : l)),
        }));
        void logEvent('line_discount', {
          product_id: before.product_id,
          label: before.label,
          qty: before.qty,
          unit_price_ttc_cents: before.unit_price_ttc_cents,
          from_percent: before.discount_percent ?? 0,
          to_percent: p,
        });
      },

      setUnitPrice: (key, cents, opts = {}) => {
        const price = Math.max(0, Math.round(cents));
        const before = get().lines.find((l) => l.key === key);
        if (!before) return;
        set((s) => ({
          lines: s.lines.map((l) =>
            l.key === key
              ? {
                  ...l,
                  unit_price_ttc_cents: price,
                  price_tier_title:
                    opts.price_tier_title === undefined
                      ? l.price_tier_title
                      : opts.price_tier_title,
                  pricing_rule_id: null,
                  price_overridden: true,
                }
              : l,
          ),
        }));
        // Prix issu d'un devis (palier nommé) : pas une dérogation de caisse.
        if (opts.price_tier_title === undefined && price !== before.unit_price_ttc_cents) {
          void logEvent('price_override', {
            product_id: before.product_id,
            label: before.label,
            qty: before.qty,
            from_cents: before.unit_price_ttc_cents,
            to_cents: price,
            public_price_ttc_cents: before.public_price_ttc_cents ?? null,
          });
        }
      },

      remove: (key) => {
        const line = get().lines.find((l) => l.key === key);
        if (!line) return;
        set((s) => ({ lines: renumber(s.lines.filter((l) => l.key !== key)) }));
        void logEvent('line_deleted', {
          product_id: line.product_id,
          label: line.label,
          qty: line.qty,
          unit_price_ttc_cents: line.unit_price_ttc_cents,
          discount_percent: line.discount_percent ?? 0,
          remaining_lines: get().lines.length,
        });
      },

      clear: (reason) => {
        const { lines, quote_id } = get();
        if (lines.length > 0 && reason !== 'sale_completed') {
          const totals = computeCart(lines);
          void logEvent('sale_abandoned', {
            reason,
            lines: lines.length,
            total_ttc_cents: totals.total_ttc_cents,
            quote_id,
          });
        }
        set({ lines: [], quote_id: null });
      },

      setQuoteId: (quoteId) => set({ quote_id: quoteId }),

      applyPricing: (pricing, lineKey) => {
        if (get().locked) return;
        set((s) => ({
          lines: s.lines.map((l) => {
            if (lineKey !== undefined && l.key !== lineKey) return l;
            if (!l.product_id || l.price_tier_title || l.price_overridden) return l;
            const r = pricing[l.product_id];
            if (!r) return l;
            const publicPrice = l.public_price_ttc_cents ?? l.unit_price_ttc_cents;
            return {
              ...l,
              unit_price_ttc_cents: r.rule_id ? r.unit_price_ttc_cents : publicPrice,
              pricing_rule_id: r.rule_id ?? null,
              public_price_ttc_cents: publicPrice,
            };
          }),
        }));
      },

      restorePublicPrices: () => {
        if (get().locked) return;
        set((s) => ({
          lines: s.lines.map((l) =>
            l.pricing_rule_id
              ? {
                  ...l,
                  unit_price_ttc_cents: l.public_price_ttc_cents ?? l.unit_price_ttc_cents,
                  pricing_rule_id: null,
                }
              : l,
          ),
        }));
      },
    }),
    {
      // Le panier survit à un rechargement, un crash ou une mise à jour de la PWA.
      name: CART_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ lines: s.lines, quote_id: s.quote_id }),
    },
  ),
);

/** Totaux (SPEC §2) à partir de l'état courant. */
export const selectTotals = (state: Pick<CartState, 'lines'>): CartTotals =>
  computeCart(state.lines);

export function getCartTotals(): CartTotals {
  return selectTotals(useCartStore.getState());
}
