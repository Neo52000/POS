import { describe, expect, it } from 'vitest';

import vector from './__fixtures__/archive-vector.json';
import {
  ARCHIVE_DATA_FILES,
  buildArchiveFiles,
  canonicalJson,
  toJsonl,
  verifyArchive,
} from './archive.js';
import type { ArchiveData, ArchiveRecord, BuiltArchive } from './archive.js';
import { sha256HexAsync } from './sha256.js';

const data = vector.data as unknown as ArchiveData;
const GENERATED_AT = vector.generated_at;

function build(input: ArchiveData = data): Promise<BuiltArchive> {
  return buildArchiveFiles(input, { generatedAt: GENERATED_AT });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Remplace un fichier ; si `resign`, recalcule son entrée du manifeste (falsification cohérente). */
async function tamper(
  files: Record<string, Uint8Array>,
  name: string,
  edit: (text: string) => string,
  resign = false,
): Promise<Record<string, Uint8Array>> {
  const out = { ...files };
  const text = edit(decoder.decode(files[name]));
  out[name] = encoder.encode(text);
  if (resign) {
    const manifest = JSON.parse(decoder.decode(files['manifest.json'])) as {
      files: Array<{ name: string; sha256: string; bytes: number }>;
    };
    const entry = manifest.files.find((f) => f.name === name)!;
    entry.sha256 = await sha256HexAsync(text);
    entry.bytes = encoder.encode(text).length;
    out['manifest.json'] = encoder.encode(canonicalJson(manifest));
  }
  return out;
}

function editRecords(text: string, fn: (records: ArchiveRecord[]) => void): string {
  const records = text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ArchiveRecord);
  fn(records);
  return toJsonl(records);
}

describe('canonicalJson / toJsonl', () => {
  it('trie les clés récursivement, sans espaces', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: null, y: 'é' }], c: true } })).toBe(
      '{"a":{"c":true,"d":[3,{"y":"é","z":null}]},"b":1}',
    );
  });

  it('omet undefined dans les objets, null dans les tableaux', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it('refuse les valeurs non JSON', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
    expect(() => canonicalJson(new Date())).toThrow(TypeError);
  });

  it('JSONL : une ligne par enregistrement, \\n final, vide si aucun', () => {
    expect(toJsonl([{ b: 2, a: 1 }, { c: 3 }])).toBe('{"a":1,"b":2}\n{"c":3}\n');
    expect(toJsonl([])).toBe('');
  });
});

describe('buildArchiveFiles', () => {
  it('reproduit le vecteur pos-archive/v1 (format figé)', async () => {
    const built = await build();
    expect(built.manifestSha256).toBe(vector.expected.manifest_sha256);
    for (const f of built.manifest.files) {
      expect(f.sha256).toBe(vector.expected.files[f.name as keyof typeof vector.expected.files]);
    }
    expect(await sha256HexAsync(decoder.decode(built.files['manifest.json']))).toBe(
      built.manifestSha256,
    );
  });

  it('manifeste : période canonique, bornes de tickets, têtes de chaîne, archive précédente', async () => {
    const { manifest } = await build();
    expect(manifest).toMatchObject({
      format: 'pos-archive/v1',
      register_code: 'CHAUMONT-01',
      period_start: '2026-07-31T22:00:00.000Z',
      period_end: '2026-08-31T22:00:00.000Z',
      generated_at: GENERATED_AT,
      first_ticket_number: 41,
      last_ticket_number: 43,
      chain_heads: { anchor_ticket_number: 40, last_ticket_number: 43, last_closing_number: 91 },
      previous_archive: {
        hash: data.previous_archive!.hash,
        manifest_sha256: data.previous_archive!.manifest_sha256,
      },
    });
    expect(Object.keys(manifest.previous_archive!).sort()).toEqual(['hash', 'manifest_sha256']);
    expect(manifest.files.map((f) => [f.name, f.records])).toEqual([
      ['transactions.jsonl', 3],
      ['events.jsonl', 3],
      ['closings.jsonl', 2],
    ]);
  });

  it('est déterministe (y compris si l’entrée est désordonnée)', async () => {
    const a = await build();
    const shuffled = clone(data);
    (shuffled.transactions as ArchiveRecord[]).reverse();
    (shuffled.events as ArchiveRecord[]).reverse();
    const b = await build(shuffled);
    expect(b.manifestSha256).toBe(a.manifestSha256);
    for (const name of Object.keys(a.files)) expect(b.files[name]).toEqual(a.files[name]);
  });

  it('archive vide : fichiers vides, bornes de tickets nulles, archive vérifiable', async () => {
    const empty: ArchiveData = {
      ...clone(data),
      transactions: [],
      events: [],
      closings: [],
      chain_heads: { anchor_ticket_number: 43, anchor_ticket_hash: 'ab'.repeat(32) },
      previous_archive: null,
    };
    const built = await build(empty);
    expect(built.manifest.first_ticket_number).toBeNull();
    expect(built.manifest.previous_archive).toBeNull();
    for (const name of ARCHIVE_DATA_FILES) expect(built.files[name]).toHaveLength(0);
    expect(await verifyArchive(built.files)).toMatchObject({ ok: true, errors: [] });
  });
});

describe('verifyArchive', () => {
  it('aller-retour build → verify : OK', async () => {
    const built = await build();
    const result = await verifyArchive(built.files);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.manifestSha256).toBe(built.manifestSha256);
    expect(result.warnings).toEqual([]);
  });

  it('accepte des chaînes comme contenu de fichier', async () => {
    const built = await build();
    const asText = Object.fromEntries(
      Object.entries(built.files).map(([k, v]) => [k, decoder.decode(v)]),
    );
    expect((await verifyArchive(asText)).ok).toBe(true);
  });

  it('détecte un fichier modifié (hash, taille)', async () => {
    const built = await build();
    const files = await tamper(built.files, 'transactions.jsonl', (t) =>
      t.replace('"total_ttc_cents":2490', '"total_ttc_cents":2400'),
    );
    const result = await verifyArchive(files);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('transactions.jsonl : SHA-256'))).toBe(true);
  });

  it('détecte un manifeste modifié', async () => {
    const built = await build();
    const manifest = JSON.parse(decoder.decode(built.files['manifest.json'])) as Record<
      string,
      unknown
    >;
    manifest['last_ticket_number'] = 44;
    const files = { ...built.files, 'manifest.json': encoder.encode(canonicalJson(manifest)) };
    const result = await verifyArchive(files);
    expect(result.ok).toBe(false);
    expect(result.manifestSha256).not.toBe(built.manifestSha256);
    expect(result.errors.some((e) => e.includes('last_ticket_number'))).toBe(true);
  });

  it('détecte un manifeste non canonique, absent ou un fichier non listé', async () => {
    const built = await build();
    const pretty = JSON.stringify(
      JSON.parse(decoder.decode(built.files['manifest.json'])),
      null,
      2,
    );
    expect(
      (await verifyArchive({ ...built.files, 'manifest.json': pretty })).errors,
    ).toContainEqual(expect.stringContaining('non canonique'));
    const { 'manifest.json': _m, ...withoutManifest } = built.files;
    expect((await verifyArchive(withoutManifest)).errors).toEqual(['manifest.json absent']);
    expect((await verifyArchive({ ...built.files, 'extra.txt': 'x' })).errors).toContainEqual(
      expect.stringContaining('extra.txt'),
    );
  });

  it('détecte une chaîne de tickets rompue malgré un manifeste recalculé', async () => {
    const built = await build();
    const files = await tamper(
      built.files,
      'transactions.jsonl',
      (t) =>
        editRecords(t, (records) => {
          const line = (records[1]!['lines'] as ArchiveRecord[])[0]!;
          line['label'] = 'Stylo bille';
        }),
      true,
    );
    const result = await verifyArchive(files);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('ticket 42 : HASH_MISMATCH'));
    expect(result.errors.some((e) => e.includes('SHA-256'))).toBe(false);
  });

  it('détecte un ticket supprimé (partition non contiguë)', async () => {
    const built = await build();
    const files = await tamper(
      built.files,
      'transactions.jsonl',
      (t) => editRecords(t, (records) => records.splice(1, 1)),
      true,
    );
    const result = await verifyArchive(files);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('TICKET_GAP'));
  });

  it('détecte une ancre de chaîne incohérente avec le premier ticket', async () => {
    const input = clone(data);
    input.chain_heads = { ...input.chain_heads, anchor_ticket_hash: 'cd'.repeat(32) };
    const result = await verifyArchive((await build(input)).files);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(expect.stringContaining('anchor_ticket_hash'));
  });

  it('détecte une rupture de liaison du JET et des clôtures', async () => {
    const built = await build();
    let files = await tamper(
      built.files,
      'events.jsonl',
      (t) => editRecords(t, (records) => (records[2]!['prev_hash'] = 'ef'.repeat(32))),
      true,
    );
    files = await tamper(
      files,
      'closings.jsonl',
      (t) => editRecords(t, (records) => (records[1]!['closing_number'] = 93)),
      true,
    );
    const result = await verifyArchive(files);
    expect(result.errors).toContainEqual(expect.stringContaining('événement 1003 : prev_hash'));
    expect(result.errors).toContainEqual(expect.stringContaining('numérotation discontinue'));
  });
});

describe('miroir Deno supabase/functions/_shared/archive.ts', () => {
  it('produit exactement les mêmes fichiers et le même manifest_sha256', async () => {
    const mirrorUrl = new URL('../../../supabase/functions/_shared/archive.ts', import.meta.url);
    const mirror = (await import(/* @vite-ignore */ mirrorUrl.pathname)) as {
      buildArchiveFiles: typeof buildArchiveFiles;
    };
    const fromMirror = await mirror.buildArchiveFiles(data, { generatedAt: GENERATED_AT });
    const fromCore = await build();
    expect(fromMirror.manifestSha256).toBe(vector.expected.manifest_sha256);
    expect(fromMirror.manifest).toEqual(fromCore.manifest);
    expect(Object.keys(fromMirror.files).sort()).toEqual(Object.keys(fromCore.files).sort());
    for (const name of Object.keys(fromCore.files)) {
      expect(fromMirror.files[name]).toEqual(fromCore.files[name]);
    }
  });
});
