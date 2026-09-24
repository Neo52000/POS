/**
 * Vérifie une archive fiscale `pos-archive/v1` (ZIP produit par l'Edge `pos-export-archive`) :
 * manifeste canonique, SHA-256 / taille / nombre d'enregistrements de chaque fichier, chaîne des
 * tickets recalculée (@pos/core, SPEC §3), liaison du JET et des clôtures, têtes de chaîne.
 *
 * Usage : pnpm verify-archive <archive.zip> [--manifest-sha256 <hex>]
 *   --manifest-sha256 : empreinte attendue (colonne pos_archives.manifest_sha256).
 * Si SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont définies, l'empreinte attendue est lue dans
 * pos_archives (caisse + début de période du manifeste).
 * Code de sortie : 0 archive intègre, 1 anomalie, 2 usage / lecture impossible.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { unzipSync } from 'fflate';
import { verifyArchive } from '../packages/core/src/index.ts';
import type { ArchiveManifest } from '../packages/core/src/index.ts';

function usage(message?: string): never {
  if (message) console.error(message);
  console.error('Usage : pnpm verify-archive <archive.zip> [--manifest-sha256 <hex>]');
  process.exit(2);
}

function parseArgs(argv: string[]): { file: string; expectedSha: string | null } {
  let file: string | null = null;
  let expectedSha: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--manifest-sha256') {
      expectedSha = (argv[(i += 1)] ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(expectedSha)) usage('--manifest-sha256 : 64 caractères hex');
    } else if (arg.startsWith('-')) usage(`Option inconnue : ${arg}`);
    else if (file === null) file = arg;
    else usage(`Argument en trop : ${arg}`);
  }
  if (!file) usage();
  return { file, expectedSha };
}

/** Empreinte enregistrée en base pour (caisse, début de période), si l'accès est configuré. */
async function expectedFromDb(manifest: ArchiveManifest): Promise<string | null> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: reg, error: regErr } = await db
    .from('pos_registers')
    .select('id')
    .eq('code', manifest.register_code)
    .maybeSingle();
  if (regErr || !reg) throw new Error(`Caisse ${manifest.register_code} introuvable en base`);
  const { data, error } = await db
    .from('pos_archives')
    .select('manifest_sha256')
    .eq('register_id', reg.id)
    .eq('period_start', manifest.period_start)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new Error('Aucune archive enregistrée en base pour cette caisse et cette période');
  return String(data.manifest_sha256);
}

async function main(): Promise<void> {
  const { file, expectedSha } = parseArgs(process.argv.slice(2));
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(readFileSync(file)));
  } catch (e) {
    usage(`Lecture de ${file} impossible : ${e instanceof Error ? e.message : String(e)}`);
  }

  const result = await verifyArchive(files);
  const m = result.manifest;
  console.log(`Archive      : ${basename(file)}`);
  if (m) {
    console.log(`Caisse       : ${m.register_code}`);
    console.log(`Période      : ${m.period_start} → ${m.period_end} (fin exclusive)`);
    console.log(`Générée le   : ${m.generated_at} par ${m.software?.name} ${m.software?.version}`);
    console.log(`Tickets      : ${m.first_ticket_number ?? '-'} → ${m.last_ticket_number ?? '-'}`);
    for (const f of m.files) {
      console.log(`  ${f.name.padEnd(20)} ${String(f.records).padStart(6)} enr.  ${f.sha256}`);
    }
    console.log(`manifest_sha256 : ${result.manifestSha256}`);
  }

  const errors = [...result.errors];
  const expected = expectedSha ?? (m ? await expectedFromDb(m) : null);
  if (expected !== null) {
    if (expected === result.manifestSha256) console.log('Empreinte attendue : conforme');
    else errors.push(`manifest_sha256 ${result.manifestSha256} ≠ attendu ${expected}`);
  } else {
    console.log('Empreinte attendue : non vérifiée (comparer avec pos_archives.manifest_sha256)');
  }

  for (const w of result.warnings) console.log(`AVERTISSEMENT : ${w}`);
  if (errors.length === 0) {
    console.log('\nRÉSULTAT : archive intègre');
    process.exit(0);
  }
  for (const e of errors) console.log(`ERREUR : ${e}`);
  console.log(`\nRÉSULTAT : ${errors.length} anomalie(s)`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
