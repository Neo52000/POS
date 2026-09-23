/**
 * Assemblage Fastify : CORS strict + `Access-Control-Allow-Private-Network`, jeton
 * `X-Bridge-Token` (sauf `/health` et preflights), WebSocket `/events`, routes SPEC §8.
 */
import { timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import type { Logger } from 'pino';
import { CaisseApClient } from './caisseap/client.js';
import type { BridgeConfig } from './config.js';
import { EventHub } from './events.js';
import { PaymentService } from './payments.js';
import { createPrinter, type Printer } from './printer/transport.js';
import { errorBody, type BridgeContext } from './routes/context.js';
import { registerEventRoutes } from './routes/events.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerPaymentRoutes } from './routes/payment.js';
import { registerPrintRoutes } from './routes/print.js';

export interface BuildServerOptions {
  config: BridgeConfig;
  version: string;
  logger: Logger;
  /** Hôte/port TPE effectifs (défaut : `config.tpe`). Surchargé quand le simulateur intégré tourne. */
  tpeEndpoint?: { host: string; port: number };
  /** Imprimante injectée (tests) ; défaut : construite depuis `config.printer`. */
  printer?: Printer;
  tpeClient?: CaisseApClient;
}

export interface BridgeServer {
  app: FastifyInstance;
  ctx: BridgeContext;
}

export const TOKEN_HEADER = 'x-bridge-token';

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    // Comparaison factice pour garder un temps constant.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function buildServer(options: BuildServerOptions): Promise<BridgeServer> {
  const { config, version, logger } = options;
  const tpeEndpoint = options.tpeEndpoint ?? { host: config.tpe.host, port: config.tpe.port };
  const tpeClient =
    options.tpeClient ??
    new CaisseApClient({
      host: tpeEndpoint.host,
      port: tpeEndpoint.port,
      timeoutMs: config.tpe.timeoutMs,
      connectTimeoutMs: config.tpe.connectTimeoutMs,
      posNumber: config.tpe.posNumber,
      currency: config.tpe.currency,
      protocolId: config.tpe.protocolId,
      protocolVersion: config.tpe.protocolVersion,
    });
  const printer = options.printer ?? createPrinter(config.printer, logger);
  const events = new EventHub();
  const payments = new PaymentService(tpeClient, events, logger);

  const app = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // Journal par requête désactivé par défaut (LOG_REQUESTS=1 pour l'activer) : les routes journalisent l'essentiel.
    logController: new LogController({ disableRequestLogging: process.env.LOG_REQUESTS !== '1' }),
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: false,
  });

  const ctx: BridgeContext = {
    config,
    version,
    tpeEndpoint,
    tpeClient,
    payments,
    printer,
    events,
    log: logger,
  };

  await app.register(cors, {
    origin: config.allowedOrigins.length > 0 ? config.allowedOrigins : false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Bridge-Token'],
    maxAge: 600,
    strictPreflight: false,
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // Chrome exige ce header sur le preflight pour joindre localhost depuis une origine HTTPS.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Private-Network', 'true');
    }
    return payload;
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    const path = request.url.split('?')[0] ?? request.url;
    if (path === '/health') return;
    const header = request.headers[TOKEN_HEADER];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    const query = request.query as Record<string, unknown> | undefined;
    const fromQuery =
      path === '/events' && typeof query?.token === 'string' ? (query.token as string) : undefined;
    if (!tokenMatches(config.token, fromHeader ?? fromQuery)) {
      logger.warn({ ip: request.ip, path }, 'auth: jeton absent ou invalide');
      return reply
        .code(401)
        .send(errorBody('UNAUTHORIZED', 'Jeton X-Bridge-Token absent ou invalide'));
    }
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(errorBody('NOT_FOUND', `Route inconnue : ${request.method} ${request.url}`));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    if (statusCode >= 500) logger.error({ err: error, url: request.url }, 'erreur interne');
    void reply
      .code(statusCode)
      .send(
        errorBody(
          statusCode >= 500 ? 'INTERNAL' : error.code || 'BAD_REQUEST',
          statusCode >= 500 ? 'Erreur interne du pont' : error.message,
        ),
      );
  });

  registerHealthRoutes(app, ctx);
  registerPaymentRoutes(app, ctx);
  registerPrintRoutes(app, ctx);
  registerEventRoutes(app, ctx);

  return { app, ctx };
}
