/**
 * Import des anciennes ventes boutique (export CSV de l'ancienne caisse) dans le dashboard
 * ma-papeterie — HORS périmètre fiscal : les tickets vont dans `pos_nf525_sales` sous une caisse
 * `HIST-…` (`signature_status = legacy_import`), jamais dans la base fiscale Pos.
 *
 *   MAPAP_SUPABASE_URL=… MAPAP_SERVICE_ROLE_KEY=… pnpm import-legacy-sales <export.csv> [options]
 *
 * Simulation par défaut (aucune écriture) ; `--apply` pour envoyer. Options :
 *   --map <mapping.json>      colonnes : {"date":"Date","ticket":"N° ticket","label":"Désignation",…}
 *   --source <nom>            logiciel d'origine (identifiants stables), défaut `ancienne-caisse`
 *   --register <code>         caisse si le fichier n'a pas de colonne caisse, défaut `1`
 *   --before <AAAA-MM-JJ>     exclut ce jour et les suivants ; défaut : 1er jour déjà présent dans
 *                             le dashboard pour la boutique (Shopify POS ou caisse NF525)
 *   --vat <taux>              TVA appliquée si absente, défaut 20
 *   --no-ean                  ne pas rattacher les lignes aux produits par EAN
 *   --report <fichier.csv>    liste des lignes rejetées et avertissements
 * Réimporter le même fichier est sans effet (identifiants déterministes, pos_record_sales
 * idempotent). Retrait complet : voir docs/IMPORT-ANCIENNES-VENTES.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  LEGACY_REGISTER_PREFIX,
  convertRows,
  parseCsv,
  resolveColumns,
  summarize,
  type Field,
  type LegacySale,
} from './legacy-sales/convert.ts';

interface Args {
  file: string;
  map: string | null;
  source: string;
  register: string;
  before: string | null;
  vat: number;
  ean: boolean;
  apply: boolean;
  report: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    file: '',
    map: null,
    source: 'ancienne-caisse',
    register: '1',
    before: null,
    vat: 20,
    ean: true,
    apply: false,
    report: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} : valeur manquante`);
      return v;
    };
    if (k === '--map') a.map = next();
    else if (k === '--source') a.source = next();
    else if (k === '--register') a.register = next();
    else if (k === '--before') a.before = next();
    else if (k === '--vat') a.vat = Number(next());
    else if (k === '--no-ean') a.ean = false;
    else if (k === '--apply') a.apply = true;
    else if (k === '--report') a.report = next();
    else if (k.startsWith('--')) throw new Error(`Option inconnue : ${k}`);
    else a.file = k;
  }
  if (!a.file) throw new Error('Fichier CSV requis');
  if (a.before && !/^\d{4}-\d{2}-\d{2}$/.test(a.before)) throw new Error('--before : AAAA-MM-JJ');
  return a;
}

const euros = (cents: number): string =>
  (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

class Rest {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}

  async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      headers: { apikey: this.key, Authorization: `Bearer ${this.key}` },
    });
    if (!res.ok)
      throw new Error(`GET ${path.split('?')[0]} : HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async rpc<T>(fn: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`RPC ${fn} : HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

/** Premier jour de ventes boutique déjà présent dans le dashboard (Shopify POS ou NF525). */
async function firstDashboardDay(db: Rest): Promise<string | null> {
  const days: string[] = [];
  const shopify = await db.get<Array<{ created_at: string | null }>>(
    'shopify_orders?select=created_at:raw_payload->>created_at' +
      '&raw_payload->>source_name=eq.pos&order=raw_payload->>created_at.asc&limit=1',
  );
  if (shopify[0]?.created_at) days.push(shopify[0].created_at.slice(0, 10));
  const nf525 = await db.get<Array<{ business_date: string }>>(
    `pos_nf525_sales?select=business_date&register_code=not.like.${LEGACY_REGISTER_PREFIX}*` +
      '&order=business_date.asc&limit=1',
  );
  if (nf525[0]?.business_date) days.push(nf525[0].business_date);
  return days.sort()[0] ?? null;
}

/** Rattache les lignes aux produits du catalogue par EAN (marge et top produits du dashboard). */
async function resolveEans(db: Rest, sales: LegacySale[]): Promise<number> {
  const eans = [
    ...new Set(sales.flatMap((s) => s.lines.map((l) => l.ean)).filter((e): e is string => !!e)),
  ];
  const byEan = new Map<string, string>();
  for (let i = 0; i < eans.length; i += 100) {
    const chunk = eans.slice(i, i + 100);
    const rows = await db.get<Array<{ id: string; ean: string }>>(
      `products?select=id,ean&ean=in.(${chunk.map(encodeURIComponent).join(',')})`,
    );
    for (const r of rows) byEan.set(r.ean, r.id);
  }
  let matched = 0;
  for (const s of sales) {
    for (const l of s.lines) {
      const id = l.ean ? byEan.get(l.ean) : undefined;
      if (id) {
        l.product_id = id;
        matched += 1;
      }
    }
  }
  return matched;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.MAPAP_SUPABASE_URL;
  const key = process.env.MAPAP_SERVICE_ROLE_KEY;
  const db = url && key ? new Rest(url.replace(/\/+$/, ''), key) : null;
  if (!db && (args.apply || args.ean || !args.before)) {
    throw new Error(
      'MAPAP_SUPABASE_URL et MAPAP_SERVICE_ROLE_KEY requis (ou simulation hors ligne : --before AAAA-MM-JJ --no-ean)',
    );
  }

  const rows = parseCsv(readFileSync(args.file, 'utf8'));
  const [header, ...data] = rows;
  if (!header) throw new Error('Fichier vide');
  const overrides = args.map
    ? (JSON.parse(readFileSync(args.map, 'utf8')) as Partial<Record<Field, string>>)
    : {};
  const columns = resolveColumns(header, overrides);

  const before = args.before ?? (db ? await firstDashboardDay(db) : null);
  const result = convertRows(data, columns, {
    source: args.source,
    register: args.register,
    before,
    defaultVatRate: args.vat,
  });
  const { sales } = result;
  const matched = db && args.ean ? await resolveEans(db, sales) : 0;
  const sum = summarize(sales);

  console.log(`\nFichier       : ${args.file} (${data.length} lignes)`);
  console.log(
    `Colonnes      : ${Object.entries(columns)
      .map(([f, i]) => `${f}=« ${header[i as number]} »`)
      .join(', ')}`,
  );
  console.log(
    `Limite        : ventes antérieures au ${before ?? '(aucune)'}` +
      (result.skippedOverlap
        ? ` — ${result.skippedOverlap} ligne(s) écartée(s), déjà dans le dashboard`
        : ''),
  );
  console.log(`Période       : ${sum.from ?? '-'} → ${sum.to ?? '-'}`);
  console.log(
    `Tickets       : ${sum.tickets} ventes, ${sum.refunds} remboursements, ${sum.lines} lignes`,
  );
  console.log(`CA TTC net    : ${euros(sum.totalTtcCents)}`);
  if (db && args.ean)
    console.log(`Produits      : ${matched}/${sum.lines} lignes rattachées au catalogue par EAN`);
  console.log(
    `Rejets        : ${result.rejected.length} ligne(s) ; avertissements : ${result.warnings.length}`,
  );
  console.log('\nMois       Tickets   CA TTC');
  for (const m of sum.byMonth) {
    console.log(
      `${m.month}  ${String(m.tickets).padStart(8)}   ${euros(m.ttc_cents).padStart(14)}`,
    );
  }
  for (const r of result.rejected.slice(0, 10)) console.log(`  rejet ligne ${r.row} : ${r.reason}`);
  if (result.rejected.length > 10)
    console.log(`  … ${result.rejected.length - 10} autre(s) rejet(s)`);

  if (args.report) {
    const lines = ['type;ligne;motif'];
    for (const r of result.rejected) lines.push(`rejet;${r.row};"${r.reason.replace(/"/g, '""')}"`);
    for (const w of result.warnings)
      lines.push(`avertissement;${w.row};"${w.reason.replace(/"/g, '""')}"`);
    writeFileSync(args.report, `${lines.join('\n')}\n`);
    console.log(`\nRapport       : ${args.report}`);
  }

  if (!args.apply) {
    console.log('\nSIMULATION : rien n’a été écrit. Relancer avec --apply pour importer.');
    return;
  }
  let applied = 0;
  let already = 0;
  const errors: string[] = [];
  for (let i = 0; i < sales.length; i += 200) {
    const batch = sales.slice(i, i + 200);
    const res = await db!.rpc<
      Array<{ transaction_id: string; applied: boolean; already_applied?: boolean; error?: string }>
    >('pos_record_sales', { p_sales: batch });
    for (const r of res) {
      if (r.applied) applied += 1;
      else if (r.already_applied) already += 1;
      else errors.push(`${r.transaction_id} : ${r.error ?? 'refusé'}`);
    }
    process.stdout.write(`\rEnvoi : ${Math.min(i + 200, sales.length)}/${sales.length}`);
  }
  console.log(
    `\n\nImportés : ${applied} ; déjà présents : ${already} ; refusés : ${errors.length}`,
  );
  for (const e of errors.slice(0, 10)) console.log(`  ${e}`);
  process.exitCode = errors.length ? 1 : 0;
}

main().catch((e: unknown) => {
  console.error(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
});
