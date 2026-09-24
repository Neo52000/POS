// =============================================================================
// Archive fiscale `pos-archive/v1` — MIROIR EXACT de `@pos/core` `archive.ts`
// (canonicalJson, toJsonl, buildArchiveFiles). Les Edge Functions ne peuvent pas importer
// packages/core (spécificateurs `.js`, déploiement limité à supabase/functions) : ce fichier
// est volontairement SANS IMPORT pour être aussi chargé par Vitest
// (packages/core/src/archive.test.ts) qui vérifie, sur le vecteur
// packages/core/src/__fixtures__/archive-vector.json, que les deux implémentations produisent
// les mêmes fichiers et le même manifest_sha256. Toute modification doit être faite des deux côtés.
// =============================================================================

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

export interface BuiltArchive {
  files: Record<string, Uint8Array>;
  manifest: ArchiveManifest;
  manifestSha256: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** JSON canonique : clés triées récursivement, sans espaces (miroir de @pos/core). */
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

export function toJsonl(records: readonly unknown[]): string {
  return records.map((r) => `${canonicalJson(r)}\n`).join('');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function canonicalIsoDate(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(value)}`);
  return date.toISOString();
}

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

/** Miroir de `@pos/core` `buildArchiveFiles`. */
export async function buildArchiveFiles(
  data: ArchiveData,
  options: { generatedAt?: Date | string } = {},
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
    entries.push({ name, sha256: await sha256Hex(text), bytes: bytes.length, records });
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
  return { files, manifest, manifestSha256: await sha256Hex(manifestText) };
}
