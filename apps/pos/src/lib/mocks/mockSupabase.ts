import type { SupabaseClient } from '@supabase/supabase-js';
import type { PosClosing, PosSession, TransactionFull } from '@/types/pos';
import { MOCK_REGISTER, MOCK_SETTINGS, MOCK_USER } from './mockData';
import { mockSave, mockState } from './mockStore';

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

async function rpc(name: string, params: Record<string, unknown> = {}): Promise<Result<unknown>> {
  const st = mockState();
  switch (name) {
    case 'is_pos':
      return ok(true);
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
      const sales = txns.filter((t) => t.transaction.kind === 'sale');
      const refunds = txns.filter((t) => t.transaction.kind === 'refund');
      const numbers = txns.map((t) => t.transaction.ticket_number ?? 0);
      const closing: PosClosing = {
        id: closed.closing_id ?? '',
        register_id: session.register_id,
        closing_number: session.session_number,
        period_type: 'daily',
        period_start: session.opened_at,
        period_end: closed.closed_at ?? '',
        session_id: session.id,
        txn_count: txns.length,
        first_ticket_number: numbers.length ? Math.min(...numbers) : null,
        last_ticket_number: numbers.length ? Math.max(...numbers) : null,
        total_ht_cents: txns.reduce((s, t) => s + t.transaction.total_ht_cents, 0),
        total_vat_cents: txns.reduce((s, t) => s + t.transaction.total_vat_cents, 0),
        total_ttc_cents: txns.reduce((s, t) => s + t.transaction.total_ttc_cents, 0),
        vat_breakdown: [],
        payments_breakdown: breakdown,
        refunds_ttc_cents: refunds.reduce((s, t) => s + t.transaction.total_ttc_cents, 0),
        grand_total_perpetual_cents: sales.reduce((s, t) => s + t.transaction.total_ttc_cents, 0),
        hash: 'mockhashmockhashmockhash',
        created_at: new Date().toISOString(),
      };
      st.session = closed;
      mockSave();
      return ok({ session: closed, closing });
    }
    case 'pos_log_event': {
      st.events.push({
        type: String(params['p_event_type']),
        payload: params['p_payload'],
        at: new Date().toISOString(),
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
    then: <R>(resolve: (v: Result<unknown>) => R) => Promise.resolve(run()).then(resolve),
  };
  return builder;
}

export function createMockSupabase(): SupabaseClient {
  return { auth, rpc, from } as unknown as SupabaseClient;
}
