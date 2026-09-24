import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadTlsMaterial, parseConfig } from '../src/config.js';
import { NullPrinter } from '../src/printer/transport.js';
import { buildServer, type BridgeServer } from '../src/server.js';
import { startSimulator, type SimulatorHandle } from '../simulator/tpe-sim.js';

// Certificat auto-signé de test uniquement (CN=localhost, 10 ans) :
// openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=localhost"
const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/tls/${name}`, import.meta.url));
const TOKEN = 'test-token-0123456789abcdef';

function httpsGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('configuration tls', () => {
  it('est optionnelle et stricte', () => {
    expect(parseConfig({ token: TOKEN }).tls).toBeUndefined();
    expect(parseConfig({ token: TOKEN, tls: { certPath: 'c.pem', keyPath: 'k.pem' } }).tls).toEqual(
      { certPath: 'c.pem', keyPath: 'k.pem' },
    );
    expect(() => parseConfig({ token: TOKEN, tls: { certPath: 'c.pem' } })).toThrow(ConfigError);
    expect(() =>
      parseConfig({ token: TOKEN, tls: { certPath: 'c', keyPath: 'k', ca: 'x' } }),
    ).toThrow(ConfigError);
  });

  it('ignore les clés commentaires (//…) : l’exemple fourni est valide', async () => {
    const { readFileSync } = await import('node:fs');
    const example = JSON.parse(
      readFileSync(new URL('../bridge.config.example.json', import.meta.url), 'utf8'),
    ) as unknown;
    const config = parseConfig(example);
    expect(config.tls).toBeUndefined();
    const withTls = { ...(example as Record<string, unknown>) };
    withTls['tls'] = withTls['//tls'];
    expect(parseConfig(withTls).tls).toEqual({
      certPath: 'tls/fullchain.pem',
      keyPath: 'tls/privkey.pem',
    });
  });

  it('signale un fichier illisible par ConfigError', () => {
    expect(() => loadTlsMaterial({ certPath: 'absent.pem', keyPath: 'absent.key' })).toThrow(
      /tls\.certPath illisible/,
    );
  });
});

describe('serveur HTTPS natif', () => {
  let sim: SimulatorHandle;
  let server: BridgeServer;
  let port: number;

  beforeAll(async () => {
    sim = await startSimulator({
      port: 0,
      logger: { info: () => undefined, warn: () => undefined },
    });
    const config = parseConfig({
      token: TOKEN,
      tpe: { host: sim.host, port: sim.port, simulate: true },
      printer: { type: 'none' },
      tls: { certPath: fixture('cert.pem'), keyPath: fixture('key.pem') },
    });
    server = await buildServer({
      config,
      version: '0.1.0-tls',
      logger: pino({ level: 'silent' }),
      tpeEndpoint: { host: sim.host, port: sim.port },
      printer: new NullPrinter(),
    });
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    port = (server.app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await server.app.close();
    await sim.close();
  });

  it('expose le schéma https', () => {
    expect(server.scheme).toBe('https');
  });

  it('GET /health répond en HTTPS', async () => {
    const res = await httpsGet(port, '/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, version: '0.1.0-tls', simulate: true });
  });

  it('les routes protégées exigent toujours le jeton', async () => {
    const res = await httpsGet(port, '/events');
    expect(res.status).toBe(401);
  });
});
