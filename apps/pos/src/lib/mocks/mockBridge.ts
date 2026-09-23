import type { BridgeClient, BridgeEvent, BridgePaymentResult } from '@/lib/bridge';

/**
 * Pont TPE simulé : approuve tout paiement (sauf montants magiques se terminant par
 * `…01` = refus, `…02` = timeout), imprime et ouvre le tiroir sans matériel.
 */
export function createMockBridge(): BridgeClient {
  const listeners = new Set<(e: BridgeEvent) => void>();
  const emit = (e: BridgeEvent): void => {
    for (const l of listeners) l(e);
  };
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const printed: unknown[] = [];
  (globalThis as { __posMockPrinted?: unknown[] }).__posMockPrinted = printed;

  return {
    async health() {
      return {
        ok: true,
        version: 'mock',
        tpe: { host: 'sim', port: 8888, reachable: true },
        printer: { type: 'none', reachable: true },
        simulate: true,
      };
    },
    async pay(req) {
      const started = Date.now();
      emit({ type: 'payment', txn_id: req.txn_id, phase: 'connecting' });
      await wait(120);
      emit({ type: 'payment', txn_id: req.txn_id, phase: 'sent' });
      await wait(120);
      emit({ type: 'payment', txn_id: req.txn_id, phase: 'waiting' });
      await wait(250);
      const tail = Math.abs(req.amount_cents) % 100;
      let result: BridgePaymentResult;
      if (tail === 1) {
        result = {
          status: 'declined',
          code: '01',
          tpe_raw: { AE: '01', AF: '11' },
          duration_ms: Date.now() - started,
        };
      } else if (tail === 2) {
        result = { status: 'timeout', duration_ms: Date.now() - started };
      } else {
        result = {
          status: 'approved',
          code: '10',
          tpe_raw: {
            AE: '10',
            CB: String(Math.abs(req.amount_cents)),
            CD: req.kind === 'credit' ? '1' : '0',
          },
          request_frame: 'CZ0040300CJ012...',
          response_frame: 'AE00210',
          duration_ms: Date.now() - started,
        };
      }
      emit({ type: 'payment', txn_id: req.txn_id, phase: 'done', result });
      return result;
    },
    async cancelPayment() {
      return { ok: true };
    },
    async print(ticket) {
      printed.push(ticket);
      return { ok: true };
    },
    async openDrawer() {
      return { ok: true };
    },
    subscribeEvents(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
