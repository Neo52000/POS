import type { TicketPayload } from '@pos/core';
import { env } from '@/lib/env';
import { useSettingsStore } from '@/stores/settingsStore';

/** SPEC §8 — API du pont TPE local. */
export interface BridgeHealth {
  ok: boolean;
  version: string;
  tpe: { host?: string; port?: number; reachable: boolean };
  printer: { type: string; reachable: boolean };
  simulate: boolean;
}

export type BridgePaymentStatus = 'approved' | 'declined' | 'timeout' | 'error' | 'busy';

export interface BridgePaymentRequest {
  txn_id: string;
  amount_cents: number;
  kind: 'debit' | 'credit';
}

export interface BridgePaymentResult {
  status: BridgePaymentStatus;
  code?: string;
  tpe_raw?: Record<string, string>;
  request_frame?: string;
  response_frame?: string;
  duration_ms: number;
}

export type BridgePaymentPhase = 'connecting' | 'sent' | 'waiting' | 'done';

export interface BridgeEvent {
  type: 'payment';
  txn_id: string;
  phase: BridgePaymentPhase;
  result?: BridgePaymentResult;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

export interface BridgeClient {
  health(): Promise<BridgeHealth>;
  pay(req: BridgePaymentRequest): Promise<BridgePaymentResult>;
  cancelPayment(txnId: string): Promise<{ ok: boolean }>;
  print(ticket: TicketPayload): Promise<{ ok: boolean }>;
  openDrawer(reason: string): Promise<{ ok: boolean }>;
  /** Abonnement au flux WS `/events` (reconnexion automatique). Retourne la fonction de désabonnement. */
  subscribeEvents(cb: (event: BridgeEvent) => void): () => void;
}

export interface BridgeConfig {
  url: string;
  token: string;
}

const PAYMENT_TIMEOUT_MS = 120_000;
const DEFAULT_TIMEOUT_MS = 8_000;

export function createBridgeClient(getConfig: () => BridgeConfig): BridgeClient {
  const base = (): string => getConfig().url.replace(/\/+$/, '');

  async function request<T>(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number; auth?: boolean } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.auth !== false) headers['X-Bridge-Token'] = getConfig().token;
    let res: Response;
    try {
      res = await fetch(`${base()}${path}`, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e instanceof DOMException && e.name === 'AbortError';
      throw new BridgeError(
        aborted ? 'Pont TPE : délai dépassé' : 'Pont TPE injoignable',
        undefined,
        e,
      );
    }
    clearTimeout(timer);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      // 409 sur /payment = { status: 'busy' } : renvoyé tel quel à l'appelant.
      if (res.status === 409 && body && typeof body === 'object' && 'status' in body)
        return body as T;
      const msg =
        body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `Pont TPE : HTTP ${res.status}`;
      throw new BridgeError(
        res.status === 401 ? 'Pont TPE : jeton invalide' : msg,
        res.status,
        body,
      );
    }
    return body as T;
  }

  // --- WebSocket /events, partagé entre abonnés, reconnexion avec backoff ---
  const listeners = new Set<(event: BridgeEvent) => void>();
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = 1000;
  let closedByUs = false;

  function wsUrl(): string {
    const cfg = getConfig();
    const u = new URL(cfg.url);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/events`;
    if (cfg.token) u.searchParams.set('token', cfg.token);
    return u.toString();
  }

  function connect(): void {
    if (socket || listeners.size === 0 || typeof WebSocket === 'undefined') return;
    closedByUs = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      backoff = 1000;
    };
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(String(msg.data)) as BridgeEvent;
        if (data && data.type === 'payment') for (const l of listeners) l(data);
      } catch {
        // message non JSON ignoré
      }
    };
    ws.onclose = () => {
      socket = null;
      if (!closedByUs) scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  function scheduleReconnect(): void {
    if (reconnectTimer || listeners.size === 0) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoff = Math.min(backoff * 2, 15_000);
      connect();
    }, backoff);
  }

  function disconnect(): void {
    closedByUs = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    socket?.close();
    socket = null;
  }

  return {
    health: () => request<BridgeHealth>('/health', { auth: false, timeoutMs: 4000 }),
    pay: (req) =>
      request<BridgePaymentResult>('/payment', { body: req, timeoutMs: PAYMENT_TIMEOUT_MS }),
    cancelPayment: (txn_id) => request<{ ok: boolean }>('/payment/cancel', { body: { txn_id } }),
    print: (ticket) => request<{ ok: boolean }>('/print', { body: ticket, timeoutMs: 15_000 }),
    openDrawer: (reason) => request<{ ok: boolean }>('/drawer/open', { body: { reason } }),
    subscribeEvents: (cb) => {
      listeners.add(cb);
      connect();
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) disconnect();
      };
    },
  };
}

async function buildBridge(): Promise<BridgeClient> {
  if (env.e2eMock) {
    const { createMockBridge } = await import('./mocks/mockBridge');
    return createMockBridge();
  }
  return createBridgeClient(() => {
    const s = useSettingsStore.getState();
    return { url: s.bridgeUrl || env.bridgeUrlDefault, token: s.bridgeToken };
  });
}

/** Client du pont (lit l'URL et le jeton dans les réglages locaux à chaque appel). */
export const bridge: BridgeClient = await buildBridge();
