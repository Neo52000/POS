/**
 * Audit d'intégrité d'une ou plusieurs caisses (NF525 — inaltérabilité) :
 * - tickets : chaîne recalculée hors base avec @pos/core (miroir de pos_canonical_txn) ET
 *   `pos_verify_chain` côté SQL ;
 * - JET : `pos_verify_events_chain` ;
 * - clôtures : chaîne recalculée hors base avec @pos/core (hash v1 et v2, têtes JET / archive
 *   relues) ET `pos_verify_closings_chain` ;
 * - archives : `pos_verify_archives_chain`.
 * Code de sortie 0 si tout est OK, 1 sinon (2 : usage / configuration).
 *
 * Usage : SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... pnpm verify-chain [CODE_CAISSE]
 * (sans code : toutes les caisses actives).
 */
import { createClient } from '@supabase/supabase-js';
import {
  archivedTransactionToChained,
  verifyChain,
  verifyClosingsChain,
} from '../packages/core/src/index.ts';
import type { ArchiveRecord, ChainedClosing, ChainedTxn } from '../packages/core/src/index.ts';

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
  /** Caisse d'essai (0.4.0) ; absent avant la migration du lot 7. */
  is_test?: boolean;
}

interface CheckRow {
  register: string;
  check: string;
  ok: boolean;
  checked: number | null;
  detail: string;
}

async function loadRegisters(): Promise<Register[]> {
  let query = db.from('pos_registers').select('*').order('code');
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

type ClosingRow = ChainedClosing & {
  jet_head_event_id: number | null;
  archive_head_id: string | null;
};

/** Toutes les clôtures de la caisse (pagination). */
async function loadClosings(reg: Register): Promise<ClosingRow[]> {
  const out: ClosingRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('pos_closings')
      .select(
        'closing_number, period_type, period_start, period_end, txn_count, total_ttc_cents, ' +
          'grand_total_perpetual_cents, prev_hash, hash, hash_version, jet_head_event_id, ' +
          'jet_head_hash, archive_head_id, archive_head_hash',
      )
      .eq('register_id', reg.id)
      .order('closing_number', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...((data ?? []) as unknown as ClosingRow[]));
    if (!data || data.length < PAGE) return out;
  }
}

/** Hash actuel des éléments référencés comme têtes (JET, archives) par les clôtures v2. */
async function loadHeads(
  reg: Register,
  closings: ClosingRow[],
): Promise<{ events: Map<number, string>; archives: Map<string, string> }> {
  const eventIds = [
    ...new Set(closings.map((c) => c.jet_head_event_id).filter((v): v is number => v != null)),
  ];
  const archiveIds = [
    ...new Set(closings.map((c) => c.archive_head_id).filter((v): v is string => v != null)),
  ];
  const events = new Map<number, string>();
  const archives = new Map<string, string>();
  for (let i = 0; i < eventIds.length; i += 200) {
    const { data, error } = await db
      .from('pos_events')
      .select('id, hash')
      .eq('register_id', reg.id)
      .in('id', eventIds.slice(i, i + 200));
    if (error) throw error;
    for (const e of (data ?? []) as { id: number; hash: string }[])
      events.set(Number(e.id), e.hash);
  }
  for (let i = 0; i < archiveIds.length; i += 200) {
    const { data, error } = await db
      .from('pos_archives')
      .select('id, hash')
      .eq('register_id', reg.id)
      .in('id', archiveIds.slice(i, i + 200));
    if (error) throw error;
    for (const a of (data ?? []) as { id: string; hash: string }[]) archives.set(a.id, a.hash);
  }
  return { events, archives };
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
  const closings = await loadClosings(reg);
  const heads = await loadHeads(reg, closings);
  const closingCheck = await verifyClosingsChain(closings, {
    eventHash: (id) => heads.events.get(id),
    archiveHash: (id) => heads.archives.get(id),
  });
  const versions = [...new Set(closings.map((c) => `v${c.hash_version ?? 1}`))].join('+');
  rows.push({
    register: reg.code,
    check: `clôtures (@pos/core ${versions || 'v1/v2'})`,
    ok: closingCheck.ok,
    checked: closingCheck.checked,
    detail: closingCheck.ok ? '' : `clôture ${closingCheck.closing_number} ${closingCheck.reason}`,
  });
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
    testCodes.has(r.register) ? `${r.register} [ESSAI]` : r.register,
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

/** Caisses d'essai (`is_test`) : signalées dans le tableau et en pied. */
const testCodes = new Set<string>();

async function main(): Promise<void> {
  const rows: CheckRow[] = [];
  for (const reg of await loadRegisters()) {
    if (reg.is_test) testCodes.add(reg.code);
    rows.push(...(await checkRegister(reg)));
  }
  printTable(rows);
  if (testCodes.size > 0) {
    console.log(
      `\n[ESSAI] caisse(s) d'essai (pos_registers.is_test) : ${[...testCodes].join(', ')} — hors exploitation.`,
    );
  }
  const failed = rows.filter((r) => !r.ok).length;
  console.log(failed === 0 ? '\nTout est intègre.' : `\n${failed} contrôle(s) en échec.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
