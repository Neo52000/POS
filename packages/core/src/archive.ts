/**
 * Archive fiscale périodique `pos-archive/v1` (NF525, exigence d'archivage — SPEC §11).
 *
 * Pur et isomorphe : aucune dépendance, SHA-256 via WebCrypto (`sha256HexAsync`) et chaîne des
 * tickets recalculée avec `computeTransactionHashAsync` / `verifyChainAsync` (mêmes règles que
 * `verifyChain`). Le ZIP (fflate) est produit par l'Edge Function `pos-export-archive` et relu par
 * `scripts/verify-archive.ts` : il n'est pas dans ce module.
 *
 * Une archive est une PARTITION CONTIGUË de la caisse (contrat lot 5) : tickets
 * `ticket_number > dernier ticket de l'archive précédente` et `received_at < period_end`, JET
 * `id > dernier événement archivé` et `created_at < period_end`, clôtures idem par
 * `closing_number`. Le premier ticket est ancré sur `chain_heads.anchor_ticket_hash`.
 *
 * Contenu :
 * - `transactions.jsonl`, `events.jsonl`, `closings.jsonl` : une ligne JSON canonique par
 *   enregistrement (clés triées récursivement, sans espaces), `\n` final ; fichier vide si aucun
 *   enregistrement ;
 * - `manifest.json` : JSON canonique (sans `\n` final) ; `manifest_sha256` = SHA-256 hex de ce
 *   fichier, enregistré et chaîné en base par `pos_register_archive`.
 *
 * Miroir Deno (sans import) : `supabase/functions/_shared/archive.ts`, vérifié par
 * `archive.test.ts` sur le vecteur `__fixtures__/archive-vector.json`.
 */
import type { VatBreakdownEntry } from './cart.js';
import { canonicalIsoDate, verifyChainAsync } from './hashChain.js';
import type { CanonicalLine, CanonicalPayment, ChainBreak, ChainedTxn } from './hashChain.js';
import { sha256HexAsync } from './sha256.js';

export const ARCHIVE_FORMAT = 'pos-archive/v1';
export const ARCHIVE_MANIFEST_FILE = 'manifest.json';
export const ARCHIVE_DATA_FILES = ['transactions.jsonl', 'events.jsonl', 'closings.jsonl'] as const;
export type ArchiveDataFile = (typeof ARCHIVE_DATA_FILES)[number];

export type ArchiveRecord = Record<string, unknown>;

/**
 * Têtes de chaîne de l'archive (contrat lot 5, partition contiguë) : `anchor_*` = dernier ticket
 * de l'archive précédente (`''` / `null` pour la première archive d'une caisse), `last_*` = dernier
 * élément de CETTE archive (`null` si elle n'en contient aucun). `pos_register_archive` relit
 * `last_ticket_number`, `last_event_id`, `last_closing_number` dans le manifeste.
 */
export interface ArchiveChainHeads {
  anchor_ticket_number: number | null;
  anchor_ticket_hash: string | null;
  last_ticket_number: number | null;
  last_ticket_hash: string | null;
  last_event_id: number | null;
  last_event_hash: string | null;
  last_closing_number: number | null;
  last_closing_hash: string | null;
}

/** Sortie de la RPC `pos_archive_data` (contrat lot 5). */
export interface ArchiveData {
  register: { id: string; code: string; label?: string | null };
  period_start: string;
  period_end: string;
  /** Lignes `pos_transactions` avec `lines` et `payments` imbriqués. */
  transactions: readonly ArchiveRecord[];
  events: readonly ArchiveRecord[];
  closings: readonly ArchiveRecord[];
  chain_heads: Partial<ArchiveChainHeads> | null;
  previous_archive: {
    id?: string;
    period_start?: string;
    hash: string;
    manifest_sha256: string;
    last_ticket_number?: number | null;
    last_event_id?: number | null;
    last_closing_number?: number | null;
  } | null;
  software: { name: string; version: string };
}

export interface ArchiveFileEntry {
  name: string;
  sha256: string;
  bytes: number;
  records: number;
}

export interface ArchiveManifest {
  format: typeof ARCHIVE_FORMAT;
  register_code: string;
  period_start: string;
  period_end: string;
  generated_at: string;
  software: { name: string; version: string };
  files: ArchiveFileEntry[];
  chain_heads: ArchiveChainHeads;
  previous_archive: { hash: string; manifest_sha256: string } | null;
  first_ticket_number: number | null;
  last_ticket_number: number | null;
}

export interface BuildArchiveOptions {
  /** Horodatage de génération (défaut : maintenant). Fixé dans les tests pour le déterminisme. */
  generatedAt?: Date | string;
}

export interface BuiltArchive {
  /** Contenu des fichiers (UTF-8), prêt pour `zipSync`. */
  files: Record<string, Uint8Array>;
  manifest: ArchiveManifest;
  manifestSha256: string;
}

export interface ArchiveVerification {
  ok: boolean;
  errors: string[];
  warnings: string[];
  manifest: ArchiveManifest | null;
  manifestSha256: string | null;
}

// ---------------------------------------------------------------------------
// JSON canonique
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * JSON canonique : clés d'objet triées récursivement (ordre des unités UTF-16, comme
 * `Array.prototype.sort`), aucun espace, nombres et chaînes sérialisés par `JSON.stringify`.
 * Les propriétés `undefined` sont omises (comme `JSON.stringify`), `undefined` dans un tableau
 * devient `null`. Refuse les nombres non finis, `bigint`, fonctions et objets non « plain ».
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: nombre non fini ${value}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new TypeError('canonicalJson: seuls les objets JSON simples sont acceptés');
      }
      const parts: string[] = [];
      for (const key of Object.keys(value).sort()) {
        const v = value[key];
        if (v === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${canonicalJson(v)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: type non sérialisable (${typeof value})`);
  }
}

/** JSON Lines canonique : une ligne par enregistrement, `\n` final ; `''` si aucun. */
export function toJsonl(records: readonly unknown[]): string {
  return records.map((r) => `${canonicalJson(r)}\n`).join('');
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function sortedBy(records: readonly ArchiveRecord[], key: string): ArchiveRecord[] {
  return [...records].sort((a, b) => (num(a[key]) ?? 0) - (num(b[key]) ?? 0));
}

function normalizeHeads(heads: Partial<ArchiveChainHeads> | null | undefined): ArchiveChainHeads {
  return {
    anchor_ticket_number: num(heads?.anchor_ticket_number),
    anchor_ticket_hash: str(heads?.anchor_ticket_hash),
    last_ticket_number: num(heads?.last_ticket_number),
    last_ticket_hash: str(heads?.last_ticket_hash),
    last_event_id: num(heads?.last_event_id),
    last_event_hash: str(heads?.last_event_hash),
    last_closing_number: num(heads?.last_closing_number),
    last_closing_hash: str(heads?.last_closing_hash),
  };
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Construit les fichiers de l'archive d'une caisse pour une période, à partir de la sortie de
 * `pos_archive_data`. Déterministe à `generatedAt` égal.
 */
export async function buildArchiveFiles(
  data: ArchiveData,
  options: BuildArchiveOptions = {},
): Promise<BuiltArchive> {
  const transactions = sortedBy(data.transactions, 'ticket_number');
  const contents: Record<ArchiveDataFile, { text: string; records: number }> = {
    'transactions.jsonl': { text: toJsonl(transactions), records: transactions.length },
    'events.jsonl': { text: toJsonl(sortedBy(data.events, 'id')), records: data.events.length },
    'closings.jsonl': {
      text: toJsonl(sortedBy(data.closings, 'closing_number')),
      records: data.closings.length,
    },
  };

  const files: Record<string, Uint8Array> = {};
  const entries: ArchiveFileEntry[] = [];
  for (const name of ARCHIVE_DATA_FILES) {
    const { text, records } = contents[name];
    const bytes = utf8(text);
    files[name] = bytes;
    entries.push({ name, sha256: await sha256HexAsync(text), bytes: bytes.length, records });
  }

  const first = transactions[0];
  const last = transactions[transactions.length - 1];
  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    register_code: data.register.code,
    period_start: canonicalIsoDate(data.period_start),
    period_end: canonicalIsoDate(data.period_end),
    generated_at: canonicalIsoDate(options.generatedAt ?? new Date()),
    software: { name: data.software.name, version: data.software.version },
    files: entries,
    chain_heads: normalizeHeads(data.chain_heads),
    previous_archive: data.previous_archive
      ? {
          hash: data.previous_archive.hash,
          manifest_sha256: data.previous_archive.manifest_sha256,
        }
      : null,
    first_ticket_number: first ? num(first['ticket_number']) : null,
    last_ticket_number: last ? num(last['ticket_number']) : null,
  };
  const manifestText = canonicalJson(manifest);
  files[ARCHIVE_MANIFEST_FILE] = utf8(manifestText);
  return { files, manifest, manifestSha256: await sha256HexAsync(manifestText) };
}

// ---------------------------------------------------------------------------
// Vérification
// ---------------------------------------------------------------------------

/** Ligne `pos_transactions` archivée → entrée de `verifyChain` (SPEC §3). */
export function archivedTransactionToChained(row: ArchiveRecord, registerCode: string): ChainedTxn {
  const lines = Array.isArray(row['lines']) ? (row['lines'] as ArchiveRecord[]) : [];
  const payments = Array.isArray(row['payments']) ? (row['payments'] as ArchiveRecord[]) : [];
  const breakdown = Array.isArray(row['vat_breakdown'])
    ? (row['vat_breakdown'] as ArchiveRecord[])
    : [];
  return {
    ticket_number: Number(row['ticket_number']),
    register_code: registerCode,
    client_txn_id: String(row['client_txn_id'] ?? ''),
    business_at: String(row['business_at'] ?? ''),
    kind: row['kind'] === 'refund' ? 'refund' : 'sale',
    total_ht_cents: Number(row['total_ht_cents']),
    total_vat_cents: Number(row['total_vat_cents']),
    total_ttc_cents: Number(row['total_ttc_cents']),
    vat_breakdown: breakdown.map((v): VatBreakdownEntry => ({
      rate: String(v['rate']),
      base_ht_cents: Number(v['base_ht_cents']),
      vat_cents: Number(v['vat_cents']),
      ttc_cents: Number(v['ttc_cents']),
    })),
    customer_account_id: str(row['customer_account_id']),
    lines: lines.map((l): CanonicalLine => ({
      line_no: Number(l['line_no']),
      product_id: str(l['product_id']),
      ean: str(l['ean']),
      label: String(l['label'] ?? ''),
      qty: Number(l['qty']),
      unit_price_ttc_cents: Number(l['unit_price_ttc_cents']),
      vat_rate: String(l['vat_rate']),
      discount_percent: Number(l['discount_percent'] ?? 0),
      line_ttc_cents: Number(l['line_ttc_cents']),
    })),
    payments: payments.map((p): CanonicalPayment => ({
      method: String(p['method']),
      amount_cents: Number(p['amount_cents']),
      reference: str(p['reference']),
    })),
    prev_hash: str(row['prev_hash']),
    hash: String(row['hash'] ?? ''),
  };
}

function describeBreak(b: ChainBreak): string {
  return `ticket ${b.ticket_number} : ${b.reason} (attendu ${b.expected}, trouvé ${b.actual})`;
}

function decodeFile(content: Uint8Array | string): string {
  if (typeof content === 'string') return content;
  // `ignoreBOM` : conserver un éventuel BOM pour que le hash porte sur les octets exacts.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
}

function parseJsonl(name: string, text: string, errors: string[]): ArchiveRecord[] | null {
  if (text === '') return [];
  if (!text.endsWith('\n')) {
    errors.push(`${name} : \\n final manquant`);
    return null;
  }
  const records: ArchiveRecord[] = [];
  const lines = text.slice(0, -1).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      errors.push(`${name} ligne ${i + 1} : JSON invalide`);
      return null;
    }
    if (!isPlainObject(parsed)) {
      errors.push(`${name} ligne ${i + 1} : objet JSON attendu`);
      return null;
    }
    if (canonicalJson(parsed) !== line) {
      errors.push(`${name} ligne ${i + 1} : JSON non canonique`);
    }
    records.push(parsed);
  }
  return records;
}

function isManifest(value: unknown): value is ArchiveManifest {
  if (!isPlainObject(value)) return false;
  return (
    typeof value['register_code'] === 'string' &&
    typeof value['period_start'] === 'string' &&
    typeof value['period_end'] === 'string' &&
    Array.isArray(value['files']) &&
    isPlainObject(value['chain_heads'])
  );
}

/** Vérifie la liaison `prev_hash` → `hash` d'enregistrements déjà triés. */
function checkLinkage(label: string, records: readonly ArchiveRecord[], idKey: string): string[] {
  const errors: string[] = [];
  for (let i = 1; i < records.length; i += 1) {
    const prev = records[i - 1] as ArchiveRecord;
    const cur = records[i] as ArchiveRecord;
    if ((str(cur['prev_hash']) ?? '') !== (str(prev['hash']) ?? '')) {
      errors.push(`${label} ${String(cur[idKey])} : prev_hash ≠ hash de ${String(prev[idKey])}`);
    }
  }
  return errors;
}

/** La tête `last_*` du manifeste doit désigner exactement le dernier élément archivé (ou `null`). */
function checkHead(
  label: string,
  headNumber: number | null,
  headHash: string | null,
  lastNumber: number | null,
  lastHash: string | null,
  errors: string[],
): void {
  if (headNumber !== lastNumber) {
    errors.push(
      `chain_heads.${label} = ${String(headNumber)} ≠ dernier élément archivé ${String(lastNumber)}`,
    );
    return;
  }
  if (lastNumber !== null && (headHash ?? '') !== (lastHash ?? '')) {
    errors.push(`chain_heads.${label} : hash de tête ≠ hash du dernier élément archivé`);
  }
}

/** `true` si `value` est une date strictement antérieure à `end` (ms). */
function before(value: unknown, end: number): boolean {
  const t = Date.parse(String(value));
  return Number.isFinite(t) && t < end;
}

/**
 * Vérifie une archive décompressée : manifeste canonique, hash/taille/nombre d'enregistrements
 * de chaque fichier, cohérence du manifeste (premier/dernier ticket, têtes de chaîne), chaîne des
 * tickets recalculée (SPEC §3), liaison `prev_hash` du JET et des clôtures.
 * Ne vérifie PAS le chaînage entre archives (voir `pos_verify_archives_chain`) : comparer
 * `manifestSha256` à `pos_archives.manifest_sha256`.
 */
export async function verifyArchive(
  files: Readonly<Record<string, Uint8Array | string>>,
): Promise<ArchiveVerification> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = (): ArchiveVerification => ({
    ok: false,
    errors,
    warnings,
    manifest: null,
    manifestSha256: null,
  });

  // 1. Manifeste
  const rawManifest = files[ARCHIVE_MANIFEST_FILE];
  if (rawManifest === undefined) {
    errors.push(`${ARCHIVE_MANIFEST_FILE} absent`);
    return fail();
  }
  let manifestText: string;
  let manifestValue: unknown;
  try {
    manifestText = decodeFile(rawManifest);
    manifestValue = JSON.parse(manifestText);
  } catch {
    errors.push(`${ARCHIVE_MANIFEST_FILE} : UTF-8 ou JSON invalide`);
    return fail();
  }
  if (!isManifest(manifestValue)) {
    errors.push(`${ARCHIVE_MANIFEST_FILE} : structure invalide`);
    return fail();
  }
  const manifest = manifestValue;
  const manifestSha256 = await sha256HexAsync(manifestText);
  if (manifest.format !== ARCHIVE_FORMAT) {
    errors.push(`format inattendu : ${String(manifest.format)} (attendu ${ARCHIVE_FORMAT})`);
  }
  if (canonicalJson(manifest) !== manifestText) {
    errors.push(`${ARCHIVE_MANIFEST_FILE} : sérialisation non canonique`);
  }
  const start = Date.parse(manifest.period_start);
  const end = Date.parse(manifest.period_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    errors.push('manifeste : période invalide');
  }

  // 2. Fichiers listés
  const listed = new Map<string, ArchiveFileEntry>();
  for (const entry of manifest.files) {
    if (listed.has(entry.name)) errors.push(`manifeste : fichier ${entry.name} listé deux fois`);
    listed.set(entry.name, entry);
  }
  for (const name of ARCHIVE_DATA_FILES) {
    if (!listed.has(name)) errors.push(`manifeste : ${name} non listé`);
  }
  for (const name of Object.keys(files)) {
    if (name !== ARCHIVE_MANIFEST_FILE && !listed.has(name)) {
      errors.push(`fichier ${name} présent mais absent du manifeste`);
    }
  }

  const parsed: Partial<Record<ArchiveDataFile, ArchiveRecord[]>> = {};
  for (const [name, entry] of listed) {
    const raw = files[name];
    if (raw === undefined) {
      errors.push(`${name} listé dans le manifeste mais absent de l'archive`);
      continue;
    }
    let text: string;
    try {
      text = decodeFile(raw);
    } catch {
      errors.push(`${name} : UTF-8 invalide`);
      continue;
    }
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw).length : raw.length;
    if (bytes !== entry.bytes) errors.push(`${name} : taille ${bytes} ≠ ${entry.bytes} octets`);
    const sha = await sha256HexAsync(text);
    if (sha !== entry.sha256) errors.push(`${name} : SHA-256 ${sha} ≠ manifeste ${entry.sha256}`);
    const records = parseJsonl(name, text, errors);
    if (records === null) continue;
    if (records.length !== entry.records) {
      errors.push(`${name} : ${records.length} enregistrements ≠ manifeste ${entry.records}`);
    }
    if ((ARCHIVE_DATA_FILES as readonly string[]).includes(name)) {
      parsed[name as ArchiveDataFile] = records;
    }
  }

  const heads = normalizeHeads(manifest.chain_heads);

  // 3. Tickets : partition contiguë ancrée sur le dernier ticket de l'archive précédente.
  const transactions = parsed['transactions.jsonl'];
  if (transactions) {
    const chained = transactions
      .map((row) => archivedTransactionToChained(row, manifest.register_code))
      .sort((a, b) => a.ticket_number - b.ticket_number);
    const first = chained[0];
    const last = chained[chained.length - 1];
    if ((first?.ticket_number ?? null) !== manifest.first_ticket_number) {
      errors.push(
        `manifeste : first_ticket_number ${String(manifest.first_ticket_number)} ≠ ${String(first?.ticket_number ?? null)}`,
      );
    }
    if ((last?.ticket_number ?? null) !== manifest.last_ticket_number) {
      errors.push(
        `manifeste : last_ticket_number ${String(manifest.last_ticket_number)} ≠ ${String(last?.ticket_number ?? null)}`,
      );
    }
    if (first) {
      const anchorNumber = heads.anchor_ticket_number ?? 0;
      if (first.ticket_number !== anchorNumber + 1) {
        errors.push(
          `premier ticket ${first.ticket_number} ≠ ancre ${anchorNumber} + 1 (partition non contiguë)`,
        );
      }
      const anchorHash = (heads.anchor_ticket_hash ?? '').toLowerCase();
      if ((first.prev_hash ?? '').toLowerCase() !== anchorHash) {
        errors.push(
          `ticket ${first.ticket_number} : prev_hash ≠ chain_heads.anchor_ticket_hash (${anchorHash || "''"})`,
        );
      }
    }
    try {
      // Numérotation continue, prev_hash et hash recalculé de chaque ticket (SPEC §3).
      const result = await verifyChainAsync(chained);
      if (!result.ok) {
        errors.push(`chaîne des tickets rompue : ${describeBreak(result.first_break)}`);
      }
    } catch (e) {
      errors.push(`chaîne des tickets : ${e instanceof Error ? e.message : String(e)}`);
    }
    checkHead(
      'last_ticket_number',
      heads.last_ticket_number,
      heads.last_ticket_hash,
      last?.ticket_number ?? null,
      last?.hash ?? null,
      errors,
    );
    const late = transactions.filter(
      (t) => t['received_at'] !== undefined && !before(t['received_at'], end),
    ).length;
    if (late > 0) errors.push(`${late} ticket(s) reçus après la fin de période`);
    const outside = transactions.filter((t) => {
      const at = Date.parse(String(t['business_at']));
      return !(at >= start && at < end);
    }).length;
    if (outside > 0) {
      // Normal pour une vente hors ligne rejouée après la fin de la période de sa vente.
      warnings.push(`${outside} ticket(s) dont business_at est hors période (ventes hors ligne ?)`);
    }
  }

  // 4. JET (hash calculé côté SQL uniquement : on vérifie la liaison prev_hash, par caisse)
  const events = parsed['events.jsonl'];
  if (events) {
    const ordered = sortedBy(events, 'id');
    const byRegister = new Map<string, ArchiveRecord[]>();
    for (const e of ordered) {
      const key = str(e['register_id']) ?? '';
      byRegister.set(key, [...(byRegister.get(key) ?? []), e]);
    }
    for (const group of byRegister.values()) errors.push(...checkLinkage('événement', group, 'id'));
    const last = ordered[ordered.length - 1];
    checkHead(
      'last_event_id',
      heads.last_event_id,
      heads.last_event_hash,
      last ? num(last['id']) : null,
      last ? str(last['hash']) : null,
      errors,
    );
    const late = events.filter((e) => !before(e['created_at'], end)).length;
    if (late > 0) errors.push(`${late} événement(s) créés après la fin de période`);
  }

  // 5. Clôtures (numérotation continue + liaison prev_hash)
  const closings = parsed['closings.jsonl'];
  if (closings) {
    const ordered = sortedBy(closings, 'closing_number');
    for (let i = 1; i < ordered.length; i += 1) {
      const a = num(ordered[i - 1]?.['closing_number']);
      const b = num(ordered[i]?.['closing_number']);
      if (a === null || b === null || b !== a + 1) {
        errors.push(`clôtures : numérotation discontinue entre ${String(a)} et ${String(b)}`);
      }
    }
    errors.push(...checkLinkage('clôture', ordered, 'closing_number'));
    const last = ordered[ordered.length - 1];
    checkHead(
      'last_closing_number',
      heads.last_closing_number,
      heads.last_closing_hash,
      last ? num(last['closing_number']) : null,
      last ? str(last['hash']) : null,
      errors,
    );
    const late = closings.filter((c) => !before(c['created_at'], end)).length;
    if (late > 0) errors.push(`${late} clôture(s) créées après la fin de période`);
  }

  return { ok: errors.length === 0, errors, warnings, manifest, manifestSha256 };
}
