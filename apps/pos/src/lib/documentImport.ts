import { htToTtcCents } from '@pos/core';
import type { SettlementLine } from '@pos/core';
import { useCartStore } from '@/stores/cartStore';
import type { CartLine, CartLineSource, ClearReason } from '@/stores/cartStore';
import type {
  CustomerOpenDocuments,
  CustomerQuoteItem,
  OpenDeliveryNoteDocument,
  OpenDocumentItem,
  OpenOrderDocument,
} from '@/types/pos';

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
  /** Ligne libre additionnelle (frais de port…), TTC en euros, TVA 20 %. */
  extraFreeLine?: { label: string; ttc: number } | null;
}

/** Remplace le panier courant par les lignes d'un devis ma-papeterie. */
export function importDocumentIntoCart(
  items: CustomerQuoteItem[],
  opts: ImportDocumentOptions,
): void {
  const cart = useCartStore.getState();
  cart.clear(opts.reason);
  for (const item of items) addDocumentItem(item, opts.tag, null);
  const extra = opts.extraFreeLine;
  if (extra && extra.ttc > 0) addShippingLine(extra.label, extra.ttc, opts.tag, null);
  useCartStore.getState().setQuoteId(opts.quoteId ?? null);
}

/** Ajoute une ligne de document au panier (prix du document, jamais retarifée). */
function addDocumentItem(
  item: CustomerQuoteItem,
  tag: string,
  source: CartLineSource | null,
): void {
  // Ligne sans quantité vendable : rien à encaisser (la quantité doit être > 0).
  if (!(item.quantity > 0)) return;
  const cart = useCartStore.getState();
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
        price_tier_title: tag,
        discount_percent: item.discount_percent ?? 0,
        public_price_ttc_cents: null,
        resolvePricing: false,
        source,
      },
    );
  } else {
    const line = cart.addFreeLine({
      label: item.label,
      unit_price_ttc_cents: cents,
      vat_rate: item.vat_rate,
      qty: item.quantity,
      source,
    });
    cart.setUnitPrice(line.key, cents, { price_tier_title: tag });
    if (item.discount_percent) cart.setDiscount(line.key, item.discount_percent);
  }
}

function addShippingLine(
  label: string,
  ttc: number,
  tag: string,
  source: CartLineSource | null,
): void {
  const cart = useCartStore.getState();
  const cents = Math.round(ttc * 100);
  const line = cart.addFreeLine({
    label,
    unit_price_ttc_cents: cents,
    vat_rate: 20,
    qty: 1,
    source,
  });
  cart.setUnitPrice(line.key, cents, { price_tier_title: tag });
}

// -----------------------------------------------------------------------------
// Commandes et BL ma-papeterie : ajout au panier (sans le vider), réglés à la ligne.
// -----------------------------------------------------------------------------

export type OpenDocument =
  | { kind: 'order'; doc: OpenOrderDocument }
  | { kind: 'delivery_note'; doc: OpenDeliveryNoteDocument };

/** Liste à plat (BL d'abord : ce qui est livré se règle en priorité), plus récent en tête. */
export function flattenOpenDocuments(
  docs: CustomerOpenDocuments | null | undefined,
): OpenDocument[] {
  if (!docs) return [];
  return [
    ...docs.delivery_notes.map((doc) => ({ kind: 'delivery_note' as const, doc })),
    ...docs.orders.map((doc) => ({ kind: 'order' as const, doc })),
  ];
}

export function openDocumentsCount(docs: CustomerOpenDocuments | null | undefined): number {
  return (docs?.orders.length ?? 0) + (docs?.delivery_notes.length ?? 0);
}

export function openDocumentNumber(d: OpenDocument): string {
  return d.kind === 'order' ? d.doc.order_number || 'Commande' : d.doc.delivery_note_number || 'BL';
}

/** Libellé porté par les lignes (`price_tier_title`, imprimé au ticket). */
export function openDocumentTag(d: OpenDocument): string {
  return d.kind === 'order'
    ? `Commande ${openDocumentNumber(d)}`
    : `BL ${openDocumentNumber(d)} (cde ${d.doc.order_number})`;
}

/** Commande d'origine du document. */
export function openDocumentOrderId(d: OpenDocument): string {
  return d.kind === 'order' ? d.doc.id : d.doc.order_id;
}

/** Total TTC (centimes) des lignes restant dues, port compris pour une commande. */
export function openDocumentTotalCents(d: OpenDocument): number {
  let total = 0;
  for (const it of d.doc.items) {
    if (!(it.quantity > 0)) continue;
    const gross = documentItemUnitTtcCents(it) * it.quantity;
    total += Math.round(gross * (1 - (it.discount_percent ?? 0) / 100));
  }
  if (d.kind === 'order') total += Math.round((d.doc.shipping_ttc ?? 0) * 100);
  return total;
}

/** Documents déjà présents dans le panier (au moins une ligne sourcée). */
export function documentIdsInCart(lines: CartLine[]): Set<string> {
  return new Set(lines.flatMap((l) => (l.source ? [l.source.doc_id] : [])));
}

/**
 * Ajoute les lignes restant dues des documents au panier courant (sans le vider). Un document déjà
 * dans le panier est ignoré ; les frais de port d'une commande ne sont ajoutés qu'une fois.
 */
export function addOpenDocumentsToCart(accountId: string, selection: OpenDocument[]): number {
  const inCart = documentIdsInCart(useCartStore.getState().lines);
  const shippingInCart = new Set(
    useCartStore
      .getState()
      .lines.flatMap((l) => (l.source?.doc_kind === 'shipping' ? [l.source.order_id] : [])),
  );
  let added = 0;
  for (const d of selection) {
    if (inCart.has(d.doc.id)) continue;
    inCart.add(d.doc.id);
    const tag = openDocumentTag(d);
    const base = {
      account_id: accountId,
      doc_kind: d.kind,
      doc_id: d.doc.id,
      doc_number: openDocumentNumber(d),
      order_id: openDocumentOrderId(d),
    };
    for (const item of d.doc.items as OpenDocumentItem[]) {
      addDocumentItem(item, tag, {
        ...base,
        sales_order_line_id: item.sales_order_line_id,
        delivery_note_line_id: item.delivery_note_line_id ?? null,
        qty_open: item.quantity,
      });
    }
    if (d.kind === 'order' && (d.doc.shipping_ttc ?? 0) > 0 && !shippingInCart.has(d.doc.id)) {
      shippingInCart.add(d.doc.id);
      addShippingLine('Frais de port', d.doc.shipping_ttc as number, tag, {
        ...base,
        doc_kind: 'shipping',
        sales_order_line_id: null,
        delivery_note_line_id: null,
        qty_open: 1,
      });
    }
    added += 1;
  }
  return added;
}

/**
 * Lignes réglées par le ticket : lignes sourcées du client encaissé, quantité plafonnée au reste
 * ouvert (une quantité vendue en plus est une vente simple ; une ligne supprimée n'est pas réglée).
 */
export function buildSettlementLines(
  lines: CartLine[],
  accountId: string | null,
): SettlementLine[] {
  if (!accountId) return [];
  const byKey = new Map<string, SettlementLine & { cap: number }>();
  for (const l of lines) {
    const src = l.source;
    if (!src || src.account_id !== accountId || !src.sales_order_line_id || !(l.qty > 0)) continue;
    const key = `${src.sales_order_line_id}/${src.delivery_note_line_id ?? ''}`;
    const prev = byKey.get(key);
    const qty = Math.min((prev?.qty ?? 0) + l.qty, src.qty_open);
    byKey.set(key, {
      sales_order_line_id: src.sales_order_line_id,
      delivery_note_line_id: src.delivery_note_line_id,
      qty: Math.round(qty * 1000) / 1000,
      cap: src.qty_open,
    });
  }
  return [...byKey.values()].filter((l) => l.qty > 0).map(({ cap: _cap, ...l }) => l);
}
