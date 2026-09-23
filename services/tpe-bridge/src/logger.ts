import { pino, type Logger } from 'pino';

export interface LoggerOptions {
  level?: string;
  /** Sortie lisible via `pino-pretty` (dev). */
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  if (options.pretty) {
    return pino({
      level,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l' },
      },
    });
  }
  return pino({ level });
}

export type { Logger };
