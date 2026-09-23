import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '@/lib/bridge';
import type { BridgePaymentPhase, BridgePaymentResult } from '@/lib/bridge';
import { uuidv4 } from '@/lib/uuid';

export type TpePhase = 'idle' | BridgePaymentPhase;

export interface TpePaymentState {
  phase: TpePhase;
  txnId: string | null;
  result: BridgePaymentResult | null;
  error: string | null;
}

const INITIAL: TpePaymentState = { phase: 'idle', txnId: null, result: null, error: null };

/** Paiement CB via le pont : phases (WS `/events`), annulation, résultat. */
export function useTpePayment() {
  const [state, setState] = useState<TpePaymentState>(INITIAL);
  const txnRef = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pay = useCallback(async (amountCents: number, kind: 'debit' | 'credit' = 'debit') => {
    const txnId = uuidv4();
    txnRef.current = txnId;
    setState({ phase: 'connecting', txnId, result: null, error: null });
    const unsubscribe = bridge.subscribeEvents((ev) => {
      if (ev.txn_id !== txnId || !mounted.current) return;
      setState((s) => (s.phase === 'done' ? s : { ...s, phase: ev.phase }));
    });
    try {
      const result = await bridge.pay({ txn_id: txnId, amount_cents: Math.abs(amountCents), kind });
      if (mounted.current) setState({ phase: 'done', txnId, result, error: null });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Pont TPE injoignable';
      const result: BridgePaymentResult = { status: 'error', duration_ms: 0 };
      if (mounted.current) setState({ phase: 'done', txnId, result, error: message });
      return result;
    } finally {
      unsubscribe();
    }
  }, []);

  const cancel = useCallback(async () => {
    const txnId = txnRef.current;
    if (!txnId) return false;
    try {
      const r = await bridge.cancelPayment(txnId);
      return r.ok;
    } catch {
      return false;
    }
  }, []);

  const reset = useCallback(() => {
    txnRef.current = null;
    setState(INITIAL);
  }, []);

  return { ...state, pay, cancel, reset };
}
