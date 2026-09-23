import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CheckoutPayload } from '@pos/core';
import { enqueueCheckout, saveReceipt } from '@/lib/db';
import { ApiError, edge, isNetworkError } from '@/lib/edge';
import type { PosCheckoutResult } from '@/lib/edge';
import { TODAY_TICKETS_KEY } from './useTodayTickets';

function hasCapturedCb(payload: CheckoutPayload): boolean {
  return payload.payments.some((p) => p.method === 'cb' && p.manual_fallback !== true);
}

/**
 * Envoi d'une vente / d'un remboursement à `pos-checkout`.
 * Si le réseau tombe APRÈS un paiement CB approuvé par le TPE, la vente est mise en file
 * locale (Dexie `queue`) et l'erreur `QUEUED_AFTER_CB` est renvoyée : pas de rejeu automatique
 * (lot 4), pas de double débit (idempotence par `client_txn_id`).
 */
export async function submitCheckout(payload: CheckoutPayload): Promise<PosCheckoutResult> {
  try {
    const result = await edge.checkout(payload);
    void saveReceipt(result.transaction.id, result.ticket).catch(() => undefined);
    return result;
  } catch (e) {
    if (isNetworkError(e) && hasCapturedCb(payload)) {
      await enqueueCheckout(payload, e instanceof Error ? e.message : String(e));
      throw new ApiError('QUEUED_AFTER_CB', undefined, { client_txn_id: payload.client_txn_id });
    }
    throw e;
  }
}

export function useCheckout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: submitCheckout,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: TODAY_TICKETS_KEY });
      void qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}
