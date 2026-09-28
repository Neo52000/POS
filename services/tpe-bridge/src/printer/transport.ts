/**
 * Transports d'impression : réseau (RAW TCP 9100), périphérique (USB / file Windows partagée /
 * port série Bluetooth) ou nul (journal uniquement).
 */
import { constants as fsConstants } from 'node:fs';
import { access, open } from 'node:fs/promises';
import { createConnection } from 'node:net';

export interface PrinterLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export type PrinterType = 'network' | 'device' | 'none';

export interface Printer {
  readonly type: PrinterType;
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

export interface DevicePrinterOptions {
  /** `/dev/usb/lp0`, `\\localhost\mPOP` (file partagée), `\\.\COM5` (Bluetooth SPP). */
  path: string;
  timeoutMs?: number;
  logger?: PrinterLogger;
}

/** Chemin UNC Windows (`\\hôte\partage`, `\\.\COM5`) : non sondable sans imprimer. */
export function isUncPath(path: string): boolean {
  return path.startsWith('\\\\');
}

/**
 * Écriture RAW dans un fichier de périphérique. Linux : imprimante USB en classe « Printer »
 * (`usblp`, `/dev/usb/lp0`, droits via le groupe `lp`). Windows : file d'impression partagée
 * (pilote « Generic / Text Only » ou pilote Star, données RAW) ou port COM Bluetooth.
 */
export class DevicePrinter implements Printer {
  readonly type = 'device' as const;
  readonly path: string;
  readonly timeoutMs: number;
  private readonly logger: PrinterLogger | undefined;
  /** Une écriture à la fois : deux tickets simultanés s'entrelaceraient sur le périphérique. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: DevicePrinterOptions) {
    this.path = options.path;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger;
  }

  print(buffer: Buffer): Promise<void> {
    const job = this.queue.then(() => this.write(buffer));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async write(buffer: Buffer): Promise<void> {
    const { path, timeoutMs } = this;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new PrinterError(`Imprimante ${path} : délai dépassé (${timeoutMs} ms)`, 'ETIMEDOUT'),
          ),
        timeoutMs,
      );
    });
    const write = (async () => {
      // `r+` sur un périphérique existant (pas de création de fichier si le chemin est faux),
      // `w` pour une file Windows partagée (UNC) qui refuse la lecture.
      const handle = await open(path, isUncPath(path) ? 'w' : 'r+');
      try {
        await handle.write(buffer);
      } finally {
        await handle.close();
      }
    })();
    try {
      await Promise.race([write, timeout]);
      this.logger?.info({ path, bytes: buffer.length }, 'printer: envoyé');
    } catch (error) {
      if (error instanceof PrinterError) throw error;
      const e = error as NodeJS.ErrnoException;
      throw new PrinterError(
        `Imprimante ${path} indisponible (${e.code ?? e.message})`,
        e.code ?? 'EDEVICE',
      );
    } finally {
      clearTimeout(timer);
      // Une écriture bloquée (imprimante éteinte) finit par échouer : rejet absorbé.
      write.catch(() => undefined);
    }
  }

  async reachable(): Promise<boolean> {
    // Une file partagée Windows ne se sonde pas sans imprimer : supposée joignable.
    if (isUncPath(this.path)) return true;
    try {
      await access(this.path, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
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
  type: PrinterType;
  host?: string;
  path?: string;
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
  if (config.type === 'device') {
    if (!config.path) throw new PrinterError('printer.path manquant', 'ECONFIG');
    return new DevicePrinter({ path: config.path, timeoutMs: config.timeoutMs, logger });
  }
  return new NullPrinter(logger);
}
