/**
 * Transports d'impression : réseau (RAW TCP 9100) ou nul (journal uniquement).
 */
import { createConnection } from 'node:net';

export interface PrinterLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface Printer {
  readonly type: 'network' | 'none';
  print(buffer: Buffer): Promise<void>;
  reachable(): Promise<boolean>;
}

export class PrinterError extends Error {
  override readonly name = 'PrinterError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface NetworkPrinterOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
  logger?: PrinterLogger;
}

export class NetworkPrinter implements Printer {
  readonly type = 'network' as const;
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
  private readonly logger: PrinterLogger | undefined;

  constructor(options: NetworkPrinterOptions) {
    this.host = options.host;
    this.port = options.port ?? 9100;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger;
  }

  print(buffer: Buffer): Promise<void> {
    const { host, port, timeoutMs } = this;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = createConnection({ host, port });
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.on('error', () => undefined);
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      socket.setNoDelay(true);
      socket.setTimeout(timeoutMs);
      socket.once('timeout', () =>
        finish(
          new PrinterError(
            `Imprimante ${host}:${port} : délai dépassé (${timeoutMs} ms)`,
            'ETIMEDOUT',
          ),
        ),
      );
      socket.once('error', (error: NodeJS.ErrnoException) =>
        finish(
          new PrinterError(
            `Imprimante ${host}:${port} injoignable (${error.code ?? error.message})`,
            error.code ?? 'ESOCKET',
          ),
        ),
      );
      socket.once('connect', () => {
        socket.end(buffer, () => {
          this.logger?.info({ host, port, bytes: buffer.length }, 'printer: envoyé');
          finish();
        });
      });
    });
  }

  reachable(timeoutMs = 1_000): Promise<boolean> {
    const { host, port } = this;
    return new Promise<boolean>((resolve) => {
      const socket = createConnection({ host, port });
      const finish = (value: boolean): void => {
        socket.removeAllListeners();
        socket.on('error', () => undefined);
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }
}

/** Imprimante nulle : journalise la taille du buffer, toujours joignable. */
export class NullPrinter implements Printer {
  readonly type = 'none' as const;
  /** Buffers reçus (utile pour les tests). */
  readonly jobs: Buffer[] = [];

  constructor(private readonly logger?: PrinterLogger) {}

  print(buffer: Buffer): Promise<void> {
    this.jobs.push(buffer);
    this.logger?.info({ bytes: buffer.length }, 'printer(none): impression ignorée');
    return Promise.resolve();
  }

  reachable(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export interface PrinterFactoryConfig {
  type: 'network' | 'none';
  host?: string;
  port: number;
  timeoutMs: number;
}

export function createPrinter(config: PrinterFactoryConfig, logger?: PrinterLogger): Printer {
  if (config.type === 'network') {
    if (!config.host) throw new PrinterError('printer.host manquant', 'ECONFIG');
    return new NetworkPrinter({
      host: config.host,
      port: config.port,
      timeoutMs: config.timeoutMs,
      logger,
    });
  }
  return new NullPrinter(logger);
}
