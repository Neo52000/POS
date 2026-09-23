/**
 * Point d'entrée du pont TPE : configuration, simulateur intégré (optionnel), serveur HTTP/WS,
 * arrêt propre sur SIGINT/SIGTERM.
 */
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildServer } from './server.js';
import { startSimulator, type SimulatorHandle } from '../simulator/tpe-sim.js';
import pkg from '../package.json' with { type: 'json' };

export const BRIDGE_VERSION: string = pkg.version;

async function main(): Promise<void> {
  const pretty =
    process.env.LOG_PRETTY === '1' ||
    (process.env.LOG_PRETTY !== '0' &&
      process.env.NODE_ENV !== 'production' &&
      process.stdout.isTTY === true);
  const logger = createLogger({ pretty });

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.fatal(error.message);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  let simulator: SimulatorHandle | null = null;
  let tpeEndpoint = { host: config.tpe.host, port: config.tpe.port };
  if (config.tpe.simulate) {
    simulator = await startSimulator({ port: 0, host: '127.0.0.1', logger });
    tpeEndpoint = { host: simulator.host, port: simulator.port };
    logger.warn(
      { ...tpeEndpoint },
      'tpe.simulate=true : simulateur intégré, aucun TPE réel contacté',
    );
  }

  const { app, ctx } = await buildServer({ config, version: BRIDGE_VERSION, logger, tpeEndpoint });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'arrêt du pont');
    ctx.payments.abortAll();
    const timer = setTimeout(() => {
      logger.error('arrêt forcé (délai dépassé)');
      process.exit(1);
    }, 5_000);
    timer.unref();
    void Promise.allSettled([app.close(), simulator?.close() ?? Promise.resolve()]).then(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ host: config.http.host, port: config.http.port });
  } catch (error) {
    logger.fatal({ err: error }, `écoute impossible sur ${config.http.host}:${config.http.port}`);
    await simulator?.close();
    process.exitCode = 1;
    return;
  }
  logger.info(
    {
      version: BRIDGE_VERSION,
      http: config.http,
      tpe: { ...tpeEndpoint, simulate: config.tpe.simulate, timeoutMs: config.tpe.timeoutMs },
      printer: { type: config.printer.type, host: config.printer.host, port: config.printer.port },
      allowedOrigins: config.allowedOrigins,
    },
    'pont TPE prêt',
  );
}

void main().catch((error: unknown) => {
  console.error('tpe-bridge: erreur fatale', error);
  process.exit(1);
});
