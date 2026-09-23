import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CaisseApClient,
  TpeTimeout,
  TpeUnreachable,
  type PaymentPhase,
} from '../src/caisseap/client.js';
import { startSimulator, type SimulatorHandle } from '../simulator/tpe-sim.js';

const silent = { info: () => undefined, warn: () => undefined };

let sim: SimulatorHandle;

const makeClient = (timeoutMs = 5_000): CaisseApClient =>
  new CaisseApClient({
    host: sim.host,
    port: sim.port,
    timeoutMs,
    posNumber: '01',
    currency: '978',
    protocolId: '012',
    connectTimeoutMs: 1_000,
  });

beforeAll(async () => {
  sim = await startSimulator({ port: 0, delayMs: 50, pendingDelayMs: 200, logger: silent });
});

afterAll(async () => {
  await sim.close();
});

describe('CaisseApClient + simulateur', () => {
  it('25,00 € → approved (AE=10) avec les phases connecting/sent/waiting/done', async () => {
    const phases: PaymentPhase[] = [];
    const result = await makeClient().pay({ amountCents: 2500, action: 'debit' }, (phase) =>
      phases.push(phase),
    );
    expect(result.status).toBe('approved');
    expect(result.code).toBe('10');
    expect(result.tpe_raw.AE).toBe('10');
    expect(result.tpe_raw.CB).toBe('2500');
    expect(result.request_frame).toBe('CZ0040300CJ003012CA00201CB0042500CD0010CE003978');
    expect(result.response_frame).toBe('CZ0040300CJ003012CA00201CB0042500CD0010CE003978AE00210');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(phases).toEqual(['connecting', 'sent', 'waiting', 'done']);
  });

  it('10,01 € → declined (AE=01, AF=11)', async () => {
    const result = await makeClient().pay({ amountCents: 1001, action: 'debit' });
    expect(result.status).toBe('declined');
    expect(result.code).toBe('11');
    expect(result.tpe_raw).toMatchObject({ AE: '01', AF: '11' });
  });

  it('10,02 € avec timeoutMs 500 → timeout', async () => {
    const started = Date.now();
    const result = await makeClient(500).pay({ amountCents: 1002, action: 'debit' });
    expect(result.status).toBe('timeout');
    expect(result.code).toBe('TIMEOUT');
    expect(result.response_frame).toBe('');
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('10,03 € → approved après une réponse intermédiaire AE=11', async () => {
    const phases: Array<[PaymentPhase, Record<string, unknown> | undefined]> = [];
    const result = await makeClient().pay({ amountCents: 1003, action: 'debit' }, (phase, detail) =>
      phases.push([phase, detail]),
    );
    expect(result.status).toBe('approved');
    expect(result.tpe_raw.AE).toBe('10');
    expect(result.response_frame).toContain('AE00211');
    expect(result.response_frame.endsWith('AE00210')).toBe(true);
    expect(phases.some(([phase, detail]) => phase === 'waiting' && detail?.ae === '11')).toBe(true);
  });

  it('10,03 € avec timeout court → timeout en conservant le AE=11 partiel', async () => {
    await expect(
      makeClient(120).exchange(
        makeClient().buildRequestFrame({ amountCents: 1003, action: 'debit' }),
      ),
    ).rejects.toBeInstanceOf(TpeTimeout);
    const result = await makeClient(120).pay({ amountCents: 1003, action: 'debit' });
    expect(result.status).toBe('timeout');
    expect(result.code).toBe('11');
    expect(result.tpe_raw.AE).toBe('11');
  });

  it('crédit (remboursement) → CD=1 accepté', async () => {
    const result = await makeClient().pay({ amountCents: 500, action: 'credit' });
    expect(result.status).toBe('approved');
    expect(result.tpe_raw.CD).toBe('1');
  });

  it('annulation via AbortSignal → status error / CANCELLED', async () => {
    const controller = new AbortController();
    const promise = makeClient(5_000).pay(
      { amountCents: 1002, action: 'debit' },
      undefined,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    const result = await promise;
    expect(result.status).toBe('error');
    expect(result.code).toBe('CANCELLED');
  });

  it('reachable() reflète la joignabilité TCP', async () => {
    expect(await makeClient().reachable()).toBe(true);
    const closed = new CaisseApClient({ ...makeClient().options, port: 1 });
    expect(await closed.reachable()).toBe(false);
  });
});

describe('CaisseApClient sans TPE', () => {
  it('ECONNREFUSED → TpeUnreachable / status error', async () => {
    const probe = createServer();
    const port = await new Promise<number>((resolve) =>
      probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port)),
    );
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const client = new CaisseApClient({
      host: '127.0.0.1',
      port,
      timeoutMs: 1_000,
      posNumber: '01',
      currency: '978',
      protocolId: '012',
    });
    await expect(
      client.exchange(client.buildRequestFrame({ amountCents: 100, action: 'debit' })),
    ).rejects.toBeInstanceOf(TpeUnreachable);
    const result = await client.pay({ amountCents: 100, action: 'debit' });
    expect(result.status).toBe('error');
    expect(result.code).toBe('ECONNREFUSED');
  });

  it('fermeture sans réponse → status error / NO_RESPONSE', async () => {
    const server: Server = createServer((socket) => socket.once('data', () => socket.end()));
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)),
    );
    try {
      const client = new CaisseApClient({
        host: '127.0.0.1',
        port,
        timeoutMs: 1_000,
        posNumber: '01',
        currency: '978',
        protocolId: '012',
      });
      const result = await client.pay({ amountCents: 100, action: 'debit' });
      expect(result.status).toBe('error');
      expect(result.code).toBe('NO_RESPONSE');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
