/**
 * Réintégration de l'historique des ventes Shopify (caisse Shopify POS + boutique en ligne)
 * dans le dashboard ma-papeterie — logique pure, testée.
 *
 * Source : export CSV des commandes du back-office Shopify (Commandes › Exporter › toutes les
 * commandes), une ligne par article. C'est le seul export qui couvre TOUT l'historique :
 * l'Admin API ne renvoie que les 60 derniers jours sans le scope `read_all_orders`.
 *
 * Cible : la table `shopify_orders` du projet ma-papeterie — registre des commandes Shopify,
 * déjà lu par le dashboard (`v_admin_revenue_daily`, `admin_dashboard_kpi`, `customer_360`,
 * finances). Le canal est déduit de la colonne `Source`, avec la même taxonomie que la vue :
 * `pos` (caisse Shopify POS) → ca_pos, `web` / `channel:<id>` (boutique en ligne) → ca_web,
 * `shopify_draft_order` → ca_draft.
 *
 * Hors périmètre fiscal : rien n'est écrit dans la base `Pos` (NF525), ni dans
 * `pos_nf525_sales` (réservée aux tickets de la caisse NF525), ni dans `sales_orders`
 * (un historique rattrapé n'est pas une commande « à traiter »).
 */

import { normalizeHeader, parseCsv, parseNumber } from '../legacy-sales/convert.ts';

export const IMPORT_MARKER = 'shopify-csv-export';

/** Canaux du dashboard (`v_admin_revenue_daily`). */
export type Channel = 'pos' | 'web' | 'draft' | 'other';

export const CHANNEL_LABELS: Record<Channel, string> = {
  pos: 'caisse (Shopify POS)',
  web: 'boutique en ligne',
  draft: 'commande au comptoir (brouillon)',
  other: 'autre',
};

export type Field =
  | 'id'
  | 'name'
  | 'created_at'
  | 'paid_at'
  | 'cancelled_at'
  | 'financial_status'
  | 'fulfillment_status'
  | 'currency'
  | 'subtotal'
  | 'shipping'
  | 'taxes'
  | 'total'
  | 'discount'
  | 'refunded'
  | 'email'
  | 'phone'
  | 'billing_name'
  | 'shipping_name'
  | 'payment_method'
  | 'source'
  | 'location'
  | 'employee'
  | 'li_qty'
  | 'li_name'
  | 'li_price'
  | 'li_sku'
  | 'li_discount';

/**
 * En-têtes reconnus (export anglais ET français — l'export Shopify suit la langue du
 * back-office). Comparaison via `normalizeHeader` : sans accents, casse ni ponctuation.
 */
export const HEADERS: Record<Field, string[]> = {
  id: ['id', 'identifiant'],
  name: ['name', 'nom', 'commande', 'order'],
  created_at: ['created at', 'date de creation', 'cree le', 'creee le'],
  paid_at: ['paid at', 'paye le', 'payee le', 'date de paiement'],
  cancelled_at: ['cancelled at', 'annule le', 'annulee le', 'date d annulation'],
  financial_status: ['financial status', 'statut financier', 'statut du paiement'],
  fulfillment_status: ['fulfillment status', 'statut de traitement', 'statut d execution'],
  currency: ['currency', 'devise'],
  subtotal: ['subtotal', 'sous total'],
  shipping: ['shipping', 'expedition', 'livraison', 'frais d expedition'],
  taxes: ['taxes', 'taxe', 'tva'],
  total: ['total'],
  discount: ['discount amount', 'montant de la remise', 'montant remise', 'remise'],
  refunded: ['refunded amount', 'montant rembourse', 'montant du remboursement'],
  email: ['email', 'e mail', 'courriel', 'adresse e mail'],
  phone: ['phone', 'telephone', 'numero de telephone'],
  billing_name: ['billing name', 'nom de facturation', 'nom facturation'],
  shipping_name: ['shipping name', 'nom d expedition', 'nom expedition'],
  payment_method: ['payment method', 'mode de paiement', 'moyen de paiement'],
  source: ['source', 'canal', 'canal de vente'],
  location: ['location', 'emplacement', 'lieu'],
  employee: ['employee', 'employe', 'vendeur'],
  li_qty: ['lineitem quantity', 'quantite de l article', 'quantite article', 'quantite'],
  li_name: ['lineitem name', 'nom de l article', 'nom article', 'article'],
  li_price: ['lineitem price', 'prix de l article', 'prix article', 'prix'],
  li_sku: ['lineitem sku', 'sku de l article', 'sku article', 'sku'],
  li_discount: ['lineitem discount', 'remise de l article', 'remise article'],
};

/** Colonnes sans lesquelles l'import n'a pas de sens. */
const REQUIRED: Field[] = ['id', 'name', 'created_at', 'total', 'source'];

/** `normalizeHeader` en traitant l'apostrophe comme un espace (« Quantité de l'article »). */
function normColumn(h: string): string {
  return normalizeHeader(h.replace(/['\u2019`]/g, ' '));
}

export function resolveColumns(
  headers: string[],
  overrides: Partial<Record<Field, string>> = {},
): Partial<Record<Field, number>> {
  const norm = headers.map(normColumn);
  const out: Partial<Record<Field, number>> = {};
  const used = new Set<number>();
  for (const field of Object.keys(HEADERS) as Field[]) {
    const wanted = overrides[field];
    if (wanted === undefined) continue;
    const idx = norm.indexOf(normColumn(wanted));
    if (idx < 0) throw new Error(`Colonne « ${wanted} » (${field}) absente de l'en-tête`);
    out[field] = idx;
    used.add(idx);
  }
  for (const field of Object.keys(HEADERS) as Field[]) {
    if (out[field] !== undefined) continue;
    const idx = norm.findIndex((h, i) => !used.has(i) && HEADERS[field].includes(h));
    if (idx >= 0) {
      out[field] = idx;
      used.add(idx);
    }
  }
  const missing = REQUIRED.filter((f) => out[f] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Colonnes obligatoires introuvables : ${missing.join(', ')} — ` +
        'réexporter les commandes depuis Shopify sans retirer de colonne, ou utiliser --map',
    );
  }
  return out;
}

/** `pos`, `web`, `channel:11370740`, `shopify_draft_order` → canal du dashboard. */
export function channelOf(source: string): Channel {
  const s = source.trim().toLowerCase();
  if (s === 'pos') return 'pos';
  if (s === 'shopify_draft_order') return 'draft';
  if (s === 'web') return 'web';
  if (/^(channel:)?\d+$/.test(s)) return 'web';
  return 'other';
}

/** `2026-08-10 13:48:48 +0200`, `2026-08-10 13:48:48`, ISO → instant ISO ; `null` si illisible. */
export function parseShopifyDate(raw: string | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*([+-]\d{2}):?(\d{2})|Z)?/.exec(
      s,
    );
  if (!m) return null;
  const [, y, mo, d, h, mi, sec, offH, offM] = m;
  const base = `${y}-${mo}-${d}T${h}:${mi}:${sec ?? '00'}`;
  const zone = offH !== undefined ? `${offH}:${offM}` : s.endsWith('Z') ? 'Z' : 'Z';
  const date = new Date(`${base}${zone}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Ligne prête pour un upsert `shopify_orders` (mêmes colonnes que le webhook). */
export interface ShopifyOrderRow {
  shopify_order_id: string;
  shopify_order_number: string;
  shopify_order_name: string;
  customer_email: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  customer_phone: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  currency: string;
  subtotal_ttc: number;
  total_tax: number;
  total_shipping: number;
  total_discount: number;
  total_ttc: number;
  line_items: Array<{
    sku: string | null;
    shopifyVariantId: null;
    title: string;
    quantity: number;
    price: number;
  }>;
  shipping_address: null;
  billing_address: null;
  raw_payload: {
    imported_from: typeof IMPORT_MARKER;
    source_name: string;
    channel: Channel;
    payment_method: string | null;
    location: string | null;
    employee: string | null;
    refunded_amount: number;
    cancelled_at: string | null;
  };
  shopify_created_at: string;
}

export interface RowIssue {
  row: number;
  reason: string;
}

export interface ConvertOptions {
  /** Canaux conservés ; les autres sont comptés comme écartés. */
  channels: Channel[];
  /** Jour minimum inclus (AAAA-MM-JJ, heure de Paris) ou `null`. */
  since: string | null;
  /** Jour exclu et suivants (AAAA-MM-JJ) ou `null` — sert à ne pas empiéter sur l'existant. */
  before: string | null;
  /** Conserver les commandes annulées (exclues par défaut). */
  includeCancelled: boolean;
  /** Conserver les commandes impayées (`pending`, `partially_paid`…). */
  includePending: boolean;
}

export interface ConvertResult {
  orders: ShopifyOrderRow[];
  rejected: RowIssue[];
  skipped: {
    channel: number;
    period: number;
    cancelled: number;
    unpaid: number;
    voided: number;
  };
}

/** Statuts financiers Shopify traités comme « pas une vente ». */
const VOID_STATUSES = new Set(['voided', 'expired']);
const PAID_STATUSES = new Set(['paid', 'partially_refunded', 'refunded']);

function parisDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

function splitName(full: string | undefined): { first: string | null; last: string | null } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: null, last: null };
  if (parts.length === 1) return { first: parts[0]!, last: null };
  return { first: parts[0]!, last: parts.slice(1).join(' ') };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Regroupe les lignes de l'export en commandes. Les colonnes de niveau commande ne sont
 * remplies que sur la première ligne de chaque commande (comportement de l'export Shopify) :
 * la première valeur non vide rencontrée fait foi.
 */
export function convertRows(
  rows: string[][],
  columns: Partial<Record<Field, number>>,
  opts: ConvertOptions,
): ConvertResult {
  const cell = (r: string[], f: Field): string | undefined => {
    const i = columns[f];
    const v = i === undefined ? undefined : r[i];
    const t = v?.trim();
    return t === '' ? undefined : t;
  };
  const num = (r: string[], f: Field): number | null => parseNumber(cell(r, f));

  interface Draft {
    firstRow: number;
    head: Record<string, string | undefined>;
    amounts: Record<string, number>;
    lines: ShopifyOrderRow['line_items'];
  }

  const rejected: RowIssue[] = [];
  const drafts = new Map<string, Draft>();
  const keep = new Set(opts.channels);

  rows.forEach((r, i) => {
    const rowNo = i + 2; // ligne 1 = en-tête
    const name = cell(r, 'name');
    const id = cell(r, 'id');
    const key = id ?? name;
    if (!key) {
      rejected.push({ row: rowNo, reason: 'ni Id ni Name : ligne ignorée' });
      return;
    }
    let d = drafts.get(key);
    if (!d) {
      d = { firstRow: rowNo, head: {}, amounts: {}, lines: [] };
      drafts.set(key, d);
    }
    for (const f of [
      'id',
      'name',
      'created_at',
      'paid_at',
      'cancelled_at',
      'financial_status',
      'fulfillment_status',
      'currency',
      'email',
      'phone',
      'billing_name',
      'shipping_name',
      'payment_method',
      'source',
      'location',
      'employee',
    ] as Field[]) {
      if (d.head[f] === undefined) d.head[f] = cell(r, f);
    }
    for (const f of ['subtotal', 'shipping', 'taxes', 'total', 'discount', 'refunded'] as Field[]) {
      if (d.amounts[f] === undefined) {
        const v = num(r, f);
        if (v !== null) d.amounts[f] = v;
      }
    }
    const title = cell(r, 'li_name');
    const qty = num(r, 'li_qty');
    if (title !== undefined || qty !== null) {
      const price = num(r, 'li_price') ?? 0;
      const lineDiscount = num(r, 'li_discount') ?? 0;
      const quantity = qty ?? 1;
      d.lines.push({
        sku: cell(r, 'li_sku') ?? null,
        shopifyVariantId: null,
        title: title ?? 'Article',
        quantity,
        price: round2(quantity !== 0 ? price - lineDiscount / quantity : price),
      });
    }
  });

  const orders: ShopifyOrderRow[] = [];
  const skipped = { channel: 0, period: 0, cancelled: 0, unpaid: 0, voided: 0 };

  for (const d of drafts.values()) {
    const row = d.firstRow;
    const id = d.head.id;
    const name = d.head.name;
    if (!id) {
      rejected.push({
        row,
        reason: `commande ${name ?? '?'} sans colonne Id : réexporter avec la colonne Id`,
      });
      continue;
    }
    const createdAt = parseShopifyDate(d.head.created_at) ?? parseShopifyDate(d.head.paid_at);
    if (!createdAt) {
      rejected.push({ row, reason: `date illisible « ${d.head.created_at ?? ''} »` });
      continue;
    }
    const total = d.amounts.total;
    if (total === undefined) {
      rejected.push({ row, reason: 'colonne Total vide' });
      continue;
    }

    const source = d.head.source ?? '';
    const channel = channelOf(source);
    if (!keep.has(channel)) {
      skipped.channel += 1;
      continue;
    }
    const day = parisDay(createdAt);
    if ((opts.since && day < opts.since) || (opts.before && day >= opts.before)) {
      skipped.period += 1;
      continue;
    }
    const cancelledAt = parseShopifyDate(d.head.cancelled_at);
    if (cancelledAt && !opts.includeCancelled) {
      skipped.cancelled += 1;
      continue;
    }
    const financial = d.head.financial_status?.toLowerCase() ?? null;
    if (financial && VOID_STATUSES.has(financial)) {
      skipped.voided += 1;
      continue;
    }
    if (financial && !PAID_STATUSES.has(financial) && !opts.includePending) {
      skipped.unpaid += 1;
      continue;
    }

    const billing = splitName(d.head.billing_name ?? d.head.shipping_name);
    orders.push({
      shopify_order_id: id,
      shopify_order_number: (name ?? id).replace(/^#/, ''),
      shopify_order_name: name ?? `#${id}`,
      customer_email: d.head.email ?? null,
      customer_first_name: billing.first,
      customer_last_name: billing.last,
      customer_phone: d.head.phone ?? null,
      financial_status: financial,
      fulfillment_status: d.head.fulfillment_status?.toLowerCase() ?? null,
      currency: d.head.currency ?? 'EUR',
      subtotal_ttc: round2(d.amounts.subtotal ?? total),
      total_tax: round2(d.amounts.taxes ?? 0),
      total_shipping: round2(d.amounts.shipping ?? 0),
      total_discount: round2(d.amounts.discount ?? 0),
      total_ttc: round2(total),
      line_items: d.lines,
      shipping_address: null,
      billing_address: null,
      raw_payload: {
        imported_from: IMPORT_MARKER,
        source_name: source,
        channel,
        payment_method: d.head.payment_method ?? null,
        location: d.head.location ?? null,
        employee: d.head.employee ?? null,
        refunded_amount: round2(d.amounts.refunded ?? 0),
        cancelled_at: cancelledAt,
      },
      shopify_created_at: createdAt,
    });
  }

  orders.sort((a, b) => a.shopify_created_at.localeCompare(b.shopify_created_at));
  return { orders, rejected, skipped };
}

export interface Summary {
  orders: number;
  from: string | null;
  to: string | null;
  totalTtc: number;
  byMonth: Array<{ month: string; orders: number; byChannel: Record<Channel, number> }>;
  byChannel: Record<Channel, { orders: number; ttc: number }>;
}

export function summarize(orders: ShopifyOrderRow[]): Summary {
  const empty = (): Record<Channel, number> => ({ pos: 0, web: 0, draft: 0, other: 0 });
  const months = new Map<string, { orders: number; byChannel: Record<Channel, number> }>();
  const byChannel: Record<Channel, { orders: number; ttc: number }> = {
    pos: { orders: 0, ttc: 0 },
    web: { orders: 0, ttc: 0 },
    draft: { orders: 0, ttc: 0 },
    other: { orders: 0, ttc: 0 },
  };
  for (const o of orders) {
    const day = parisDay(o.shopify_created_at);
    const m = day.slice(0, 7);
    const acc = months.get(m) ?? { orders: 0, byChannel: empty() };
    acc.orders += 1;
    acc.byChannel[o.raw_payload.channel] += o.total_ttc;
    months.set(m, acc);
    byChannel[o.raw_payload.channel].orders += 1;
    byChannel[o.raw_payload.channel].ttc += o.total_ttc;
  }
  for (const c of Object.keys(byChannel) as Channel[]) byChannel[c].ttc = round2(byChannel[c].ttc);
  return {
    orders: orders.length,
    from: orders[0] ? parisDay(orders[0].shopify_created_at) : null,
    to: orders.at(-1) ? parisDay(orders.at(-1)!.shopify_created_at) : null,
    totalTtc: round2(orders.reduce((n, o) => n + o.total_ttc, 0)),
    byMonth: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({
        month,
        orders: v.orders,
        byChannel: Object.fromEntries(
          (Object.keys(v.byChannel) as Channel[]).map((c) => [c, round2(v.byChannel[c])]),
        ) as Record<Channel, number>,
      })),
    byChannel,
  };
}

export { parseCsv };
