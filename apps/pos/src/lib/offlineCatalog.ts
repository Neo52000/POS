import { catalogRpc } from '@/lib/catalogClient';
import { db, getMeta, setMeta } from '@/lib/db';
import type { LocalProduct } from '@/lib/db';
import type { CatalogPageRow, PosProduct, PriceTier } from '@/types/pos';

/**
 * Catalogue local (Dexie `products`) pour la vente hors ligne (lot 4).
 * - Synchro complète si la table est vide ou si la dernière complète date de plus de 7 jours
 *   (pages de 5000, pagination par id) ; les produits absents sont retirés.
 * - Synchro delta toutes les 30 min : `p_since` = plus grand `updated_at` local ; les lignes
 *   `pos_visible = false` sont supprimées.
 */

export const CATALOG_PAGE_SIZE = 5000;
export const FULL_SYNC_MAX_AGE_MS = 7 * 24 * 3600_000;
export const DELTA_SYNC_INTERVAL_MS = 30 * 60_000;
const META_KEY = 'catalog_sync';

export interface CatalogPageRequest {
  after_id: string | null;
  limit: number;
  since: string | null;
}

export type CatalogPageFetcher = (req: CatalogPageRequest) => Promise<CatalogPageRow[]>;

export interface CatalogSyncMeta {
  last_full_at: string | null;
  last_delta_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

export interface CatalogSyncResult {
  mode: 'full' | 'delta';
  upserted: number;
  deleted: number;
  error: string | null;
}

export interface CatalogStatus extends CatalogSyncMeta {
  count: number;
  running: boolean;
}

const EMPTY_META: CatalogSyncMeta = {
  last_full_at: null,
  last_delta_at: null,
  last_error: null,
  last_error_at: null,
};

const defaultFetcher: CatalogPageFetcher = async ({ after_id, limit, since }) => {
  const rows = await catalogRpc<CatalogPageRow[] | null>('pos_catalog_page', {
    p_after_id: after_id,
    p_limit: limit,
    p_since: since,
  });
  return rows ?? [];
};

/** Minuscules, accents supprimés (NFD). */
export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Découpe en jetons alphanumériques normalisés (dédoublonnés). */
export function tokenize(text: string): string[] {
  const out = normalizeText(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return [...new Set(out)];
}

/** Jetons d'un produit : nom, marque, plus l'EAN brut. */
export function productTokens(p: Pick<PosProduct, 'name' | 'brand' | 'ean'>): string[] {
  const tokens = new Set([...tokenize(p.name), ...tokenize(p.brand ?? '')]);
  if (p.ean) tokens.add(p.ean.trim());
  return [...tokens];
}

function toPriceTiers(raw: unknown): PriceTier[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({ price: Number(t['price'] ?? 0), title: String(t['title'] ?? '') }));
}

export function rowToProduct(row: CatalogPageRow): PosProduct {
  return {
    id: row.id,
    name: row.name,
    brand: row.brand ?? null,
    ean: row.ean ?? null,
    image_url: row.image_url ?? null,
    price_ttc_cents: Number(row.price_ttc_cents),
    price_ht_cents: Number(row.price_ht_cents),
    vat_rate: Number(row.vat_rate),
    eco_tax_cents: Number(row.eco_tax_cents ?? 0),
    stock_boutique: Number(row.stock_boutique ?? 0),
    pos_price_tiers: toPriceTiers(row.pos_price_tiers),
  };
}

function toLocal(row: CatalogPageRow): LocalProduct {
  const data = rowToProduct(row);
  const local: LocalProduct = {
    id: row.id,
    tokens: productTokens(data),
    updated_at: row.updated_at,
    data,
  };
  if (data.ean) local.ean = data.ean;
  return local;
}

/** Écrit un lot ; un EAN déjà porté par un autre produit n'est pas indexé (index unique). */
async function putRows(rows: LocalProduct[]): Promise<void> {
  if (rows.length === 0) return;
  const eans = rows.map((r) => r.ean).filter((e): e is string => !!e);
  const owners = new Map<string, string>();
  if (eans.length) {
    const existing = await db.products.where('ean').anyOf(eans).toArray();
    for (const p of existing) if (p.ean) owners.set(p.ean, p.id);
  }
  const batchIds = new Set(rows.map((r) => r.id));
  // Les produits du lot qui changent d'EAN libèrent le leur.
  for (const [ean, id] of owners) {
    if (batchIds.has(id) && !rows.some((r) => r.id === id && r.ean === ean)) owners.delete(ean);
  }
  const seen = new Map<string, string>();
  for (const r of rows) {
    if (!r.ean) continue;
    const owner = seen.get(r.ean) ?? owners.get(r.ean);
    if (owner && owner !== r.id) delete r.ean;
    else seen.set(r.ean, r.id);
  }
  await db.transaction('rw', db.products, async () => {
    // Libère d'abord les EAN des produits du lot pour éviter les conflits d'index transitoires.
    const ids = [...batchIds];
    await db.products
      .where('id')
      .anyOf(ids)
      .modify((p) => {
        delete p.ean;
      });
    await db.products.bulkPut(rows);
  });
}

async function readMeta(): Promise<CatalogSyncMeta> {
  return { ...EMPTY_META, ...((await getMeta<CatalogSyncMeta>(META_KEY)) ?? {}) };
}

async function fullSync(
  fetchPage: CatalogPageFetcher,
  pageSize: number,
): Promise<Omit<CatalogSyncResult, 'error'>> {
  const seen = new Set<string>();
  let after: string | null = null;
  let upserted = 0;
  for (;;) {
    const page = await fetchPage({ after_id: after, limit: pageSize, since: null });
    const visible = page.filter((r) => r.pos_visible !== false);
    await putRows(visible.map(toLocal));
    for (const r of visible) seen.add(r.id);
    upserted += visible.length;
    const last = page[page.length - 1];
    if (page.length < pageSize || !last) break;
    after = last.id;
  }
  const ids = await db.products.toCollection().primaryKeys();
  const stale = ids.filter((id) => !seen.has(id));
  await db.products.bulkDelete(stale);
  return { mode: 'full', upserted, deleted: stale.length };
}

async function deltaSync(
  fetchPage: CatalogPageFetcher,
  pageSize: number,
): Promise<Omit<CatalogSyncResult, 'error'>> {
  const newest = await db.products.orderBy('updated_at').last();
  const since = newest?.updated_at ?? null;
  let after: string | null = null;
  let upserted = 0;
  let deleted = 0;
  for (;;) {
    const page = await fetchPage({ after_id: after, limit: pageSize, since });
    const removed = page.filter((r) => r.pos_visible === false).map((r) => r.id);
    const visible = page.filter((r) => r.pos_visible !== false);
    if (removed.length) {
      const existing = await db.products.bulkGet(removed);
      deleted += existing.filter(Boolean).length;
      await db.products.bulkDelete(removed);
    }
    await putRows(visible.map(toLocal));
    upserted += visible.length;
    const last = page[page.length - 1];
    if (page.length < pageSize || !last) break;
    after = last.id;
  }
  return { mode: 'delta', upserted, deleted };
}

let running: Promise<CatalogSyncResult> | null = null;

export function isCatalogSyncRunning(): boolean {
  return running !== null;
}

/**
 * Synchronise le catalogue local. `mode: 'auto'` (défaut) choisit complète/delta selon les règles.
 * Ne lève jamais : l'erreur est renvoyée et stockée dans `meta`.
 */
export function syncCatalog(
  opts: {
    mode?: 'auto' | 'full' | 'delta';
    fetchPage?: CatalogPageFetcher;
    now?: Date;
    pageSize?: number;
  } = {},
): Promise<CatalogSyncResult> {
  if (running) return running;
  const fetchPage = opts.fetchPage ?? defaultFetcher;
  const pageSize = opts.pageSize ?? CATALOG_PAGE_SIZE;
  running = (async (): Promise<CatalogSyncResult> => {
    const now = opts.now ?? new Date();
    const meta = await readMeta();
    const count = await db.products.count();
    const fullDue =
      count === 0 ||
      !meta.last_full_at ||
      now.getTime() - new Date(meta.last_full_at).getTime() > FULL_SYNC_MAX_AGE_MS;
    const mode = opts.mode && opts.mode !== 'auto' ? opts.mode : fullDue ? 'full' : 'delta';
    try {
      const r =
        mode === 'full'
          ? await fullSync(fetchPage, pageSize)
          : await deltaSync(fetchPage, pageSize);
      const at = now.toISOString();
      await setMeta(META_KEY, {
        ...meta,
        ...(mode === 'full' ? { last_full_at: at, last_delta_at: at } : { last_delta_at: at }),
        last_error: null,
        last_error_at: null,
      } satisfies CatalogSyncMeta);
      return { ...r, error: null };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await setMeta(META_KEY, {
        ...meta,
        last_error: message,
        last_error_at: now.toISOString(),
      } satisfies CatalogSyncMeta);
      return { mode, upserted: 0, deleted: 0, error: message };
    }
  })().finally(() => {
    running = null;
  });
  return running;
}

export async function catalogStatus(): Promise<CatalogStatus> {
  const [meta, count] = await Promise.all([readMeta(), db.products.count()]);
  return { ...meta, count, running: running !== null };
}

function rank(p: LocalProduct, rawQuery: string, normQuery: string): number {
  if (p.data.ean && p.data.ean === rawQuery) return 0;
  if (normalizeText(p.data.name).startsWith(normQuery)) return 1;
  return 2;
}

/**
 * Recherche locale : premier jeton via l'index multi-valeurs `tokens` (préfixe), les autres
 * jetons filtrés (préfixe d'un jeton du produit) ; EAN exact en tête.
 */
export async function searchLocal(query: string, limit: number): Promise<PosProduct[]> {
  const tokens = tokenize(query);
  const [first, ...rest] = tokens;
  if (!first) return [];
  const raw = query.trim();
  const norm = normalizeText(raw);
  const candidates = await db.products
    .where('tokens')
    .startsWith(first)
    .distinct()
    .filter((p) => rest.every((t) => p.tokens.some((pt) => pt.startsWith(t))))
    .limit(Math.max(limit * 5, 200))
    .toArray();
  return candidates
    .sort(
      (a, b) =>
        rank(a, raw, norm) - rank(b, raw, norm) || a.data.name.localeCompare(b.data.name, 'fr'),
    )
    .slice(0, limit)
    .map((p) => p.data);
}

/** Produit par EAN exact dans le catalogue local. */
export async function productByEanLocal(ean: string): Promise<PosProduct | null> {
  const code = ean.trim();
  if (!code) return null;
  const hit = await db.products
    .where('tokens')
    .equals(code)
    .filter((p) => p.data.ean === code)
    .first();
  return hit?.data ?? null;
}
