// =============================================================================
// pos-export-archive — archivage fiscal périodique (NF525, exigence « Archivage », lot 5).
// Cron `0 4 1 * *` UTC ({"source":"pg_cron"}, service role) ou admin POS (is_pos_admin).
// Pour chaque caisse active (ou `register_id`) et le mois demandé (défaut : mois précédent,
// Europe/Paris, bornes par pos_period_bounds) :
//   1. archive déjà enregistrée dans pos_archives → renvoyée telle quelle (already_exists) ;
//   2. pos_archive_data (partition contiguë depuis l'archive précédente) → buildArchiveFiles
//      (miroir de @pos/core) → ZIP fflate déterministe ;
//   3. dépôt Storage `pos-archives/<register_code>/<YYYY-MM>.zip` (upsert interdit) ;
//   4. pos_register_archive (chaînage : hash = SHA-256(v1|archive|…|manifest_sha256|prev_hash)).
// Une caisse dont la période n'est pas terminée (PERIOD_NOT_ENDED) est ignorée et signalée.
// =============================================================================
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { unzipSync, zipSync } from 'npm:fflate@0.8';
import { z } from 'npm:zod@3';
import {
  type ArchiveData,
  type ArchiveManifest,
  buildArchiveFiles,
  canonicalJson,
} from '../_shared/archive.ts';
import { requirePosAdmin } from '../_shared/auth.ts';
import { ApiError, errorResponse, handleOptions, json, readJson } from '../_shared/http.ts';
import { type PeriodBounds, periodBounds, previousPeriod } from '../_shared/periods.ts';

const BUCKET = 'pos-archives';
/** Date fixe des entrées ZIP : le contenu daté est dans le manifeste (`generated_at`). */
const ZIP_MTIME = '2000-01-01T12:00:00.000Z';

const Schema = z.object({
  register_id: z.string().uuid().optional(),
  // Instant quelconque du mois à archiver (ISO) ; absent : mois précédent (Europe/Paris).
  period_start: z.string().datetime({ offset: true }).optional(),
  source: z.string().max(40).optional(),
});

interface Register {
  id: string;
  code: string;
}

interface ArchiveOutput {
  register_code: string;
  period_start: string;
  period_end: string;
  storage_path: string;
  manifest_sha256: string;
  hash: string;
  already_exists: boolean;
  counts: { transactions: number; events: number; closings: number };
}

interface ArchiveRow {
  storage_path: string;
  period_start: string;
  period_end: string;
  manifest: ArchiveManifest;
  manifest_sha256: string;
  hash: string;
}

/** `YYYY-MM` du début de période en heure de Paris (le mois « métier » de l'archive). */
function parisMonth(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}`;
}

function counts(manifest: ArchiveManifest | null | undefined): ArchiveOutput['counts'] {
  const records = (name: string) => manifest?.files?.find((f) => f.name === name)?.records ?? 0;
  return {
    transactions: records('transactions.jsonl'),
    events: records('events.jsonl'),
    closings: records('closings.jsonl'),
  };
}

function toOutput(register: Register, row: ArchiveRow, alreadyExists: boolean): ArchiveOutput {
  return {
    register_code: register.code,
    period_start: new Date(row.period_start).toISOString(),
    period_end: new Date(row.period_end).toISOString(),
    storage_path: row.storage_path,
    manifest_sha256: row.manifest_sha256,
    hash: row.hash,
    already_exists: alreadyExists,
    counts: counts(row.manifest),
  };
}

function errorCode(e: unknown): string | null {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' ? m : null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadRegisters(db: SupabaseClient, registerId?: string): Promise<Register[]> {
  let query = db.from('pos_registers').select('id, code').order('code');
  query = registerId ? query.eq('id', registerId) : query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw error;
  const registers = (data ?? []) as Register[];
  if (registerId && registers.length === 0) {
    throw new ApiError('REGISTER_NOT_FOUND', 'Caisse introuvable', { register_id: registerId });
  }
  return registers;
}

async function findArchive(
  db: SupabaseClient,
  registerId: string,
  period: PeriodBounds,
): Promise<ArchiveRow | null> {
  const { data, error } = await db
    .from('pos_archives')
    .select('storage_path, period_start, period_end, manifest, manifest_sha256, hash')
    .eq('register_id', registerId)
    .eq('period_start', period.start)
    .maybeSingle();
  if (error) throw error;
  return (data as ArchiveRow | null) ?? null;
}

/**
 * Un ZIP existe déjà dans Storage sans ligne pos_archives (exécution précédente interrompue entre
 * le dépôt et l'enregistrement) : on le réutilise SEULEMENT s'il contient exactement les mêmes
 * données (manifeste identique hors `generated_at`), sinon CHAIN_INCONSISTENT (intervention humaine).
 */
async function reuseExistingZip(
  db: SupabaseClient,
  path: string,
  built: { manifest: ArchiveManifest },
): Promise<{ manifest: ArchiveManifest; manifestSha256: string }> {
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error || !data) {
    throw new ApiError('DB_ERROR', `Lecture de ${path} impossible`, error?.message);
  }
  const files = unzipSync(new Uint8Array(await data.arrayBuffer()));
  const manifestBytes = files['manifest.json'];
  if (!manifestBytes) throw new ApiError('CHAIN_INCONSISTENT', `${path} : manifest.json absent`);
  const existing = JSON.parse(new TextDecoder().decode(manifestBytes)) as ArchiveManifest;
  const same = canonicalJson({ ...existing, generated_at: '' }) ===
    canonicalJson({ ...built.manifest, generated_at: '' });
  if (!same) {
    throw new ApiError(
      'CHAIN_INCONSISTENT',
      `${path} existe déjà avec un contenu différent : vérifier avant toute action`,
      { storage_path: path },
    );
  }
  return { manifest: existing, manifestSha256: await sha256Hex(manifestBytes) };
}

async function archiveRegister(
  db: SupabaseClient,
  register: Register,
  period: PeriodBounds,
): Promise<ArchiveOutput> {
  const existing = await findArchive(db, register.id, period);
  if (existing) return toOutput(register, existing, true);

  const { data, error } = await db.rpc('pos_archive_data', {
    p_register_id: register.id,
    p_period_start: period.start,
    p_period_end: period.end,
  });
  if (error) throw error;
  const built = await buildArchiveFiles(data as ArchiveData);

  const zip = zipSync(
    Object.fromEntries(Object.keys(built.files).sort().map((name) => [name, built.files[name]])),
    { level: 9, mtime: ZIP_MTIME },
  );
  const path = `${register.code}/${parisMonth(period.start)}.zip`;
  let manifest = built.manifest;
  let manifestSha256 = built.manifestSha256;
  const upload = await db.storage.from(BUCKET).upload(path, zip, {
    contentType: 'application/zip',
    upsert: false,
  });
  if (upload.error) {
    const status = String((upload.error as { statusCode?: unknown }).statusCode ?? '');
    const duplicate = status === '409' || /exist|duplicate/i.test(upload.error.message);
    if (!duplicate) throw new ApiError('DB_ERROR', `Dépôt de ${path} : ${upload.error.message}`);
    ({ manifest, manifestSha256 } = await reuseExistingZip(db, path, built));
  }

  const reg = await db.rpc('pos_register_archive', {
    p_register_id: register.id,
    p_period_start: period.start,
    p_period_end: period.end,
    p_storage_path: path,
    p_manifest: manifest,
    p_manifest_sha256: manifestSha256,
  });
  if (reg.error) throw reg.error;
  const result = reg.data as { archive: ArchiveRow; already_exists?: boolean };
  return toOutput(register, result.archive, result.already_exists === true);
}

Deno.serve(async (req) => {
  const pre = handleOptions(req);
  if (pre) return pre;
  try {
    if (req.method !== 'POST') throw new ApiError('VALIDATION', 'POST attendu');
    const auth = await requirePosAdmin(req);
    const parsed = Schema.safeParse(await readJson(req));
    if (!parsed.success) {
      throw new ApiError('VALIDATION', 'Payload invalide', parsed.error.flatten());
    }
    const db = auth.db; // service role : pos_archive_data / pos_register_archive / Storage
    const period = parsed.data.period_start
      ? await periodBounds(db, 'monthly', parsed.data.period_start)
      : await previousPeriod(db, 'monthly');

    const archives: ArchiveOutput[] = [];
    const skipped: Array<{ register_code: string; reason: string }> = [];
    for (const register of await loadRegisters(db, parsed.data.register_id)) {
      try {
        archives.push(await archiveRegister(db, register, period));
      } catch (e) {
        if (errorCode(e) !== 'PERIOD_NOT_ENDED') throw e;
        skipped.push({ register_code: register.code, reason: 'PERIOD_NOT_ENDED' });
      }
    }
    console.log('[pos-export-archive]', {
      source: parsed.data.source ?? auth.kind,
      period,
      archived: archives.map((a) => `${a.storage_path}${a.already_exists ? ' (existante)' : ''}`),
      skipped,
    });
    return json(200, { period_start: period.start, period_end: period.end, archives, skipped });
  } catch (e) {
    return errorResponse(e);
  }
});
