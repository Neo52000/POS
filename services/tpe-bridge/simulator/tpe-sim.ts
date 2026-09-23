/**
 * Simulateur de TPE Caisse-AP (TCP, port `TPE_SIM_PORT`, défaut 8888).
 *
 * Décode la trame reçue, la journalise et répond après `TPE_SIM_DELAY_MS` (défaut 1500 ms) :
 * - par défaut : `AE=10` (accepté) ;
 * - montant se terminant par `01` centimes : `AE=01` + `AF=11` (abandon) ;
 * - `02` : aucune réponse (la caisse doit expirer) ;
 * - `03` : `AE=11` (pris en compte) puis, `pendingDelayMs` plus tard (défaut 1 s), `AE=10`.
 *
 * Exécuté directement : `pnpm --filter @pos/tpe-bridge sim` (ou `pnpm dev:tpe-sim`).
 */
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { decodeFields, encodeFields } from '@pos/core';

export interface SimulatorLogger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
}

export interface SimulatorOptions {
  /** `0` = port libre attribué par l'OS (tests). */
  port?: number;
  host?: string;
  /** Délai avant la réponse (ms). */
  delayMs?: number;
  /** Délai entre `AE=11` et `AE=10` pour les montants en `…03` (ms). */
  pendingDelayMs?: number;
  logger?: SimulatorLogger;
}

export interface SimulatorHandle {
  host: string;
  port: number;
  server: Server;
  close(): Promise<void>;
}

export const DEFAULT_SIM_PORT = 8888;
export const DEFAULT_SIM_DELAY_MS = 1500;
export const DEFAULT_PENDING_DELAY_MS = 1000;

const consoleLogger: SimulatorLogger = {
  info: (obj, msg) => console.log(msg ?? '', typeof obj === 'string' ? obj : JSON.stringify(obj)),
  warn: (obj, msg) => console.warn(msg ?? '', typeof obj === 'string' ? obj : JSON.stringify(obj)),
};

type Scenario = 'approved' | 'declined' | 'silent' | 'pending-then-approved';

/** Scénario déterminé par les deux derniers chiffres du montant (centimes). */
export function scenarioFor(amountCents: number): Scenario {
  switch (((amountCents % 100) + 100) % 100) {
    case 1:
      return 'declined';
    case 2:
      return 'silent';
    case 3:
      return 'pending-then-approved';
    default:
      return 'approved';
  }
}

/** Construit la réponse en recopiant les champs d'identification de la demande. */
export function buildResponse(request: Map<string, string>, ae: string, af?: string): string {
  const fields: Array<[string, string]> = [
    ['CZ', '0300'],
    ['CJ', request.get('CJ') ?? '012'],
    ['CA', request.get('CA') ?? '01'],
    ['CB', request.get('CB') ?? '0'],
    ['CD', request.get('CD') ?? '0'],
    ['CE', '978'],
    ['AE', ae],
  ];
  if (af !== undefined) fields.push(['AF', af]);
  return encodeFields(fields);
}

export function startSimulator(options: SimulatorOptions = {}): Promise<SimulatorHandle> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? DEFAULT_SIM_PORT;
  const delayMs = options.delayMs ?? DEFAULT_SIM_DELAY_MS;
  const pendingDelayMs = options.pendingDelayMs ?? DEFAULT_PENDING_DELAY_MS;
  const log = options.logger ?? consoleLogger;
  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();

  const schedule = (ms: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
  };

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    let buffer = '';
    let handled = false;
    const peer = `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`;
    log.info({ peer }, 'tpe-sim: connexion');

    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      buffer += chunk.toString('latin1');
      const decoded = decodeFields(buffer);
      if (decoded.truncated || !decoded.fields.has('CE')) return;
      handled = true;
      const request = decoded.fields;
      const amountCents = Number(request.get('CB') ?? '0');
      const scenario = scenarioFor(amountCents);
      log.info(
        { peer, frame: buffer, fields: Object.fromEntries(request), amountCents, scenario },
        'tpe-sim: demande reçue',
      );
      const send = (frame: string, end: boolean): void => {
        if (socket.destroyed) return;
        log.info({ peer, frame }, 'tpe-sim: réponse');
        socket.write(frame, 'latin1', () => {
          if (end) socket.end();
        });
      };
      switch (scenario) {
        case 'declined':
          schedule(delayMs, () => send(buildResponse(request, '01', '11'), true));
          break;
        case 'silent':
          log.warn({ peer }, 'tpe-sim: montant …02 → aucune réponse (timeout côté caisse)');
          break;
        case 'pending-then-approved':
          schedule(delayMs, () => {
            send(buildResponse(request, '11'), false);
            schedule(pendingDelayMs, () => send(buildResponse(request, '10'), true));
          });
          break;
        default:
          schedule(delayMs, () => send(buildResponse(request, '10'), true));
      }
    });
    socket.on('error', (error) =>
      log.warn({ peer, error: error.message }, 'tpe-sim: erreur socket'),
    );
    socket.on('close', () => {
      sockets.delete(socket);
      log.info({ peer }, 'tpe-sim: déconnexion');
    });
  });

  return new Promise<SimulatorHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      log.info({ host, port: address.port, delayMs }, 'tpe-sim: en écoute');
      resolve({
        host,
        port: address.port,
        server,
        close: () =>
          new Promise<void>((done) => {
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

/**
 * `true` si ce fichier est le script lancé (`tsx simulator/tpe-sim.ts`, `node dist/tpe-sim.js`).
 * Le nom de fichier est aussi vérifié : une fois bundlé dans `dist/index.js`, `import.meta.url`
 * désigne le bundle du pont, qui ne doit pas démarrer le simulateur sur 8888.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    return realpathSync(entry) === self && basename(self).startsWith('tpe-sim');
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const port = Number(process.env.TPE_SIM_PORT ?? DEFAULT_SIM_PORT);
  const delayMs = Number(process.env.TPE_SIM_DELAY_MS ?? DEFAULT_SIM_DELAY_MS);
  const host = process.env.TPE_SIM_HOST ?? '0.0.0.0';
  startSimulator({ port, host, delayMs })
    .then((handle) => {
      const stop = (): void => {
        void handle.close().then(() => process.exit(0));
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch((error: unknown) => {
      console.error('tpe-sim: démarrage impossible', error);
      process.exit(1);
    });
}
