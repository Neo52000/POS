/**
 * Audit d'intégrité d'une ou plusieurs caisses (NF525 — inaltérabilité) :
 * - tickets : chaîne recalculée hors base avec @pos/core (miroir de pos_canonical_txn) ET
 *   `pos_verify_chain` côté SQL ;
 * - JET : `pos_verify_events_chain` ;
 * - clôtures : `pos_verify_closings_chain` ;
 * - archives : `pos_verify_archives_chain`.
 * Code de sortie 0 si tout est OK, 1 sinon (2 : usage / configuration).
 *
 * Usage : SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm verify-chain [CODE_CAISSE]
 * (sans code : toutes les caisses actives).
 */
import { createClient } from '@supabase/supabase-js';
import { archivedTransactionToChained, verifyChain } from '../packages/core/src/index.ts';
import type { ArchiveRecord, ChainedTxn } from '../packages/core/src/index.ts';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis');
  process.exit(2);
}
const registerCode = process.argv[2];
const db = createClient(url, key, { auth: { persistSession: false } });

const PAGE = 1000;

interface Register {
  id: string;
  code: string;
}

interface CheckRow {
  register: string;
  check: string;
  ok: boolean;
  checked: number | null;
  detail: string;
}

async function loadRegisters(): Promise<Register[]> {
  let query = db.from('pos_registers').select('id, code').order('code');
  query = registerCode ? query.eq('code', registerCode) : query.eq('is_active', true);
  const { data, error } = await query;
  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(registerCode ? `Caisse ${registerCode} introuvable` : 'Aucune caisse active');
  }
  return data as Register[];
}

/** Tous les tickets de la caisse (pagination : PostgREST plafonne à 1000 lignes par requête). */
async function loadChain(reg: Register): Promise<ChainedTxn[]> {
  const out: ChainedTxn[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('pos_transactions')
      .select('*, pos_transaction_lines(*), pos_payments(*)')
      .eq('register_id', reg.id)
      .order('ticket_number', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const t of (data ?? []) as ArchiveRecord[]) {
      const row = { ...t, lines: t['pos_transaction_lines'], payments: t['pos_payments'] };
      out.push(archivedTransactionToChained(row, reg.code));
    }
    if (!data || data.length < PAGE) return out;
  }
}

/** Appelle une RPC `RETURNS TABLE(ok, checked, …)` et la résume. */
async function sqlCheck(reg: Register, check: string, fn: string): Promise<CheckRow> {
  const { data, error } = await db.rpc(fn, { p_register_id: reg.id });
  if (error) {
    return {
      register: reg.code,
      check,
      ok: false,
      checked: null,
      detail: `erreur ${error.message}`,
    };
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  const ok = row?.['ok'] === true;
  const detail = ok
    ? ''
    : Object.entries(row ?? {})
        .filter(([k, v]) => k !== 'ok' && k !== 'checked' && v !== null)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
  return {
    register: reg.code,
    check,
    ok,
    checked: typeof row?.['checked'] === 'number' ? row['checked'] : null,
    detail,
  };
}

async function checkRegister(reg: Register): Promise<CheckRow[]> {
  const chain = await loadChain(reg);
  const local = verifyChain(chain);
  const rows: CheckRow[] = [
    {
      register: reg.code,
      check: 'tickets (@pos/core)',
      ok: local.ok,
      checked: chain.length,
      detail: local.ok
        ? ''
        : `ticket ${local.first_break.ticket_number} ${local.first_break.reason}`,
    },
  ];
  rows.push(await sqlCheck(reg, 'tickets (pos_verify_chain)', 'pos_verify_chain'));
  rows.push(await sqlCheck(reg, 'JET (pos_verify_events_chain)', 'pos_verify_events_chain'));
  rows.push(
    await sqlCheck(reg, 'clôtures (pos_verify_closings_chain)', 'pos_verify_closings_chain'),
  );
  rows.push(
    await sqlCheck(reg, 'archives (pos_verify_archives_chain)', 'pos_verify_archives_chain'),
  );
  return rows;
}

function printTable(rows: CheckRow[]): void {
  const cells = rows.map((r) => [
    r.register,
    r.check,
    r.ok ? 'OK' : 'RUPTURE',
    r.checked === null ? '-' : String(r.checked),
    r.detail,
  ]);
  const header = ['Caisse', 'Contrôle', 'Statut', 'Vérifiés', 'Détail'];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => (c[i] ?? '').length)));
  const line = (c: string[]) =>
    c
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  console.log(line(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const c of cells) console.log(line(c));
}

async function main(): Promise<void> {
  const rows: CheckRow[] = [];
  for (const reg of await loadRegisters()) rows.push(...(await checkRegister(reg)));
  printTable(rows);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(failed === 0 ? '\nTout est intègre.' : `\n${failed} contrôle(s) en échec.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
