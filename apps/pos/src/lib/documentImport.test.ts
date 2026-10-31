import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/events', () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/edge', () => ({
  edge: { resolvePrices: vi.fn(async () => []) },
}));

import { MOCK_DOCUMENTS } from '@/lib/mocks/mockData';
import { selectTotals, useCartStore } from '@/stores/cartStore';
import {
  addOpenDocumentsToCart,
  buildSettlementLines,
  flattenOpenDocuments,
  openDocumentTotalCents,
  openDocumentsCount,
  preparedGroupDocuments,
} from './documentImport';

const ACCOUNT = 'c0000000-0000-4000-8000-000000000001';
const DOCS = flattenOpenDocuments(MOCK_DOCUMENTS[ACCOUNT]);
const BL = DOCS.find((d) => d.kind === 'delivery_note')!;
const WEB = DOCS.find((d) => d.kind === 'order' && d.doc.id.endsWith('01'))!;
const ERP = DOCS.find((d) => d.kind === 'order' && d.doc.id.endsWith('02'))!;

describe('commandes et BL à encaisser', () => {
  beforeEach(() => {
    localStorage.clear();
    useCartStore.setState({
      lines: [],
      quote_id: null,
      order_id: null,
      global_discount_percent: 0,
      locked: false,
    });
  });

  it('liste BL puis commandes, compte les documents', () => {
    expect(DOCS.map((d) => d.kind)).toEqual(['delivery_note', 'order', 'order']);
    expect(openDocumentsCount(MOCK_DOCUMENTS[ACCOUNT])).toBe(3);
  });

  it('ajoute au panier existant sans le vider, lignes tracées par document', () => {
    useCartStore
      .getState()
      .addFreeLine({ label: 'Stylo', unit_price_ttc_cents: 150, vat_rate: 20 });
    expect(addOpenDocumentsToCart(ACCOUNT, [BL, WEB])).toBe(2);
    const { lines, order_id } = useCartStore.getState();
    expect(order_id).toBeNull();
    expect(lines.map((l) => [l.label, l.qty, l.price_tier_title])).toEqual([
      ['Stylo', 1, null],
      ['Ramette papier A4 80 g', 2, 'BL BL-2026-00012 (cde CO-2026-00530)'],
      ['Cahier Clairefontaine 96p grands carreaux', 10, 'Commande CO-2026-00529'],
      ['Reliure spirale A4 (atelier)', 2, 'Commande CO-2026-00529'],
      ['Frais de port', 1, 'Commande CO-2026-00529'],
    ]);
  });

  it('le total annoncé = total ajouté au panier (port compris)', () => {
    addOpenDocumentsToCart(ACCOUNT, [WEB]);
    expect(selectTotals(useCartStore.getState()).total_ttc_cents).toBe(openDocumentTotalCents(WEB));
    expect(openDocumentTotalCents(WEB)).toBe(3599);
  });

  it('un document déjà dans le panier n’est pas ajouté deux fois, ni son port', () => {
    addOpenDocumentsToCart(ACCOUNT, [WEB]);
    expect(addOpenDocumentsToCart(ACCOUNT, [WEB, ERP])).toBe(1);
    expect(useCartStore.getState().lines.filter((l) => l.label === 'Frais de port')).toHaveLength(
      1,
    );
  });

  it('même produit dans la commande et dans le BL : deux lignes distinctes, deux règlements', () => {
    addOpenDocumentsToCart(ACCOUNT, [BL, ERP]);
    const settlement = buildSettlementLines(useCartStore.getState().lines, ACCOUNT);
    expect(settlement).toEqual([
      {
        sales_order_line_id: 'f0000000-0000-4000-8000-000000000003',
        delivery_note_line_id: 'f1000000-0000-4000-8000-000000000001',
        qty: 2,
      },
      {
        sales_order_line_id: 'f0000000-0000-4000-8000-000000000003',
        delivery_note_line_id: null,
        qty: 1,
      },
    ]);
  });

  it('règlement plafonné au reste ouvert ; ligne supprimée ou autre client : non réglée', () => {
    addOpenDocumentsToCart(ACCOUNT, [WEB]);
    const cart = useCartStore.getState();
    const [cahier, reliure] = cart.lines;
    cart.setQty(cahier!.key, 15);
    cart.remove(reliure!.key);
    const settlement = buildSettlementLines(useCartStore.getState().lines, ACCOUNT);
    expect(settlement).toEqual([
      {
        sales_order_line_id: 'f0000000-0000-4000-8000-000000000001',
        delivery_note_line_id: null,
        qty: 10,
      },
    ]);
    expect(buildSettlementLines(useCartStore.getState().lines, 'autre')).toEqual([]);
    expect(buildSettlementLines(useCartStore.getState().lines, null)).toEqual([]);
  });

  it('les lignes sourcées ne fusionnent pas avec un scan du même produit', () => {
    addOpenDocumentsToCart(ACCOUNT, [WEB]);
    const cahier = useCartStore.getState().lines[0]!;
    useCartStore.getState().addProduct(
      {
        id: cahier.product_id as string,
        name: cahier.label,
        brand: null,
        ean: null,
        image_url: null,
        price_ttc_cents: 216,
        price_ht_cents: 180,
        vat_rate: 20,
        eco_tax_cents: 0,
        stock_boutique: 0,
        pos_price_tiers: null,
      },
      {
        unit_price_ttc_cents: 216,
        price_tier_title: 'Commande CO-2026-00529',
        resolvePricing: false,
      },
    );
    expect(useCartStore.getState().lines[0]!.qty).toBe(10);
  });
});

describe('lot préparé au back-office', () => {
  const RAW = MOCK_DOCUMENTS[ACCOUNT]!;
  const withGroup = (order_ids: string[], delivery_note_ids: string[], invoice = true) => ({
    ...RAW,
    prepared_group: {
      id: 'g1',
      invoice_requested: invoice,
      order_ids,
      delivery_note_ids,
      created_at: '2026-10-31T10:00:00Z',
    },
  });

  beforeEach(() => {
    localStorage.clear();
    useCartStore.setState({
      lines: [],
      quote_id: null,
      order_id: null,
      invoice_hint: false,
      global_discount_percent: 0,
      locked: false,
    });
  });

  it('documents du lot (BL puis commandes), seulement s’il est complet', () => {
    const g = preparedGroupDocuments(withGroup([WEB.doc.id], [BL.doc.id]));
    expect(g).toMatchObject({ id: 'g1', invoiceRequested: true });
    expect(g!.docs.map((d) => d.doc.id)).toEqual([BL.doc.id, WEB.doc.id]);
    expect(preparedGroupDocuments(withGroup([WEB.doc.id, 'absente'], []))).toBeNull();
    expect(preparedGroupDocuments({ ...RAW, prepared_group: null })).toBeNull();
    // Mock : la Mairie a un lot préparé (BL + commande web).
    expect(preparedGroupDocuments(RAW)?.docs).toHaveLength(2);
    expect(preparedGroupDocuments(null)).toBeNull();
  });

  it('facture pré-demandée : remise à zéro au vidage et au rappel d’un panier', () => {
    useCartStore.getState().setInvoiceHint(true);
    useCartStore.getState().clear('manual');
    expect(useCartStore.getState().invoice_hint).toBe(false);
    useCartStore.getState().setInvoiceHint(true);
    useCartStore.getState().restore([], null);
    expect(useCartStore.getState().invoice_hint).toBe(false);
  });
});
