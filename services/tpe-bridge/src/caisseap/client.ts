/**
 * Client TCP Caisse-AP : une connexion par transaction.
 *
 * Séquence : connexion → envoi de la trame `CZ CJ CA CB CD CE` → accumulation des données reçues
 * → décodage à chaque chunk. Dès qu'un `AE` complet est présent : `AE=11` (pris en compte) →
 * on continue d'attendre la réponse finale jusqu'au timeout ; sinon on résout. Si le TPE ferme
 * la connexion, on résout avec ce qui a été reçu.
 */
import { createConnection, type Socket } from 'node:net';
import {
  buildPaymentRequest,
  decodeFields,
  parsePaymentResponse,
  type CaisseApAction,
  type CaisseApPaymentResponse,
} from '@pos/core';

export type PaymentPhase = 'connecting' | 'sent' | 'waiting' | 'done';
export type PaymentStatus = 'approved' | 'declined' | 'timeout' | 'error';

export interface CaisseApClientOptions {
  host: string;
  port: number;
  /** Délai maximal d'attente de la réponse finale après envoi (saisie client incluse). */
  timeoutMs: number;
  posNumber: string;
  currency: string;
  protocolId: string;
  protocolVersion?: string;
  /** Délai de connexion TCP (défaut 5 s). */
  connectTimeoutMs?: number;
  /** Après une réponse finale complète, attente courte de données supplémentaires (défaut 100 ms). */
  settleMs?: number;
}

export interface PaymentRequest {
  amountCents: number;
  action: CaisseApAction;
}

export interface PaymentResult {
  status: PaymentStatus;
  /** `AE` (ou `AF` si refus motivé), ou un code d'erreur interne (`ECONNREFUSED`, `TIMEOUT`, `CANCELLED`…). */
  code?: string;
  /** Message lisible (erreurs). */
  message?: string;
  tpe_raw: Record<string, string>;
  request_frame: string;
  response_frame: string;
  duration_ms: number;
}

export type PhaseListener = (phase: PaymentPhase, detail?: Record<string, unknown>) => void;

export class TpeError extends Error {
  override readonly name: string = 'TpeError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Connexion impossible (`ECONNREFUSED`, `EHOSTUNREACH`, `ETIMEDOUT`, `ENETUNREACH`…). */
export class TpeUnreachable extends TpeError {
  override readonly name = 'TpeUnreachable';
}

/** Pas de réponse finale dans le délai imparti. */
export class TpeTimeout extends TpeError {
  override readonly name = 'TpeTimeout';
  constructor(
    message: string,
    /** Réponse partielle éventuellement reçue (ex. `AE=11`). */
    readonly partial: CaisseApPaymentResponse | null,
    readonly responseFrame: string,
  ) {
    super(message, 'TIMEOUT');
  }
}

/** Paiement interrompu par la caisse (`/payment/cancel`, arrêt du service). */
export class TpeCancelled extends TpeError {
  override readonly name = 'TpeCancelled';
  constructor(message = 'Paiement interrompu par la caisse') {
    super(message, 'CANCELLED');
  }
}

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
]);

interface Exchange {
  response: CaisseApPaymentResponse | null;
  responseFrame: string;
}

export class CaisseApClient {
  readonly options: Required<CaisseApClientOptions>;

  constructor(options: CaisseApClientOptions) {
    this.options = {
      protocolVersion: '0300',
      connectTimeoutMs: 5_000,
      settleMs: 100,
      ...options,
    };
  }

  /** Trame de demande (exposée pour les journaux et les tests). */
  buildRequestFrame(request: PaymentRequest): string {
    return buildPaymentRequest({
      posNumber: this.options.posNumber,
      amountCents: request.amountCents,
      action: request.action,
      currency: this.options.currency,
      protocolId: this.options.protocolId,
      protocolVersion: this.options.protocolVersion,
    });
  }

  /**
   * Lance un paiement et résout TOUJOURS avec un `PaymentResult` (les erreurs typées sont
   * traduites en `status: 'timeout' | 'error'`). Utiliser `exchange()` pour obtenir les
   * exceptions.
   */
  async pay(
    request: PaymentRequest,
    onPhase?: PhaseListener,
    signal?: AbortSignal,
  ): Promise<PaymentResult> {
    const startedAt = Date.now();
    const requestFrame = this.buildRequestFrame(request);
    const done = (partial: Omit<PaymentResult, 'request_frame' | 'duration_ms'>): PaymentResult => {
      const result: PaymentResult = {
        ...partial,
        request_frame: requestFrame,
        duration_ms: Date.now() - startedAt,
      };
      onPhase?.('done', { status: result.status, code: result.code });
      return result;
    };
    try {
      const { response, responseFrame } = await this.exchange(requestFrame, onPhase, signal);
      if (response === null) {
        return done({
          status: 'error',
          code: 'NO_RESPONSE',
          message: 'Le TPE a fermé la connexion sans répondre',
          tpe_raw: {},
          response_frame: responseFrame,
        });
      }
      return done({ ...statusFromResponse(response), response_frame: responseFrame });
    } catch (error) {
      if (error instanceof TpeTimeout) {
        return done({
          status: 'timeout',
          code: error.partial?.ae ?? 'TIMEOUT',
          message: error.message,
          tpe_raw: error.partial?.raw ?? {},
          response_frame: error.responseFrame,
        });
      }
      if (error instanceof TpeError) {
        return done({
          status: 'error',
          code: error.code,
          message: error.message,
          tpe_raw: {},
          response_frame: '',
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return done({ status: 'error', code: 'INTERNAL', message, tpe_raw: {}, response_frame: '' });
    }
  }

  /** Échange bas niveau : rejette avec `TpeUnreachable`, `TpeTimeout`, `TpeCancelled` ou `TpeError`. */
  exchange(requestFrame: string, onPhase?: PhaseListener, signal?: AbortSignal): Promise<Exchange> {
    const { host, port, timeoutMs, connectTimeoutMs, settleMs } = this.options;
    return new Promise<Exchange>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new TpeCancelled());
        return;
      }
      let settled = false;
      let connected = false;
      let sent = false;
      let buffer = '';
      let lastResponse: CaisseApPaymentResponse | null = null;
      let responseTimer: NodeJS.Timeout | null = null;
      let settleTimer: NodeJS.Timeout | null = null;
      let socket: Socket | null = null;

      const cleanup = (): void => {
        if (responseTimer) clearTimeout(responseTimer);
        if (settleTimer) clearTimeout(settleTimer);
        signal?.removeEventListener('abort', onAbort);
        if (socket) {
          socket.removeAllListeners();
          socket.on('error', () => undefined);
          socket.destroy();
        }
      };
      const finish = (outcome: { ok: Exchange } | { err: Error }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if ('ok' in outcome) resolve(outcome.ok);
        else reject(outcome.err);
      };
      const onAbort = (): void => finish({ err: new TpeCancelled() });
      signal?.addEventListener('abort', onAbort, { once: true });

      const finalizeReceived = (): void => {
        finish({ ok: { response: lastResponse, responseFrame: buffer } });
      };

      onPhase?.('connecting', { host, port });
      socket = createConnection({ host, port });
      socket.setNoDelay(true);
      socket.setTimeout(connectTimeoutMs);

      socket.on('timeout', () => {
        if (!connected) {
          finish({
            err: new TpeUnreachable(
              `Connexion au TPE ${host}:${port} expirée après ${connectTimeoutMs} ms`,
              'ETIMEDOUT',
            ),
          });
          return;
        }
        finish({
          err: new TpeTimeout(
            lastResponse
              ? `Réponse finale du TPE non reçue dans les ${timeoutMs} ms (dernier AE=${lastResponse.ae ?? '?'})`
              : `Aucune réponse du TPE dans les ${timeoutMs} ms`,
            lastResponse,
            buffer,
          ),
        });
      });

      socket.on('error', (error: NodeJS.ErrnoException) => {
        const code = error.code ?? 'ESOCKET';
        if (!connected || UNREACHABLE_CODES.has(code)) {
          finish({
            err: new TpeUnreachable(`TPE ${host}:${port} injoignable (${code})`, code),
          });
          return;
        }
        if (buffer.length > 0 && lastResponse && lastResponse.status !== 'pending') {
          finalizeReceived();
          return;
        }
        finish({ err: new TpeError(`Erreur socket TPE (${code}) : ${error.message}`, code) });
      });

      socket.on('connect', () => {
        connected = true;
        socket?.setTimeout(timeoutMs);
        socket?.write(requestFrame, 'latin1', (error) => {
          if (error) {
            finish({
              err: new TpeError(`Envoi de la trame impossible : ${error.message}`, 'EWRITE'),
            });
            return;
          }
          sent = true;
          onPhase?.('sent', { request_frame: requestFrame });
          onPhase?.('waiting');
          responseTimer = setTimeout(() => {
            finish({
              err: new TpeTimeout(
                lastResponse
                  ? `Réponse finale du TPE non reçue dans les ${timeoutMs} ms (dernier AE=${lastResponse.ae ?? '?'})`
                  : `Aucune réponse du TPE dans les ${timeoutMs} ms`,
                lastResponse,
                buffer,
              ),
            });
          }, timeoutMs);
        });
      });

      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1');
        const decoded = decodeFields(buffer);
        if (!decoded.fields.has('AE')) return;
        const parsed = parsePaymentResponse(decoded);
        lastResponse = parsed;
        if (parsed.status === 'pending') {
          onPhase?.('waiting', { ae: parsed.ae });
          return;
        }
        if (decoded.truncated) return;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(finalizeReceived, settleMs);
      });

      const onClosed = (): void => {
        if (settled) return;
        if (!sent) {
          finish({
            err: new TpeError('Connexion fermée par le TPE avant envoi de la trame', 'ECLOSED'),
          });
          return;
        }
        finalizeReceived();
      };
      socket.on('end', onClosed);
      socket.on('close', onClosed);
    });
  }

  /** Test de joignabilité TCP (utilisé par `/health`), sans envoyer de trame. */
  reachable(timeoutMs = 1_000): Promise<boolean> {
    const { host, port } = this.options;
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

/** Traduit une réponse décodée en `status`/`code`/`tpe_raw`. */
export function statusFromResponse(
  response: CaisseApPaymentResponse,
): Pick<PaymentResult, 'status' | 'code' | 'message' | 'tpe_raw'> {
  switch (response.status) {
    case 'approved':
      return { status: 'approved', code: response.ae ?? '10', tpe_raw: response.raw };
    case 'declined':
      return {
        status: 'declined',
        code: response.af ?? response.ae ?? '01',
        message: response.af ? `Refus TPE (AF=${response.af})` : 'Refus TPE',
        tpe_raw: response.raw,
      };
    case 'pending':
      return {
        status: 'timeout',
        code: response.ae ?? '11',
        message: 'Le TPE a pris en compte la demande sans envoyer de réponse finale',
        tpe_raw: response.raw,
      };
    default:
      return {
        status: 'error',
        code: response.ae ?? 'UNKNOWN',
        message: `Statut TPE inconnu (AE=${response.ae ?? 'absent'})`,
        tpe_raw: response.raw,
      };
  }
}
