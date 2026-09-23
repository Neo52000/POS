import type { Logger } from 'pino';
import type { CaisseApClient } from '../caisseap/client.js';
import type { BridgeConfig } from '../config.js';
import type { EventHub } from '../events.js';
import type { PaymentService } from '../payments.js';
import type { Printer } from '../printer/transport.js';

/** Dépendances partagées par les routes. */
export interface BridgeContext {
  config: BridgeConfig;
  version: string;
  /** Hôte/port TPE effectifs (simulateur intégré ou TPE réel). */
  tpeEndpoint: { host: string; port: number };
  tpeClient: CaisseApClient;
  payments: PaymentService;
  printer: Printer;
  events: EventHub;
  log: Logger;
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export function errorBody(code: string, message: string, details?: unknown): ErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}
