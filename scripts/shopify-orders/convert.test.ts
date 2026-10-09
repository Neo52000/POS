import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  IMPORT_MARKER,
  channelOf,
  convertRows,
  parseCsv,
  parseShopifyDate,
  resolveColumns,
  summarize,
  type Channel,
  type ConvertOptions,
} from './convert.ts';

const OPTS: ConvertOptions = {
  channels: ['pos', 'web', 'draft'],
  since: null,
  before: null,
  includeCancelled: false,
  includePending: false,
};

function load(): { header: string[]; rows: string[][] } {
  const [header, ...rows] = parseCsv(
    readFileSync(new URL('./exemple.csv', import.meta.url), 'utf8'),
  );
  return { header: header!, rows };
}

function convert(opts: Partial<ConvertOptions> = {}) {
  const { header, rows } = load();
  return convertRows(rows, resolveColumns(header), { ...OPTS, ...opts });
}

describe('channelOf', () => {
  it('reprend la taxonomie de v_admin_revenue_daily', () => {
    const cases: Array<[string, Channel]> = [
      ['pos', 'pos'],
      ['POS', 'pos'],
      ['web', 'web'],
      ['channel:11370740', 'web'],
      ['11370740', 'web'],
      ['shopify_draft_order', 'draft'],
      ['iphone', 'other'],
      ['', 'other'],
    ];
    for (const [src, expected] of cases) expect(channelOf(src)).toBe(expected);
  });
});

describe('parseShopifyDate', () => {
  it('lit le format de l’export (décalage explicite)', () => {
    expect(parseShopifyDate('2026-08-10 13:48:48 +0200')).toBe('2026-08-10T11:48:48.000Z');
    expect(parseShopifyDate('2026-01-05 09:00:00 +0100')).toBe('2026-01-05T08:00:00.000Z');
  });

  it('accepte l’ISO et les secondes absentes, rejette le reste', () => {
    expect(parseShopifyDate('2026-08-10T11:48:48Z')).toBe('2026-08-10T11:48:48.000Z');
    expect(parseShopifyDate('2026-08-10 13:48 +0200')).toBe('2026-08-10T11:48:00.000Z');
    expect(parseShopifyDate('10/08/2026')).toBeNull();
    expect(parseShopifyDate('')).toBeNull();
    expect(parseShopifyDate(undefined)).toBeNull();
  });
});

describe('resolveColumns', () => {
  it('reconnaît les en-têtes de l’export anglais', () => {
    const { header } = load();
    const columns = resolveColumns(header);
    expect(header[columns.total!]).toBe('Total');
    expect(header[columns.source!]).toBe('Source');
    expect(header[columns.li_sku!]).toBe('Lineitem sku');
  });

  it('reconnaît les en-têtes de l’export français', () => {
    const columns = resolveColumns([
      'Nom',
      'Identifiant',
      'Date de création',
      'Total',
      'Canal',
      "Quantité de l'article",
      "Nom de l'article",
      "Prix de l'article",
    ]);
    expect(columns.name).toBe(0);
    expect(columns.id).toBe(1);
    expect(columns.created_at).toBe(2);
    expect(columns.source).toBe(4);
    expect(columns.li_qty).toBe(5);
  });

  it('exige les colonnes indispensables et honore --map', () => {
    expect(() => resolveColumns(['Nom', 'Total'])).toThrow(/Colonnes obligatoires/);
    const columns = resolveColumns(['Nom', 'Id', 'Date de création', 'Total payé', 'Source'], {
      total: 'Total payé',
    });
    expect(columns.total).toBe(3);
  });
});

describe('convertRows', () => {
  it('regroupe les lignes d’articles en commandes', () => {
    const { orders } = convert();
    const pos = orders.find((o) => o.shopify_order_name === '#1054')!;
    expect(pos.shopify_order_id).toBe('7026151424244');
    expect(pos.shopify_order_number).toBe('1054');
    expect(pos.raw_payload.channel).toBe('pos');
    expect(pos.raw_payload.imported_from).toBe(IMPORT_MARKER);
    expect(pos.raw_payload.location).toBe('Boutique Chaumont');
    expect(pos.total_ttc).toBe(270);
    expect(pos.total_tax).toBe(45);
    // Les colonnes de commande ne sont remplies que sur la 1re ligne de l'export.
    expect(pos.line_items).toEqual([
      {
        sku: 'CF-96',
        shopifyVariantId: null,
        title: 'Cahier Clairefontaine 96p',
        quantity: 2,
        price: 120,
      },
      {
        sku: 'BIC-4C',
        shopifyVariantId: null,
        title: 'Stylo Bic 4 couleurs',
        quantity: 1,
        price: 30,
      },
    ]);
  });

  it('classe la boutique en ligne et le comptoir sur les bons canaux', () => {
    const { orders } = convert();
    expect(orders.find((o) => o.shopify_order_name === '#1055')!.raw_payload.channel).toBe('web');
    expect(orders.find((o) => o.shopify_order_name === '#1056')!.raw_payload.channel).toBe('draft');
  });

  it('déduit la remise de ligne du prix unitaire', () => {
    const { orders } = convert();
    // 10 ramettes à 11,00 € avec 10,00 € de remise de ligne → 10,00 € l'unité.
    expect(orders.find((o) => o.shopify_order_name === '#1056')!.line_items[0]!.price).toBe(10);
  });

  it('écarte annulées, impayées et paiements annulés, garde les remboursées', () => {
    const { orders, skipped } = convert();
    const names = orders.map((o) => o.shopify_order_name);
    expect(names).not.toContain('#1057'); // voided
    expect(names).not.toContain('#1058'); // annulée
    expect(names).not.toContain('#1059'); // pending
    expect(names).toContain('#1060'); // remboursée : la vente a bien eu lieu
    expect(skipped).toMatchObject({ voided: 1, cancelled: 1, unpaid: 1 });
    const refunded = orders.find((o) => o.shopify_order_name === '#1060')!;
    expect(refunded.raw_payload.refunded_amount).toBe(20);
  });

  it('inclut annulées et impayées sur demande', () => {
    const { orders } = convert({ includeCancelled: true, includePending: true });
    const names = orders.map((o) => o.shopify_order_name);
    expect(names).toContain('#1058');
    expect(names).toContain('#1059');
    expect(names).not.toContain('#1057'); // voided reste exclu
  });

  it('filtre les canaux demandés', () => {
    const { orders, skipped } = convert({ channels: ['pos'] });
    expect(orders.every((o) => o.raw_payload.channel === 'pos')).toBe(true);
    expect(skipped.channel).toBeGreaterThan(0);
  });

  it('respecte --since et --before (jour de Paris)', () => {
    expect(convert({ before: '2026-08-11' }).orders.map((o) => o.shopify_order_name)).toEqual([
      '#1054',
    ]);
    expect(convert({ since: '2026-08-16' }).orders.map((o) => o.shopify_order_name)).toEqual([
      '#1060',
    ]);
    expect(convert({ before: '2026-08-10' }).orders).toHaveLength(0);
  });

  it('rejette une commande sans date ni Total lisibles', () => {
    const header = ['Id', 'Name', 'Created at', 'Total', 'Source'];
    const res = convertRows(
      [
        ['1', '#1', 'pas une date', '10.00', 'pos'],
        ['2', '#2', '2026-08-10 10:00:00 +0200', '', 'pos'],
      ],
      resolveColumns(header),
      OPTS,
    );
    expect(res.orders).toHaveLength(0);
    expect(res.rejected).toHaveLength(2);
    expect(res.rejected[1]!.reason).toMatch(/Total/);
  });

  it('trie par date et ne produit aucun doublon d’identifiant', () => {
    const { orders } = convert({ includeCancelled: true, includePending: true });
    const dates = orders.map((o) => o.shopify_created_at);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(orders.map((o) => o.shopify_order_id)).size).toBe(orders.length);
  });
});

describe('summarize', () => {
  it('ventile le CA par canal et par mois', () => {
    const { orders } = convert();
    const sum = summarize(orders);
    expect(sum.orders).toBe(4);
    expect(sum.from).toBe('2026-08-10');
    expect(sum.to).toBe('2026-08-16');
    expect(sum.totalTtc).toBe(429.8);
    expect(sum.byChannel.pos).toEqual({ orders: 2, ttc: 290 });
    expect(sum.byChannel.web).toEqual({ orders: 1, ttc: 39.8 });
    expect(sum.byChannel.draft).toEqual({ orders: 1, ttc: 100 });
    expect(sum.byMonth).toEqual([
      { month: '2026-08', orders: 4, byChannel: { pos: 290, web: 39.8, draft: 100, other: 0 } },
    ]);
  });
});
