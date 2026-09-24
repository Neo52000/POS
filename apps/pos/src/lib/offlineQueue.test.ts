import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutPayload } from '@pos/core';

const checkoutMock = vi.fn();

vi.mock('@/lib/edge', () => ({
  edge: { checkout: (p: unknown) => checkoutMock(p) },
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 't', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      }),
      refreshSession: async () => ({ data: { session: { access_token: 't2' } }, error: null }),
    },
    rpc: vi.fn(async () => ({ data: null, error: null })),
    from: () => ({ select: async () => ({ data: [], error: null }) }),
  },
  rpc: vi.fn(),
}));

import { ApiError } from './apiError';
import { clearDb, db, setMeta } from './db';
import {
  evaluateOfflineLimits,
  nextProvisionalRef,
  queueOfflineSale,
  queueStats,
  replayQueue,
} from './offlineQueue';
import { markOffline, markOnline, resetConnectivityForTests } from './connectivity';
import { logEvent, replayEvents } from './events';
import { supabase } from '@/lib/supabase';
import type { ProvisionalTicketContext } from './ticket';
import { useUiStore } from '@/stores/uiStore';

const CTX: ProvisionalTicketContext = {
  register_code: 'TEST-01',
  cashier_name: 'vendeur',
  settings: null,
};

let seq = 0;
function payload(overrides: Partial<CheckoutPayload> = {}): CheckoutPayload {
  seq += 1;
  return {
    client_txn_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    register_id: '11111111-1111-4111-8111-111111111111',
    session_id: '55555555-5555-4555-8555-000000000001',
    kind: 'sale',
    business_at: new Date().toISOString(),
    offline_queued: false,
    invoice_requested: false,
    lines: [
      {
        line_no: 1,
        label: 'Stylo',
        qty: 2,
        unit_price_ttc_cents: 120,
        vat_rate: 20,
        discount_percent: 0,
      },
    ],
    payments: [{ method: 'cash', amount_cents: 240 }],
    change_cents: 0,
    totals: { total_ht_cents: 200, total_vat_cents: 40, total_ttc_cents: 240 },
    app_version: 'test',
    ...overrides,
  };
}

function okResult(p: CheckoutPayload, n: number, replay = false) {
  const code = `T-2026-${String(n).padStart(6, '0')}`;
  return {
    transaction: { id: `f0000000-0000-4000-8000-${String(n).padStart(12, '0')}` },
    lines: [],
    payments: [],
    ticket: { ticket_code: code, client_txn_id: p.client_txn_id },
    idempotent_replay: replay,
  };
}

async function queueN(n: number): Promise<CheckoutPayload[]> {
  const out: CheckoutPayload[] = [];
  for (let i = 0; i < n; i++) {
    const r = await queueOfflineSale(payload(), CTX);
    out.push(r.item.payload);
  }
  return out;
}

describe('offlineQueue', () => {
  beforeEach(async () => {
    await clearDb();
    checkoutMock.mockReset();
    resetConnectivityForTests();
    useUiStore.getState().setReplayBlock(null);
  });

  it('référence provisoire OFF-<caisse>-<YYYYMMDD>-<nnn>, remise à 1 chaque jour (Europe/Paris)', async () => {
    const d1 = new Date('2026-09-24T10:00:00.000Z');
    expect(await nextProvisionalRef('TEST-01', d1)).toBe('OFF-TEST-01-20260924-001');
    expect(await nextProvisionalRef('TEST-01', d1)).toBe('OFF-TEST-01-20260924-002');
    // 22:30 UTC = 00:30 le 25 à Paris : nouveau jour.
    const d2 = new Date('2026-09-24T22:30:00.000Z');
    expect(await nextProvisionalRef('TEST-01', d2)).toBe('OFF-TEST-01-20260925-001');
    expect(await nextProvisionalRef('TEST-01', d2)).toMatch(/^OFF-TEST-01-\d{8}-\d{3}$/);
  });

  it('mise en file : offline_queued, provisional_ref, business_at inchangé, ticket provisoire', async () => {
    const p = payload({ business_at: '2026-09-24T09:15:00.000Z' });
    const r = await queueOfflineSale(p, CTX);
    expect(r.provisionalRef).toMatch(/^OFF-TEST-01-20260924-\d{3}$/);
    expect(r.item.payload).toMatchObject({
      client_txn_id: p.client_txn_id,
      offline_queued: true,
      provisional_ref: r.provisionalRef,
      business_at: '2026-09-24T09:15:00.000Z',
    });
    expect(r.ticket).toMatchObject({
      ticket_number: null,
      ticket_code: r.provisionalRef,
      total_ttc_cents: 240,
      compliance: { provisional: true },
    });
    // Idempotent par client_txn_id.
    const again = await queueOfflineSale(p, CTX);
    expect(again.provisionalRef).toBe(r.provisionalRef);
    expect(await db.queue.count()).toBe(1);
    expect(await db.receipts.where('transaction_id').equals(p.client_txn_id).count()).toBe(1);
  });

  it('limites : nombre maximal et ancienneté', async () => {
    const limits = { offline_max_txns: 50, offline_max_hours: 24 };
    const now = new Date('2026-09-24T12:00:00.000Z');
    expect(
      evaluateOfflineLimits({ pending: 49, oldestBusinessAt: null }, limits, now).blocked,
    ).toBe(false);
    expect(
      evaluateOfflineLimits({ pending: 50, oldestBusinessAt: null }, limits, now),
    ).toMatchObject({ blocked: true, reason: 'max_txns' });
    expect(
      evaluateOfflineLimits(
        { pending: 1, oldestBusinessAt: '2026-09-23T11:00:00.000Z' },
        limits,
        now,
      ),
    ).toMatchObject({ blocked: true, reason: 'max_hours' });

    // Réglages serveur en cache (pos_client_settings) : 2 ventes max.
    await setMeta('client_settings', { offline_max_txns: 2, offline_max_hours: 24 });
    await queueN(2);
    await expect(queueOfflineSale(payload(), CTX)).rejects.toMatchObject({
      code: 'OFFLINE_LIMIT_REACHED',
    });
    // CB déjà débitée : la vente est tracée malgré la limite.
    const forced = await queueOfflineSale(payload(), CTX, { force: true });
    expect(forced.item.status).toBe('pending');
    expect((await queueStats()).pending).toBe(3);
  });

  it('rejeu FIFO, idempotent, ticket définitif mémorisé', async () => {
    const queued = await queueN(3);
    let n = 0;
    checkoutMock.mockImplementation(async (p: CheckoutPayload) => {
      n += 1;
      return okResult(p, n, n === 2);
    });
    const report = await replayQueue();
    expect(report).toMatchObject({ attempted: 3, done: 3, failed: 0, stopped: null });
    expect(checkoutMock.mock.calls.map((c) => (c[0] as CheckoutPayload).client_txn_id)).toEqual(
      queued.map((p) => p.client_txn_id),
    );
    // Payload rejoué tel quel (même client_txn_id, offline_queued, business_at).
    expect(checkoutMock.mock.calls[0]?.[0]).toEqual(queued[0]);
    const items = await db.queue.orderBy('local_seq').toArray();
    expect(items.map((i) => i.status)).toEqual(['done', 'done', 'done']);
    expect(items.map((i) => i.server_ticket_code)).toEqual([
      'T-2026-000001',
      'T-2026-000002',
      'T-2026-000003',
    ]);
    // Le reçu provisoire est remplacé par le ticket définitif.
    expect(await db.receipts.where('ticket_code').equals('T-2026-000001').count()).toBe(1);
    expect(await queueStats()).toMatchObject({ pending: 0, failed: 0, done: 3 });
  });

  it('un élément en échec ne bloque pas les suivants', async () => {
    await queueN(3);
    let n = 0;
    checkoutMock.mockImplementation(async (p: CheckoutPayload) => {
      n += 1;
      if (n === 2) throw new ApiError('TOTALS_MISMATCH', 'TOTALS_MISMATCH', null, 422);
      return okResult(p, n);
    });
    const report = await replayQueue();
    expect(report).toMatchObject({ attempted: 3, done: 2, failed: 1, stopped: null });
    const items = await db.queue.orderBy('local_seq').toArray();
    expect(items.map((i) => i.status)).toEqual(['done', 'failed', 'done']);
    expect(items[1]).toMatchObject({ last_error_code: 'TOTALS_MISMATCH', attempts: 1 });

    // « Rejouer » l'élément en échec.
    checkoutMock.mockImplementation(async (p: CheckoutPayload) => okResult(p, 9));
    const retry = await replayQueue({ retry: items[1]?.client_txn_id });
    expect(retry).toMatchObject({ done: 1, failed: 0 });
    expect((await db.queue.get(items[1]?.local_seq ?? 0))?.status).toBe('done');
  });

  it('une erreur réseau arrête le rejeu (retentera plus tard) et passe hors ligne', async () => {
    await queueN(3);
    let n = 0;
    checkoutMock.mockImplementation(async (p: CheckoutPayload) => {
      n += 1;
      if (n === 2) throw new ApiError('NETWORK');
      return okResult(p, n);
    });
    const report = await replayQueue();
    expect(report).toMatchObject({ attempted: 2, done: 1, stopped: 'network' });
    expect(checkoutMock).toHaveBeenCalledTimes(2);
    const items = await db.queue.orderBy('local_seq').toArray();
    expect(items.map((i) => i.status)).toEqual(['done', 'pending', 'pending']);
    expect(items[2]?.attempts).toBe(0);
    expect(useUiStore.getState().connectivity).toBe('offline');
  });

  it('SESSION_NOT_OPEN : la vente reste en attente et le rejeu signale « session à ouvrir »', async () => {
    await queueN(2);
    checkoutMock.mockRejectedValue(new ApiError('SESSION_NOT_OPEN', 'SESSION_NOT_OPEN', null, 409));
    const report = await replayQueue();
    expect(report).toMatchObject({ attempted: 1, stopped: 'session_not_open' });
    const items = await db.queue.orderBy('local_seq').toArray();
    expect(items.map((i) => i.status)).toEqual(['pending', 'pending']);
    expect(items[0]?.last_error_code).toBe('SESSION_NOT_OPEN');
    expect(useUiStore.getState().replayBlock).toBe('session_not_open');

    // Session ouverte : le rejeu reprend.
    let n = 0;
    checkoutMock.mockReset();
    checkoutMock.mockImplementation(async (p: CheckoutPayload) => okResult(p, ++n));
    expect(await replayQueue()).toMatchObject({ done: 2, stopped: null });
    expect(useUiStore.getState().replayBlock).toBeNull();
  });

  it('événements JET hors ligne : mis en file puis rejoués en FIFO avec leur client_at', async () => {
    const rpcMock = vi.mocked(supabase.rpc);
    rpcMock.mockClear();
    markOffline('test', '2026-09-24T08:00:00.000Z');
    await logEvent('offline_enter', { reason: 'test' }, { clientAt: '2026-09-24T08:00:00.000Z' });
    await logEvent('drawer_opened', { reason: 'rendu' });
    expect(rpcMock).not.toHaveBeenCalled();
    expect(await db.events.count()).toBe(2);

    markOnline('test');
    const r = await replayEvents();
    expect(r).toMatchObject({ sent: 2, failed: 0, stoppedByNetwork: false });
    const calls = rpcMock.mock.calls.map((c) => c[1] as Record<string, unknown>);
    expect(calls.map((c) => c['p_event_type'])).toEqual(['offline_enter', 'drawer_opened']);
    expect(calls[0]?.['p_client_at']).toBe('2026-09-24T08:00:00.000Z');
    expect(await db.events.count()).toBe(0);
  });
});
