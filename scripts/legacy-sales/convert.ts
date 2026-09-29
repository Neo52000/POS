/**
 * Import des anciennes ventes boutique dans le dashboard ma-papeterie (hors périmètre fiscal).
 * Logique pure, testée : lecture CSV (export de l'ancienne caisse), correspondance des colonnes,
 * regroupement des lignes en tickets, conversion au format de `pos_record_sales`.
 *
 * Les tickets importés vont dans `pos_nf525_sales` sous une caisse `HIST-<caisse>` avec
 * `signature_status = 'legacy_import'` : ils alimentent l'historique du dashboard (CA, météo,
 * top produits) sans jamais être confondus avec les tickets de la caisse NF525.
 */
import { createHash } from 'node:crypto';

export const LEGACY_SIGNATURE_STATUS = 'legacy_import';
export const LEGACY_REGISTER_PREFIX = 'HIST-';

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/** Séparateur le plus fréquent de la ligne d'en-tête (`;` pour les exports Excel français). */
export function detectDelimiter(headerLine: string): string {
  const candidates = [';', ',', '\t', '|'];
  let best = ';';
  let max = -1;
  for (const c of candidates) {
    const n = headerLine.split(c).length - 1;
    if (n > max) {
      max = n;
      best = c;
    }
  }
  return best;
}

/** CSV RFC 4180 (guillemets, `""` échappé, retours à la ligne dans un champ), BOM retiré. */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = delimiter ?? detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === sep) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Correspondance des colonnes
// ---------------------------------------------------------------------------------------------

export type Field =
  | 'date'
  | 'time'
  | 'ticket'
  | 'register'
  | 'label'
  | 'ean'
  | 'qty'
  | 'unit_ttc'
  | 'line_ttc'
  | 'vat_rate'
  | 'discount'
  | 'payment';

/** En-têtes reconnus automatiquement (comparaison sans accents, casse, espaces ni ponctuation). */
export const DEFAULT_HEADERS: Record<Field, string[]> = {
  date: ['date', 'date vente', 'date ticket', 'jour', 'datetime', 'date heure'],
  time: ['heure', 'time', 'heure vente'],
  ticket: [
    'ticket',
    'n ticket',
    'no ticket',
    'num ticket',
    'numero ticket',
    'numero',
    'id ticket',
    'transaction',
    'commande',
  ],
  register: ['caisse', 'poste', 'terminal', 'register'],
  label: ['libelle', 'designation', 'article', 'produit', 'description', 'nom'],
  ean: ['ean', 'ean13', 'code barre', 'codebarre', 'gencod', 'code ean'],
  qty: ['qte', 'quantite', 'qty', 'quantity'],
  unit_ttc: ['pu ttc', 'prix unitaire ttc', 'prix ttc', 'prix unitaire', 'pu'],
  line_ttc: ['total ttc', 'montant ttc', 'total ligne ttc', 'montant', 'total', 'ca ttc'],
  vat_rate: ['tva', 'taux tva', 'taux', 'vat'],
  discount: ['remise', 'remise ttc', 'montant remise'],
  payment: [
    'reglement',
    'mode reglement',
    'mode de reglement',
    'paiement',
    'moyen paiement',
    'mode paiement',
  ],
};

export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[°º#_.\-/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Index de colonne par champ. `overrides` (fichier `--map`) : `{ "label": "Désignation article" }`
 * — valeur exacte d'en-tête, prioritaire sur la reconnaissance automatique.
 */
export function resolveColumns(
  headers: string[],
  overrides: Partial<Record<Field, string>> = {},
): Partial<Record<Field, number>> {
  const norm = headers.map(normalizeHeader);
  const out: Partial<Record<Field, number>> = {};
  const used = new Set<number>();
  for (const field of Object.keys(DEFAULT_HEADERS) as Field[]) {
    const wanted = overrides[field];
    if (wanted !== undefined) {
      const idx = norm.indexOf(normalizeHeader(wanted));
      if (idx < 0) throw new Error(`Colonne « ${wanted} » (${field}) absente de l'en-tête`);
      out[field] = idx;
      used.add(idx);
    }
  }
  for (const field of Object.keys(DEFAULT_HEADERS) as Field[]) {
    if (out[field] !== undefined) continue;
    const idx = norm.findIndex((h, i) => !used.has(i) && DEFAULT_HEADERS[field].includes(h));
    if (idx >= 0) {
      out[field] = idx;
      used.add(idx);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Valeurs
// ---------------------------------------------------------------------------------------------

/** `1 234,56 €`, `-12.5`, `(3,20)` → nombre ; `null` si illisible. */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.replace(/[\s\u00a0\u202f€%]/g, '');
  if (s === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.includes(',') && s.includes('.')) {
    // Séparateur décimal = le dernier des deux.
    s =
      s.lastIndexOf(',') > s.lastIndexOf('.')
        ? s.replace(/\./g, '').replace(',', '.')
        : s.replace(/,/g, '');
  } else s = s.replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return negative ? -n : n;
}

export function toCents(euros: number): number {
  return Math.sign(euros) * Math.round(Math.abs(euros) * 100);
}

/** Décalage (minutes) de Europe/Paris à l'instant UTC donné. */
function parisOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - utcMs) / 60_000);
}

/** Heure légale de Paris → instant UTC (ISO). */
export function parisLocalToIso(y: number, mo: number, d: number, h = 12, mi = 0, s = 0): string {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = naive - parisOffsetMinutes(naive) * 60_000;
  utc = naive - parisOffsetMinutes(utc) * 60_000; // second passage : changement d'heure
  return new Date(utc).toISOString();
}

/**
 * `28/09/2026`, `28/09/2026 14:05[:07]`, `2026-09-28[ T]14:05`, `28-09-26` ; heure optionnelle
 * (colonne séparée ou midi par défaut, sans effet sur le jour). Renvoie `null` si illisible.
 */
export function parseDateTime(
  dateRaw: string | undefined,
  timeRaw?: string,
): { iso: string; day: string } | null {
  if (!dateRaw) return null;
  const s = dateRaw.trim();
  let y: number;
  let mo: number;
  let d: number;
  let rest = '';
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](.*))?$/.exec(s);
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
    rest = m[4] ?? '';
  } else {
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](.*))?$/.exec(s);
    if (!m) return null;
    d = Number(m[1]);
    mo = Number(m[2]);
    y = Number(m[3]);
    if (y < 100) y += 2000;
    rest = m[4] ?? '';
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = /^(\d{1,2})[:h](\d{2})(?::(\d{2}))?/.exec((timeRaw ?? rest).trim());
  const h = t ? Number(t[1]) : 12;
  const mi = t ? Number(t[2]) : 0;
  const sec = t?.[3] ? Number(t[3]) : 0;
  const day = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { iso: parisLocalToIso(y, mo, d, h, mi, sec), day };
}

const VAT_RATES = [20, 10, 5.5, 2.1, 0];

/** `20`, `20 %`, `0,2`, `5.5` → taux normalisé ; `null` si hors des taux français. */
export function parseVatRate(raw: string | undefined): number | null {
  const n = parseNumber(raw);
  if (n === null) return null;
  const pct = n > 0 && n < 1 ? n * 100 : n;
  const hit = VAT_RATES.find((r) => Math.abs(r - pct) < 0.01);
  return hit ?? null;
}

export function paymentMethod(raw: string | undefined): string {
  const s = normalizeHeader(raw ?? '');
  if (!s) return 'unknown';
  if (/(cb|carte|card|visa|master|sans contact|tpe)/.test(s)) return 'cb';
  if (/(esp|cash|liquide|numeraire)/.test(s)) return 'cash';
  if (/(cheque|chq)/.test(s) && /(cadeau|kdo|ucia)/.test(s)) return 'gift_ucia';
  if (/(cheque|chq)/.test(s)) return 'cheque';
  if (/(vir|transfer)/.test(s)) return 'transfer';
  if (/(cadeau|avoir|bon)/.test(s)) return 'gift_ucia';
  return 'other';
}

/** UUID déterministe (SHA-256, bits de version 5) : réimporter le même fichier ne duplique rien. */
export function deterministicUuid(seed: string): string {
  const h = createHash('sha256').update(seed).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * Numéro de ticket unique par caisse historique : `AAAAMMJJ` × 10⁶ + numéro d'origine (les anciens
 * numéros repartent souvent de 1 chaque jour), ou empreinte stable si le numéro n'est pas numérique.
 */
export function legacyTicketNumber(day: string, ticket: string): number {
  const ymd = Number(day.replace(/-/g, ''));
  const digits = /^\d{1,6}$/.test(ticket.trim()) ? Number(ticket.trim()) : null;
  if (digits !== null) return ymd * 1_000_000 + digits;
  const h = createHash('sha256').update(ticket).digest().readUInt32BE(0) % 900_000;
  return ymd * 1_000_000 + 100_000 + h;
}

// ---------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------

export interface ConvertOptions {
  /** Nom de la source (logiciel d'origine), intégré à l'identifiant : `ancienne-caisse`. */
  source: string;
  /** Caisse par défaut si le fichier n'a pas de colonne caisse. */
  register: string;
  /** Jour exclu et suivants (YYYY-MM-DD) : période déjà présente dans le dashboard. */
  before: string | null;
  /** Taux appliqué quand la colonne TVA manque ou est vide (signalé). */
  defaultVatRate: number;
}

export interface SaleLine {
  line_no: number;
  product_id?: string | null;
  ean: string | null;
  label: string;
  qty: number;
  line_ttc_cents: number;
  line_ht_cents: number;
  vat_rate: number;
}

export interface LegacySale {
  transaction_id: string;
  register_code: string;
  ticket_number: number;
  kind: 'sale' | 'refund';
  business_at: string;
  business_date: string;
  total_ttc_cents: number;
  total_ht_cents: number;
  total_vat_cents: number;
  vat_breakdown: Array<{
    rate: string;
    base_ht_cents: number;
    vat_cents: number;
    ttc_cents: number;
  }>;
  payments: Array<{ method: string; amount_cents: number }>;
  signature_status: string;
  lines: SaleLine[];
}

export interface RowIssue {
  row: number;
  reason: string;
}

export interface ConvertResult {
  sales: LegacySale[];
  rejected: RowIssue[];
  warnings: RowIssue[];
  /** Lignes écartées car postérieures ou égales à `before`. */
  skippedOverlap: number;
}

function htFromTtc(ttcCents: number, rate: number): number {
  const bp = Math.round(rate * 100);
  return Math.sign(ttcCents) * Math.round((Math.abs(ttcCents) * 10_000) / (10_000 + bp));
}

/** Regroupe les lignes d'article en tickets (clé : caisse + jour + numéro de ticket). */
export function convertRows(
  rows: string[][],
  columns: Partial<Record<Field, number>>,
  opts: ConvertOptions,
): ConvertResult {
  for (const f of ['date', 'ticket'] as const) {
    if (columns[f] === undefined)
      throw new Error(`Colonne obligatoire introuvable : ${f} (utiliser --map)`);
  }
  if (columns.line_ttc === undefined && columns.unit_ttc === undefined) {
    throw new Error(
      'Colonne de montant introuvable : total_ttc ou prix unitaire TTC (utiliser --map)',
    );
  }
  const cell = (r: string[], f: Field): string | undefined => {
    const i = columns[f];
    return i === undefined ? undefined : r[i]?.trim();
  };

  const rejected: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  let skippedOverlap = 0;
  const tickets = new Map<
    string,
    {
      at: string;
      day: string;
      register: string;
      ticket: string;
      lines: SaleLine[];
      pay: Map<string, number>;
    }
  >();

  rows.forEach((r, i) => {
    const rowNo = i + 2; // ligne 1 = en-tête
    const dt = parseDateTime(cell(r, 'date'), cell(r, 'time'));
    if (!dt)
      return void rejected.push({
        row: rowNo,
        reason: `date illisible « ${cell(r, 'date') ?? ''} »`,
      });
    if (opts.before && dt.day >= opts.before) {
      skippedOverlap += 1;
      return;
    }
    const ticket = cell(r, 'ticket');
    if (!ticket) return void rejected.push({ row: rowNo, reason: 'numéro de ticket vide' });

    const qtyRaw = cell(r, 'qty');
    const qty = qtyRaw === undefined || qtyRaw === '' ? 1 : parseNumber(qtyRaw);
    if (qty === null || qty === 0)
      return void rejected.push({ row: rowNo, reason: `quantité illisible « ${qtyRaw} »` });

    let ttc = parseNumber(cell(r, 'line_ttc'));
    if (ttc === null) {
      const unit = parseNumber(cell(r, 'unit_ttc'));
      if (unit !== null) ttc = unit * qty;
    }
    if (ttc === null) return void rejected.push({ row: rowNo, reason: 'montant TTC illisible' });
    const discount = parseNumber(cell(r, 'discount'));
    if (discount !== null && columns.line_ttc === undefined) ttc -= Math.abs(discount);

    let rate = parseVatRate(cell(r, 'vat_rate'));
    if (rate === null) {
      rate = opts.defaultVatRate;
      warnings.push({
        row: rowNo,
        reason: `TVA absente ou inconnue « ${cell(r, 'vat_rate') ?? ''} » : ${rate} % appliqué`,
      });
    }

    const register = cell(r, 'register') || opts.register;
    const key = `${register}|${dt.day}|${ticket}`;
    let t = tickets.get(key);
    if (!t) {
      t = { at: dt.iso, day: dt.day, register, ticket, lines: [], pay: new Map() };
      tickets.set(key, t);
    }
    const ttcCents = toCents(ttc);
    t.lines.push({
      line_no: t.lines.length + 1,
      ean: (cell(r, 'ean') ?? '').replace(/\D/g, '') || null,
      label: cell(r, 'label') || 'Article',
      qty,
      line_ttc_cents: ttcCents,
      line_ht_cents: htFromTtc(ttcCents, rate),
      vat_rate: rate,
    });
    const method = paymentMethod(cell(r, 'payment'));
    t.pay.set(method, (t.pay.get(method) ?? 0) + ttcCents);
  });

  const sales: LegacySale[] = [];
  for (const t of tickets.values()) {
    const vat = new Map<number, { ht: number; ttc: number }>();
    for (const l of t.lines) {
      const acc = vat.get(l.vat_rate) ?? { ht: 0, ttc: 0 };
      acc.ht += l.line_ht_cents;
      acc.ttc += l.line_ttc_cents;
      vat.set(l.vat_rate, acc);
    }
    const total = t.lines.reduce((s, l) => s + l.line_ttc_cents, 0);
    const ht = t.lines.reduce((s, l) => s + l.line_ht_cents, 0);
    const registerCode = `${LEGACY_REGISTER_PREFIX}${t.register}`.slice(0, 40);
    sales.push({
      transaction_id: deterministicUuid(
        `legacy|${opts.source}|${registerCode}|${t.day}|${t.ticket}`,
      ),
      register_code: registerCode,
      ticket_number: legacyTicketNumber(t.day, t.ticket),
      kind: total < 0 ? 'refund' : 'sale',
      business_at: t.at,
      business_date: t.day,
      total_ttc_cents: total,
      total_ht_cents: ht,
      total_vat_cents: total - ht,
      vat_breakdown: [...vat.entries()]
        .sort(([a], [b]) => a - b)
        .map(([rate, v]) => ({
          rate: rate.toFixed(2),
          base_ht_cents: v.ht,
          vat_cents: v.ttc - v.ht,
          ttc_cents: v.ttc,
        })),
      payments: [...t.pay.entries()].map(([method, amount_cents]) => ({ method, amount_cents })),
      signature_status: LEGACY_SIGNATURE_STATUS,
      lines: t.lines,
    });
  }
  sales.sort((a, b) => a.business_at.localeCompare(b.business_at));
  return { sales, rejected, warnings, skippedOverlap };
}

export interface ImportSummary {
  tickets: number;
  refunds: number;
  lines: number;
  from: string | null;
  to: string | null;
  totalTtcCents: number;
  byMonth: Array<{ month: string; tickets: number; ttc_cents: number }>;
}

export function summarize(sales: LegacySale[]): ImportSummary {
  const months = new Map<string, { tickets: number; ttc: number }>();
  for (const s of sales) {
    const m = s.business_date.slice(0, 7);
    const acc = months.get(m) ?? { tickets: 0, ttc: 0 };
    acc.tickets += s.kind === 'sale' ? 1 : 0;
    acc.ttc += s.total_ttc_cents;
    months.set(m, acc);
  }
  return {
    tickets: sales.filter((s) => s.kind === 'sale').length,
    refunds: sales.filter((s) => s.kind === 'refund').length,
    lines: sales.reduce((n, s) => n + s.lines.length, 0),
    from: sales[0]?.business_date ?? null,
    to: sales.at(-1)?.business_date ?? null,
    totalTtcCents: sales.reduce((n, s) => n + s.total_ttc_cents, 0),
    byMonth: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, tickets: v.tickets, ttc_cents: v.ttc })),
  };
}
