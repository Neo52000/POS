/**
 * Service de paiement : verrou « un paiement à la fois », diffusion des phases, annulation.
 */
import type { CaisseApAction } from '@pos/core';
import type { CaisseApClient, PaymentResult } from './caisseap/client.js';
import type { EventHub } from './events.js';

export interface ActivePayment {
  txn_id: string;
  amount_cents: number;
  action: CaisseApAction;
  started_at: number;
}

export interface PaymentLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export class PaymentBusyError extends Error {
  override readonly name = 'PaymentBusyError';
  constructor(readonly current: ActivePayment) {
    super(`Paiement en cours (txn ${current.txn_id})`);
  }
}

export class PaymentService {
  private active: { info: ActivePayment; controller: AbortController } | null = null;

  constructor(
    private readonly client: CaisseApClient,
    private readonly events: EventHub,
    private readonly logger?: PaymentLogger,
  ) {}

  get current(): ActivePayment | null {
    return this.active?.info ?? null;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  /** Lance un paiement ; rejette avec `PaymentBusyError` si un autre est en cours. */
  async pay(txn_id: string, amount_cents: number, action: CaisseApAction): Promise<PaymentResult> {
    if (this.active) throw new PaymentBusyError(this.active.info);
    const controller = new AbortController();
    const info: ActivePayment = { txn_id, amount_cents, action, started_at: Date.now() };
    this.active = { info, controller };
    this.logger?.info({ txn_id, amount_cents, action }, 'payment: démarrage');
    try {
      const result = await this.client.pay(
        { amountCents: amount_cents, action },
        (phase, detail) => {
          if (phase === 'done') return;
          this.events.broadcast({ type: 'payment', txn_id, phase, ...(detail ? { detail } : {}) });
        },
        controller.signal,
      );
      this.events.broadcast({ type: 'payment', txn_id, phase: 'done', result });
      const level = result.status === 'approved' || result.status === 'declined' ? 'info' : 'warn';
      this.logger?.[level](
        {
          txn_id,
          status: result.status,
          code: result.code,
          duration_ms: result.duration_ms,
          request_frame: result.request_frame,
          response_frame: result.response_frame,
        },
        `payment: ${result.status}`,
      );
      return result;
    } finally {
      this.active = null;
    }
  }

  /** Interrompt le paiement `txn_id` en cours. `false` si aucun paiement (ou un autre) n'est en cours. */
  cancel(txn_id: string): boolean {
    if (!this.active || this.active.info.txn_id !== txn_id) return false;
    this.logger?.warn({ txn_id }, 'payment: annulation demandée');
    this.active.controller.abort();
    return true;
  }

  /** Interrompt tout paiement en cours (arrêt du service). */
  abortAll(): void {
    this.active?.controller.abort();
  }
}
