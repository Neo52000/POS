import { create } from 'zustand';
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
}

export type ClearReason = 'sale_completed' | 'abandoned' | 'quote_import' | 'logout' | 'manual';

interface CartState {
  lines: CartLine[];
  quote_id: string | null;
  addProduct: (product: PosProduct, opts?: AddProductOptions) => CartLine;
  addFreeLine: (input: FreeLineInput) => CartLine;
  setQty: (key: string, qty: number) => void;
  setDiscount: (key: string, percent: number) => void;
  setUnitPrice: (key: string, cents: number, opts?: { price_tier_title?: string | null }) => void;
  remove: (key: string) => void;
  clear: (reason: ClearReason) => void;
  setQuoteId: (quoteId: string | null) => void;
  /** Applique les prix pro résolus (product_id → résultat). Les lignes absentes restent inchangées. */
  applyPricing: (pricing: Record<string, ResolvedPrice>) => void;
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

export const useCartStore = create<CartState>()((set, get) => ({
  lines: [],
  quote_id: null,

  addProduct: (product, opts = {}) => {
    const qty = roundQty(opts.qty ?? 1);
    const unitPrice = opts.unit_price_ttc_cents ?? product.price_ttc_cents;
    const tier = opts.price_tier_title ?? null;
    const existing = get().lines.find(
      (l) =>
        l.product_id === product.id &&
        l.unit_price_ttc_cents === unitPrice &&
        (l.price_tier_title ?? null) === tier &&
        (l.discount_percent ?? 0) === (opts.discount_percent ?? 0),
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
        discount_percent: opts.discount_percent ?? 0,
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
    const line: CartLine = {
      key: uuidv4(),
      line_no: get().lines.length + 1,
      product_id: null,
      ean: null,
      sku: null,
      label: input.label.trim() || 'Article libre',
      qty: roundQty(input.qty ?? 1),
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
    const q = roundQty(qty);
    if (q <= 0) {
      get().remove(key);
      return;
    }
    set((s) => ({ lines: s.lines.map((l) => (l.key === key ? { ...l, qty: q } : l)) }));
    const line = get().lines.find((l) => l.key === key);
    const customer = useCustomerStore.getState();
    if (line?.product_id && customer.account && !line.price_tier_title) {
      void customer.resolveLine(key, line.product_id, q);
    }
  },

  setDiscount: (key, percent) => {
    const p = roundDiscount(percent);
    set((s) => ({
      lines: s.lines.map((l) => (l.key === key ? { ...l, discount_percent: p } : l)),
    }));
  },

  setUnitPrice: (key, cents, opts = {}) => {
    const price = Math.max(0, Math.round(cents));
    set((s) => ({
      lines: s.lines.map((l) =>
        l.key === key
          ? {
              ...l,
              unit_price_ttc_cents: price,
              price_tier_title:
                opts.price_tier_title === undefined ? l.price_tier_title : opts.price_tier_title,
              pricing_rule_id: null,
            }
          : l,
      ),
    }));
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

  applyPricing: (pricing) =>
    set((s) => ({
      lines: s.lines.map((l) => {
        if (!l.product_id || l.price_tier_title) return l;
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
    })),

  restorePublicPrices: () =>
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
    })),
}));

/** Totaux (SPEC §2) à partir de l'état courant. */
export const selectTotals = (state: Pick<CartState, 'lines'>): CartTotals =>
  computeCart(state.lines);

export function getCartTotals(): CartTotals {
  return selectTotals(useCartStore.getState());
}
