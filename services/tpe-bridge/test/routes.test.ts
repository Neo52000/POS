import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { NullPrinter } from '../src/printer/transport.js';
import { buildServer, type BridgeServer } from '../src/server.js';
import { startSimulator, type SimulatorHandle } from '../simulator/tpe-sim.js';
import { referenceTicket } from './fixtures/ticket.js';

const TOKEN = 'test-token-0123456789abcdef';
const silent = { info: () => undefined, warn: () => undefined };
const auth = { 'x-bridge-token': TOKEN };

let sim: SimulatorHandle;
let server: BridgeServer;
let printer: NullPrinter;

beforeAll(async () => {
  sim = await startSimulator({ port: 0, delayMs: 50, pendingDelayMs: 100, logger: silent });
  const config = parseConfig({
    token: TOKEN,
    allowedOrigins: ['http://localhost:5173'],
    tpe: { host: sim.host, port: sim.port, timeoutMs: 1000, simulate: true },
    printer: { type: 'none' },
  });
  printer = new NullPrinter();
  server = await buildServer({
    config,
    version: '0.1.0-test',
    logger: pino({ level: 'silent' }),
    tpeEndpoint: { host: sim.host, port: sim.port },
    printer,
  });
  await server.app.ready();
});

afterAll(async () => {
  await server.app.close();
  await sim.close();
});

describe('authentification', () => {
  it('401 sans jeton sur /payment, /print, /drawer/open', async () => {
    for (const url of ['/payment', '/print', '/print/raw', '/drawer/open', '/payment/cancel']) {
      const res = await server.app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({
        error: { code: 'UNAUTHORIZED', message: expect.any(String) },
      });
    }
  });

  it('401 avec un mauvais jeton', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/drawer/open',
      headers: { 'x-bridge-token': 'wrong' },
      payload: { reason: 'test' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('/health est accessible sans jeton', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      version: '0.1.0-test',
      tpe: { host: sim.host, port: sim.port, reachable: true },
      printer: { type: 'none', reachable: true },
      simulate: true,
      busy: false,
    });
  });
});

describe('CORS', () => {
  it('preflight depuis une origine autorisée : Access-Control-Allow-Private-Network', async () => {
    const res = await server.app.inject({
      method: 'OPTIONS',
      url: '/payment',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-bridge-token',
        'access-control-request-private-network': 'true',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-private-network']).toBe('true');
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'x-bridge-token',
    );
  });

  it('origine non listée : pas de Access-Control-Allow-Origin', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('/payment', () => {
  it('400 sur corps invalide', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/payment',
      headers: auth,
      payload: { txn_id: 'x', amount_cents: 12.5, kind: 'debit' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('paiement approuvé via le simulateur, diffusé sur WS /events', async () => {
    const ws = await server.app.injectWS(`/events?token=${TOKEN}`);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (data: unknown) =>
      messages.push(JSON.parse(String(data)) as Record<string, unknown>),
    );
    const res = await server.app.inject({
      method: 'POST',
      url: '/payment',
      headers: auth,
      payload: { txn_id: 'txn-1', amount_cents: 2500, kind: 'debit' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('approved');
    expect(body.code).toBe('10');
    expect(body.tpe_raw.AE).toBe('10');
    expect(body.request_frame).toBe('CZ0040300CJ003012CA00201CB0042500CD0010CE003978');
    expect(typeof body.duration_ms).toBe('number');
    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.terminate();
    const phases = messages.filter((m) => m.type === 'payment').map((m) => m.phase);
    expect(phases).toEqual(['connecting', 'sent', 'waiting', 'done']);
    const done = messages.find((m) => m.type === 'payment' && m.phase === 'done');
    expect((done?.result as { status: string }).status).toBe('approved');
    expect(messages.every((m) => m.type !== 'payment' || m.txn_id === 'txn-1')).toBe(true);
  });

  it('refus (AF=11) → HTTP 200 status declined', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/payment',
      headers: auth,
      payload: { txn_id: 'txn-2', amount_cents: 1001, kind: 'debit' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'declined', code: '11' });
  });

  it('WS /events refuse une connexion sans jeton', async () => {
    await expect(server.app.injectWS('/events')).rejects.toThrow();
  });

  it('409 busy pendant un paiement concurrent, puis /payment/cancel', async () => {
    const first = server.app.inject({
      method: 'POST',
      url: '/payment',
      headers: auth,
      payload: { txn_id: 'txn-slow', amount_cents: 1002, kind: 'debit' },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.ctx.payments.busy).toBe(true);

    const second = await server.app.inject({
      method: 'POST',
      url: '/payment',
      headers: auth,
      payload: { txn_id: 'txn-other', amount_cents: 100, kind: 'debit' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ status: 'busy', current_txn_id: 'txn-slow' });

    const wrongCancel = await server.app.inject({
      method: 'POST',
      url: '/payment/cancel',
      headers: auth,
      payload: { txn_id: 'txn-other' },
    });
    expect(wrongCancel.statusCode).toBe(409);
    expect(wrongCancel.json().ok).toBe(false);

    const cancel = await server.app.inject({
      method: 'POST',
      url: '/payment/cancel',
      headers: auth,
      payload: { txn_id: 'txn-slow' },
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json()).toEqual({ ok: true });

    const res = await first;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'error', code: 'CANCELLED' });
    expect(server.ctx.payments.busy).toBe(false);

    const idle = await server.app.inject({
      method: 'POST',
      url: '/payment/cancel',
      headers: auth,
      payload: { txn_id: 'txn-slow' },
    });
    expect(idle.statusCode).toBe(409);
  });
});

describe('impression', () => {
  it('/print avec NullPrinter', async () => {
    const before = printer.jobs.length;
    const res = await server.app.inject({
      method: 'POST',
      url: '/print',
      headers: auth,
      payload: referenceTicket(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(printer.jobs.length).toBe(before + 1);
    expect(printer.jobs.at(-1)?.toString('latin1')).toContain('Ticket T-2026-000123');
  });

  it('/print rejette un payload invalide', async () => {
    const res = await server.app.inject({
      method: 'POST',
      url: '/print',
      headers: auth,
      payload: { ...referenceTicket(), lines: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('/print/raw et /drawer/open', async () => {
    const raw = await server.app.inject({
      method: 'POST',
      url: '/print/raw',
      headers: auth,
      payload: { base64: Buffer.from('\x1b@Hello\n').toString('base64') },
    });
    expect(raw.statusCode).toBe(200);
    expect(printer.jobs.at(-1)?.toString('latin1')).toBe('\x1b@Hello\n');

    const drawer = await server.app.inject({
      method: 'POST',
      url: '/drawer/open',
      headers: auth,
      payload: { reason: 'cash' },
    });
    expect(drawer.statusCode).toBe(200);
    expect(printer.jobs.at(-1)?.toString('hex')).toBe('1b401b700019fa');
  });

  it('404 JSON sur route inconnue', async () => {
    const res = await server.app.inject({ method: 'GET', url: '/nope', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
