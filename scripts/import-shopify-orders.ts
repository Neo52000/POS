/**
 * Réintégration de l'historique des ventes Shopify (caisse Shopify POS + boutique en ligne)
 * dans le dashboard ma-papeterie, depuis l'export CSV des commandes du back-office Shopify.
 *
 *   MAPAP_SUPABASE_URL=… MAPAP_SERVICE_ROLE_KEY=… pnpm import-shopify-orders <orders_export.csv>
 *
 * Simulation par défaut (aucune écriture) ; `--apply` pour envoyer. Options :
 *   --channels pos,web,draft  canaux importés ; défaut `pos,web,draft` (`other` exclu)
 *   --since AAAA-MM-JJ        premier jour importé
 *   --before AAAA-MM-JJ       exclut ce jour et les suivants ; défaut : première commande du
 *                             canal déjà présente dans `shopify_orders` (anti-doublon par canal)
 *   --all-days                désactive l'anti-doublon de période (l'upsert reste sans écrasement)
 *   --include-cancelled       importe aussi les commandes annulées
 *   --include-pending         importe aussi les commandes impayées (`pending`, `authorized`…)
 *   --map <mapping.json>      colonnes : {"total":"Total payé","source":"Canal"}
 *   --report <fichier.csv>    lignes rejetées
 *
 * Écrit uniquement `shopify_orders` (upsert `shopify_order_id`, sans écraser une ligne déjà
 * posée par le webhook) : ni `sales_orders`, ni `pos_nf525_sales`, ni la base fiscale Pos.
 * Relancer est sans effet. Voir docs/IMPORT-VENTES-SHOPIFY.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  CHANNEL_LABELS,
  IMPORT_MARKER,
  channelOf,
  convertRows,
  parseCsv,
  resolveColumns,
  summarize,
  type Channel,
  type Field,
  type ShopifyOrderRow,
} from './shopify-orders/convert.ts';

const ALL_CHANNELS: Channel[] = ['pos', 'web', 'draft', 'other'];
const DEFAULT_CHANNELS: Channel[] = ['pos', 'web', 'draft'];
const BATCH = 200;

interface Args {
  file: string;
  channels: Channel[];
  since: string | null;
  before: string | null;
  allDays: boolean;
  includeCancelled: boolean;
  includePending: boolean;
  map: string | null;
  report: string | null;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    file: '',
    channels: DEFAULT_CHANNELS,
    since: null,
    before: null,
    allDays: false,
    includeCancelled: false,
    includePending: false,
    map: null,
    report: null,
    apply: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} : valeur manquante`);
      return v;
    };
    if (k === '--channels') {
      a.channels = next()
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean)
        .map((c) => {
          if (!ALL_CHANNELS.includes(c as Channel))
            throw new Error(`--channels : canal inconnu « ${c} » (${ALL_CHANNELS.join(', ')})`);
          return c as Channel;
        });
      if (a.channels.length === 0) throw new Error('--channels : liste vide');
    } else if (k === '--since') a.since = next();
    else if (k === '--before') a.before = next();
    else if (k === '--all-days') a.allDays = true;
    else if (k === '--include-cancelled') a.includeCancelled = true;
    else if (k === '--include-pending') a.includePending = true;
    else if (k === '--map') a.map = next();
    else if (k === '--report') a.report = next();
    else if (k === '--apply') a.apply = true;
    else if (k.startsWith('--')) throw new Error(`Option inconnue : ${k}`);
    else a.file = k;
  }
  if (!a.file) throw new Error('Fichier CSV requis (export des commandes Shopify)');
  for (const [opt, v] of [
    ['--since', a.since],
    ['--before', a.before],
  ] as const) {
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${opt} : AAAA-MM-JJ`);
  }
  return a;
}

const euros = (n: number): string =>
  n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

class Rest {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, ...extra };
  }

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/${path}`, { headers: this.headers() });
    if (!res.ok)
      throw new Error(`GET ${path.split('?')[0]} : HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  /** Upsert sans écrasement : une commande déjà présente (webhook) n'est jamais modifiée. */
  async insertIgnoreDuplicates(table: string, rows: unknown[]): Promise<void> {
    const res = await fetch(`${this.url}/rest/v1/${table}?on_conflict=shopify_order_id`, {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal',
      }),
      body: JSON.stringify(rows),
    });
    if (!res.ok) throw new Error(`POST ${table} : HTTP ${res.status} ${await res.text()}`);
  }
}

/** Première commande déjà présente dans `shopify_orders`, par canal du dashboard. */
async function firstPresentDayByChannel(db: Rest): Promise<Map<Channel, string>> {
  const rows = await db.get<Array<{ created_at: string; src: string | null }>>(
    'shopify_orders?select=created_at:shopify_created_at,src:raw_payload->>source_name' +
      `&raw_payload->>imported_from=not.eq.${IMPORT_MARKER}&order=shopify_created_at.asc&limit=10000`,
  );
  const out = new Map<Channel, string>();
  for (const r of rows) {
    const c = channelOf(r.src ?? '');
    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(r.created_at));
    const seen = out.get(c);
    if (!seen || day < seen) out.set(c, day);
  }
  return out;
}

/** Commandes déjà en base parmi celles du fichier (par `shopify_order_id`). */
async function existingIds(db: Rest, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = await db.get<Array<{ shopify_order_id: string }>>(
      `shopify_orders?select=shopify_order_id&shopify_order_id=in.(${chunk
        .map(encodeURIComponent)
        .join(',')})`,
    );
    for (const r of rows) found.add(r.shopify_order_id);
  }
  return found;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.MAPAP_SUPABASE_URL;
  const key = process.env.MAPAP_SERVICE_ROLE_KEY;
  const db = url && key ? new Rest(url.replace(/\/+$/, ''), key) : null;
  if (!db && !(args.before || args.allDays)) {
    throw new Error(
      'MAPAP_SUPABASE_URL et MAPAP_SERVICE_ROLE_KEY requis ' +
        '(ou simulation hors ligne avec --before AAAA-MM-JJ, ou --all-days)',
    );
  }
  if (args.apply && !db)
    throw new Error('--apply : MAPAP_SUPABASE_URL/MAPAP_SERVICE_ROLE_KEY requis');

  const rows = parseCsv(readFileSync(args.file, 'utf8'));
  const [header, ...data] = rows;
  if (!header) throw new Error('Fichier vide');
  const overrides = args.map
    ? (JSON.parse(readFileSync(args.map, 'utf8')) as Partial<Record<Field, string>>)
    : {};
  const columns = resolveColumns(header, overrides);

  // Anti-doublon : par défaut, on s'arrête avant la première commande du canal déjà présente.
  const presentByChannel =
    args.allDays || !db ? new Map<Channel, string>() : await firstPresentDayByChannel(db);
  const perChannel = new Map<Channel, { before: string | null }>();
  for (const c of args.channels) {
    perChannel.set(c, { before: args.before ?? presentByChannel.get(c) ?? null });
  }

  const orders: ShopifyOrderRow[] = [];
  const rejected: Array<{ row: number; reason: string }> = [];
  const skipped = { channel: 0, period: 0, cancelled: 0, unpaid: 0, voided: 0 };
  // Une conversion par canal : la limite anti-doublon diffère d'un canal à l'autre.
  for (const [channel, cfg] of perChannel) {
    const res = convertRows(data, columns, {
      channels: [channel],
      since: args.since,
      before: cfg.before,
      includeCancelled: args.includeCancelled,
      includePending: args.includePending,
    });
    orders.push(...res.orders);
    for (const r of res.rejected) if (!rejected.some((x) => x.row === r.row)) rejected.push(r);
    skipped.period += res.skipped.period;
    skipped.cancelled += res.skipped.cancelled;
    skipped.unpaid += res.skipped.unpaid;
    skipped.voided += res.skipped.voided;
  }
  orders.sort((a, b) => a.shopify_created_at.localeCompare(b.shopify_created_at));

  const already = db
    ? await existingIds(
        db,
        orders.map((o) => o.shopify_order_id),
      )
    : new Set<string>();
  const toInsert = orders.filter((o) => !already.has(o.shopify_order_id));
  const sum = summarize(toInsert);

  console.log(`\nFichier       : ${args.file} (${data.length} lignes d'articles)`);
  console.log(
    `Canaux        : ${args.channels.map((c) => `${c} (${CHANNEL_LABELS[c]})`).join(', ')}`,
  );
  for (const [channel, cfg] of perChannel) {
    console.log(
      `  ${channel.padEnd(6)}limite : ${
        cfg.before
          ? `commandes antérieures au ${cfg.before}` +
            (args.before ? ' (--before)' : ' — 1re commande déjà présente dans le dashboard')
          : 'aucune (tout l’historique)'
      }`,
    );
  }
  console.log(`Période       : ${sum.from ?? '-'} → ${sum.to ?? '-'}`);
  console.log(
    `Commandes     : ${toInsert.length} à importer ; ${already.size} déjà en base ; ` +
      `${skipped.period} hors période ; ${skipped.cancelled} annulées ; ${skipped.unpaid} impayées ; ` +
      `${skipped.voided} annulées/expirées (paiement)`,
  );
  console.log(`CA TTC        : ${euros(sum.totalTtc)}`);
  console.log(`Rejets        : ${rejected.length} ligne(s)`);
  console.log('\nCanal                                      Commandes        CA TTC');
  for (const c of args.channels) {
    const v = sum.byChannel[c];
    console.log(
      `${`${c} — ${CHANNEL_LABELS[c]}`.padEnd(42)}${String(v.orders).padStart(9)}${euros(v.ttc).padStart(14)}`,
    );
  }
  console.log('\nMois       Cmd       CA caisse     CA boutique       CA comptoir');
  for (const m of sum.byMonth) {
    console.log(
      `${m.month}  ${String(m.orders).padStart(4)}  ${euros(m.byChannel.pos).padStart(14)}  ${euros(
        m.byChannel.web,
      ).padStart(14)}  ${euros(m.byChannel.draft).padStart(16)}`,
    );
  }
  for (const r of rejected.slice(0, 10)) console.log(`  rejet ligne ${r.row} : ${r.reason}`);
  if (rejected.length > 10) console.log(`  … ${rejected.length - 10} autre(s) rejet(s)`);

  if (args.report) {
    const lines = ['type;ligne;motif'];
    for (const r of rejected) lines.push(`rejet;${r.row};"${r.reason.replace(/"/g, '""')}"`);
    writeFileSync(args.report, `${lines.join('\n')}\n`);
    console.log(`\nRapport       : ${args.report}`);
  }

  if (!args.apply) {
    console.log(
      '\nSIMULATION : rien n’a été écrit. Comparer le CA par mois avec les rapports Shopify,' +
        ' puis relancer avec --apply.',
    );
    return;
  }
  if (toInsert.length === 0) {
    console.log('\nRien à importer.');
    return;
  }
  for (let i = 0; i < toInsert.length; i += BATCH) {
    await db!.insertIgnoreDuplicates('shopify_orders', toInsert.slice(i, i + BATCH));
    process.stdout.write(`\rEnvoi : ${Math.min(i + BATCH, toInsert.length)}/${toInsert.length}`);
  }
  console.log(`\n\nImporté : ${toInsert.length} commande(s) dans shopify_orders.`);
}

main().catch((e: unknown) => {
  console.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
});
