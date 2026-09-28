import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReportFigures, VatBreakdownEntry } from '@pos/core';
import type { PosClosing, PosSession, TransactionFull } from '@/types/pos';
import { MOCK_REGISTER, MOCK_SETTINGS, MOCK_USER } from './mockData';
import { isMockOffline } from './mockNetwork';
import { mockSave, mockState } from './mockStore';

/** Échec réseau tel que renvoyé par supabase-js (pas d'exception, `error.message` du `fetch`). */
const NETWORK_ERROR = { message: 'TypeError: Failed to fetch (mock hors ligne)', code: '' };

type Result<T> =
  { data: T; error: null } | { data: null; error: { message: string; code?: string } };

function ok<T>(data: T): Result<T> {
  return { data, error: null };
}
function fail(message: string): Result<never> {
  return { data: null, error: { message } };
}

type AuthListener = (event: string, session: MockAuthSession | null) => void;

interface MockAuthSession {
  access_token: string;
  user: { id: string; email: string };
}

const listeners = new Set<AuthListener>();

function currentSession(): MockAuthSession | null {
  const u = mockState().user;
  return u ? { access_token: 'mock-token', user: u } : null;
}

const auth = {
  async getSession() {
    return { data: { session: currentSession() }, error: null };
  },
  async getUser() {
    const s = currentSession();
    return { data: { user: s?.user ?? null }, error: null };
  },
  async signInWithPassword({ email, password }: { email: string; password: string }) {
    if (!email || !password)
      return { data: { session: null, user: null }, error: { message: 'Identifiants requis' } };
    if (password === 'wrong') {
      return {
        data: { session: null, user: null },
        error: { message: 'Invalid login credentials' },
      };
    }
    mockState().user = { id: MOCK_USER.id, email };
    mockSave();
    const s = currentSession();
    for (const l of listeners) l('SIGNED_IN', s);
    return { data: { session: s, user: s?.user ?? null }, error: null };
  },
  async refreshSession() {
    if (isMockOffline()) return { data: { session: null, user: null }, error: NETWORK_ERROR };
    const s = currentSession();
    return { data: { session: s, user: s?.user ?? null }, error: null };
  },
  async signOut() {
    mockState().user = null;
    mockSave();
    for (const l of listeners) l('SIGNED_OUT', null);
    return { error: null };
  },
  onAuthStateChange(cb: AuthListener) {
    listeners.add(cb);
    return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
  },
};

function paymentsBreakdown(txns: TransactionFull[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of txns) {
    for (const p of t.payments) out[p.method] = (out[p.method] ?? 0) + Number(p.amount_cents);
    if (t.transaction.change_cents)
      out['cash'] = (out['cash'] ?? 0) - Number(t.transaction.change_cents);
  }
  return out;
}

/** Agrégats d'une liste de tickets, au format SQL (`payments_breakdown` = `[{method, amount_cents, count}]`). */
function aggregate(txns: TransactionFull[]): ReportFigures {
  const vat = new Map<string, VatBreakdownEntry>();
  const pay = new Map<string, { method: string; amount_cents: number; count: number }>();
  for (const t of txns) {
    for (const v of t.transaction.vat_breakdown ?? []) {
      const rate = Number(v.rate).toFixed(2);
      const acc = vat.get(rate) ?? { rate, base_ht_cents: 0, vat_cents: 0, ttc_cents: 0 };
      acc.base_ht_cents += Number(v.base_ht_cents);
      acc.vat_cents += Number(v.vat_cents);
      acc.ttc_cents += Number(v.ttc_cents);
      vat.set(rate, acc);
    }
    for (const p of t.payments) {
      const acc = pay.get(p.method) ?? { method: p.method, amount_cents: 0, count: 0 };
      acc.amount_cents += Number(p.amount_cents);
      acc.count += 1;
      pay.set(p.method, acc);
    }
  }
  const numbers = txns.map((t) => t.transaction.ticket_number ?? 0);
  const sum = (f: (t: TransactionFull) => number, list = txns): number =>
    list.reduce((s, t) => s + f(t), 0);
  const refunds = txns.filter((t) => t.transaction.kind === 'refund');
  return {
    txn_count: txns.length,
    sales_count: txns.length - refunds.length,
    refunds_count: refunds.length,
    first_ticket_number: numbers.length ? Math.min(...numbers) : null,
    last_ticket_number: numbers.length ? Math.max(...numbers) : null,
    total_ht_cents: sum((t) => t.transaction.total_ht_cents),
    total_vat_cents: sum((t) => t.transaction.total_vat_cents),
    total_ttc_cents: sum((t) => t.transaction.total_ttc_cents),
    refunds_ttc_cents: sum((t) => t.transaction.total_ttc_cents, refunds),
    change_cents: sum((t) => Number(t.transaction.change_cents ?? 0)),
    vat_breakdown: [...vat.values()].sort((a, b) => Number(a.rate) - Number(b.rate)),
    payments: [...pay.values()].sort((a, b) => a.method.localeCompare(b.method)),
  };
}

/** Grand total perpétuel du dernier Z1 de la caisse. */
function lastDailyGrandTotal(): number {
  const dailies = mockState().closings.filter((c) => c.period_type === 'daily');
  return dailies.at(-1)?.grand_total_perpetual_cents ?? 0;
}

async function rpc(name: string, params: Record<string, unknown> = {}): Promise<Result<unknown>> {
  if (isMockOffline()) return { data: null, error: NETWORK_ERROR };
  const st = mockState();
  switch (name) {
    case 'is_pos':
      return ok(true);
    case 'is_pos_admin':
      return ok(true);
    case 'pos_client_settings':
      return ok({
        offline_max_txns: 50,
        offline_max_hours: 24,
        clock_tolerance: { online_minutes: 10, offline_hours: 72, future_minutes: 5 },
        server_now: new Date().toISOString(),
      });
    case 'pos_open_session': {
      if (st.session?.status === 'open') return fail('SESSION_ALREADY_OPEN');
      st.sessionCounter += 1;
      const session: PosSession = {
        id: `55555555-5555-4555-8555-${String(st.sessionCounter).padStart(12, '0')}`,
        register_id: String(params['p_register_id']),
        session_number: st.sessionCounter,
        opened_by: st.user?.id ?? null,
        opened_at: new Date().toISOString(),
        opening_float_cents: Number(params['p_opening_float_cents'] ?? 0),
        closed_by: null,
        closed_at: null,
        counted_cash_cents: null,
        expected_cash_cents: null,
        variance_cents: null,
        closing_id: null,
        notes: null,
        status: 'open',
      };
      st.session = session;
      mockSave();
      return ok(session);
    }
    case 'pos_close_session': {
      const session = st.session;
      if (!session || session.status !== 'open' || session.id !== params['p_session_id']) {
        return fail('SESSION_NOT_OPEN');
      }
      const txns = st.transactions.filter((t) => t.transaction.session_id === session.id);
      const breakdown = paymentsBreakdown(txns);
      const expected = session.opening_float_cents + (breakdown['cash'] ?? 0);
      const counted = Number(params['p_counted_cash_cents'] ?? 0);
      const closed: PosSession = {
        ...session,
        status: 'closed',
        closed_at: new Date().toISOString(),
        closed_by: st.user?.id ?? null,
        counted_cash_cents: counted,
        expected_cash_cents: expected,
        variance_cents: counted - expected,
        notes: params['p_notes'] ? String(params['p_notes']) : null,
        closing_id: '66666666-6666-4666-8666-666666666666',
      };
      const f = aggregate(txns);
      const number = st.closings.length + 1;
      const closing: PosClosing = {
        id: `66666666-6666-4666-8666-${String(number).padStart(12, '0')}`,
        register_id: session.register_id,
        closing_number: number,
        period_type: 'daily',
        period_start: session.opened_at,
        period_end: closed.closed_at ?? '',
        session_id: session.id,
        txn_count: f.txn_count,
        first_ticket_number: f.first_ticket_number,
        last_ticket_number: f.last_ticket_number,
        total_ht_cents: f.total_ht_cents,
        total_vat_cents: f.total_vat_cents,
        total_ttc_cents: f.total_ttc_cents,
        vat_breakdown: f.vat_breakdown,
        payments_breakdown: f.payments,
        refunds_ttc_cents: f.refunds_ttc_cents,
        grand_total_perpetual_cents: lastDailyGrandTotal() + f.total_ttc_cents,
        hash: `${String(number).padStart(4, '0')}mockhashmockhashmockhash`,
        created_at: new Date().toISOString(),
      };
      closed.closing_id = closing.id;
      st.closings.push(closing);
      st.session = closed;
      mockSave();
      return ok({ session: closed, closing });
    }
    case 'pos_x_report': {
      const session = st.session;
      if (!session || session.status !== 'open' || session.id !== params['p_session_id']) {
        return fail('SESSION_NOT_OPEN');
      }
      const txns = st.transactions.filter((t) => t.transaction.session_id === session.id);
      const f = aggregate(txns);
      const cashIn = f.payments.find((p) => p.method === 'cash')?.amount_cents ?? 0;
      st.events.push({
        type: 'x_report',
        payload: { session_id: session.id, txn_count: f.txn_count },
        at: new Date().toISOString(),
      });
      mockSave();
      return ok({
        x_number: st.events.length,
        generated_at: new Date().toISOString(),
        register_code: MOCK_REGISTER.code,
        session,
        figures: {
          ...f,
          cash: {
            opening_float_cents: session.opening_float_cents,
            expected_cash_cents: session.opening_float_cents + cashIn - (f.change_cents ?? 0),
          },
          grand_total_perpetual_cents: lastDailyGrandTotal() + f.total_ttc_cents,
        },
      });
    }
    case 'pos_log_event': {
      st.events.push({
        type: String(params['p_event_type']),
        payload: params['p_payload'],
        at: new Date().toISOString(),
        client_at: params['p_client_at'] ? String(params['p_client_at']) : null,
      });
      mockSave();
      return ok(st.events.length);
    }
    case 'pos_today_transactions': {
      const date = String(params['p_date'] ?? '');
      return ok(
        st.transactions
          .filter((t) => t.transaction.business_date === date)
          .map((t) => t.transaction)
          .sort((a, b) => (b.ticket_number ?? 0) - (a.ticket_number ?? 0)),
      );
    }
    case 'pos_transaction_full': {
      const full = st.transactions.find((t) => t.transaction.id === params['p_transaction_id']);
      return full ? ok(full) : fail('NOT_FOUND');
    }
    default:
      return fail(`RPC mock inconnue : ${name}`);
  }
}

/** Mini query builder pour `from(table).select().eq().order().maybeSingle()`. */
function from(table: string) {
  const filters: Array<[string, unknown]> = [];
  let single = false;
  let limitN: number | null = null;

  const run = (): Result<unknown> => {
    let rows: Array<Record<string, unknown>>;
    if (table === 'pos_registers') rows = [MOCK_REGISTER as unknown as Record<string, unknown>];
    else if (table === 'pos_sessions')
      rows = mockState().session ? [mockState().session as unknown as Record<string, unknown>] : [];
    else if (table === 'pos_settings')
      rows = Object.entries(MOCK_SETTINGS).map(([key, value]) => ({ key, value }));
    else if (table === 'pos_closings')
      rows = [...mockState().closings]
        .sort((a, b) => b.closing_number - a.closing_number)
        .map((c) => ({ ...c }) as unknown as Record<string, unknown>);
    else if (table === 'pos_archives')
      rows = [...mockState().archives]
        .sort((a, b) => b.period_start.localeCompare(a.period_start))
        .map((a) => ({ ...a }) as unknown as Record<string, unknown>);
    else return fail(`table mock inconnue : ${table}`);
    for (const [k, v] of filters) rows = rows.filter((r) => r[k] === v);
    if (limitN != null) rows = rows.slice(0, limitN);
    if (single) return ok(rows[0] ?? null);
    return ok(rows);
  };

  const builder = {
    select: () => builder,
    eq: (k: string, v: unknown) => {
      filters.push([k, v]);
      return builder;
    },
    order: () => builder,
    limit: (n: number) => {
      limitN = n;
      return builder;
    },
    maybeSingle: () => {
      single = true;
      return builder;
    },
    single: () => {
      single = true;
      return builder;
    },
    then: <R>(resolve: (v: Result<unknown>) => R) =>
      Promise.resolve<Result<unknown>>(
        isMockOffline() ? { data: null, error: NETWORK_ERROR } : run(),
      ).then(resolve),
  };
  return builder;
}

/** Stockage : URL signée factice pour les archives (lot 5). */
const storage = {
  from(bucket: string) {
    return {
      async createSignedUrl(path: string, expiresIn: number) {
        if (isMockOffline()) return { data: null, error: NETWORK_ERROR };
        const archive = mockState().archives.find((a) => a.storage_path === path);
        if (bucket !== 'pos-archives' || !archive) {
          return { data: null, error: { message: 'Object not found' } };
        }
        const body = JSON.stringify({ mock: true, path, expiresIn, hash: archive.hash });
        return {
          data: { signedUrl: `data:application/json;charset=utf-8,${encodeURIComponent(body)}` },
          error: null,
        };
      },
    };
  },
};

export function createMockSupabase(): SupabaseClient {
  return { auth, rpc, from, storage } as unknown as SupabaseClient;
}
