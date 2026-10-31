import { htToTtcCents } from '@pos/core';
import { useCartStore } from '@/stores/cartStore';
import type { ClearReason } from '@/stores/cartStore';
import type { CustomerQuoteItem } from '@/types/pos';

/** `unit_price_ttc_cents = round(unit_price_ht × 100 × (1 + vat_rate / 100))`. */
export function documentItemUnitTtcCents(item: {
  unit_price_ht: number;
  vat_rate: number;
}): number {
  return htToTtcCents(Math.round(item.unit_price_ht * 100), item.vat_rate);
}

export interface ImportDocumentOptions {
  /** Libellé porté par chaque ligne (`price_tier_title`), visible au ticket : « Devis DV-… ». */
  tag: string;
  reason: ClearReason;
  quoteId?: string | null;
  /** Commande ma-papeterie transférée : marquée réglée après encaissement. */
  orderId?: string | null;
  /** Ligne libre additionnelle (frais de port…), TTC en euros, TVA 20 %. */
  extraFreeLine?: { label: string; ttc: number } | null;
}

/** Un document (commande) d'un transfert groupé. */
export interface ImportedDocument {
  items: CustomerQuoteItem[];
  /** Libellé porté par chacune de ses lignes : « Commande #1390 ». */
  tag: string;
  /** Ligne libre additionnelle (frais de port…), TTC en euros, TVA 20 %. */
  extraFreeLine?: { label: string; ttc: number } | null;
}

/** Remplace le panier courant par les lignes d'un devis ou d'une commande ma-papeterie. */
export function importDocumentIntoCart(
  items: CustomerQuoteItem[],
  opts: ImportDocumentOptions,
): void {
  importDocumentsIntoCart([{ items, tag: opts.tag, extraFreeLine: opts.extraFreeLine }], {
    reason: opts.reason,
    quoteId: opts.quoteId,
    orderIds: opts.orderId ? [opts.orderId] : [],
  });
}

/**
 * Remplace le panier courant par les lignes de plusieurs documents, dans l'ordre (encaissement
 * groupé : un seul ticket, une seule facture). Chaque ligne garde le libellé de son document.
 */
export function importDocumentsIntoCart(
  docs: ImportedDocument[],
  opts: { reason: ClearReason; quoteId?: string | null; orderIds?: string[] },
): void {
  const cart = useCartStore.getState();
  cart.clear(opts.reason);
  for (const doc of docs) appendDocument(doc);
  useCartStore.getState().setQuoteId(opts.quoteId ?? null);
  useCartStore.getState().setOrderIds(opts.orderIds ?? []);
}

function appendDocument(doc: ImportedDocument): void {
  const cart = useCartStore.getState();
  for (const item of doc.items) {
    // Ligne sans quantité vendable : rien à encaisser (la quantité doit être > 0).
    if (!(item.quantity > 0)) continue;
    const cents = documentItemUnitTtcCents(item);
    if (item.product_id) {
      cart.addProduct(
        {
          id: item.product_id,
          name: item.label,
          brand: null,
          ean: null,
          image_url: null,
          price_ttc_cents: cents,
          price_ht_cents: Math.round(item.unit_price_ht * 100),
          vat_rate: item.vat_rate,
          eco_tax_cents: 0,
          stock_boutique: 0,
          pos_price_tiers: null,
        },
        {
          qty: item.quantity,
          unit_price_ttc_cents: cents,
          price_tier_title: doc.tag,
          discount_percent: item.discount_percent ?? 0,
          public_price_ttc_cents: null,
          resolvePricing: false,
        },
      );
    } else {
      const line = cart.addFreeLine({
        label: item.label,
        unit_price_ttc_cents: cents,
        vat_rate: item.vat_rate,
        qty: item.quantity,
      });
      cart.setUnitPrice(line.key, cents, { price_tier_title: doc.tag });
      if (item.discount_percent) cart.setDiscount(line.key, item.discount_percent);
    }
  }
  const extra = doc.extraFreeLine;
  if (extra && extra.ttc > 0) {
    const cents = Math.round(extra.ttc * 100);
    const line = cart.addFreeLine({
      label: extra.label,
      unit_price_ttc_cents: cents,
      vat_rate: 20,
      qty: 1,
    });
    cart.setUnitPrice(line.key, cents, { price_tier_title: doc.tag });
  }
}
