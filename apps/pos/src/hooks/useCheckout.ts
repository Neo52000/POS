import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CheckoutPayload, TicketPayload } from '@pos/core';
import { ApiError, describeApiError, isNetworkError } from '@/lib/apiError';
import { isOffline } from '@/lib/connectivity';
import { saveReceipt } from '@/lib/db';
import { edge } from '@/lib/edge';
import type { PosCheckoutResult } from '@/lib/edge';
import { enqueueSale, queueOfflineSale } from '@/lib/offlineQueue';
import type { ProvisionalTicketContext } from '@/lib/ticket';
import { TODAY_TICKETS_KEY } from './useTodayTickets';

function hasCapturedCb(payload: CheckoutPayload): boolean {
  return payload.payments.some((p) => p.method === 'cb' && p.manual_fallback !== true);
}

export interface CheckoutRequest {
  payload: CheckoutPayload;
  /** Contexte du ticket provisoire (utilisé seulement si la vente part en file hors ligne). */
  context: ProvisionalTicketContext;
}

export type CheckoutOutcome =
  | { status: 'recorded'; result: PosCheckoutResult; ticket: TicketPayload }
  | {
      status: 'queued';
      ticket: TicketPayload;
      provisionalRef: string;
      /** `offline` : caisse déjà hors ligne ; `network` : échec réseau pendant l'envoi. */
      reason: 'offline' | 'network';
    };

/**
 * Envoi d'une vente / d'un remboursement à `pos-checkout`.
 * - Hors ligne : la vente part en file (`offline_queued: true`, référence `OFF-…`), ticket provisoire.
 * - En ligne, échec NETWORK/TIMEOUT : bascule hors ligne et même traitement (même `client_txn_id`,
 *   `business_at` inchangé) ; le rejeu est idempotent côté serveur.
 * - Remboursement : jamais hors ligne (refus serveur). Seul cas mis en file : remboursement CB déjà
 *   crédité par le TPE puis échec réseau (`QUEUED_AFTER_CB`).
 * Les limites hors ligne sont ignorées si une CB a déjà été débitée (la vente doit être tracée).
 */
export async function submitCheckout({
  payload,
  context,
}: CheckoutRequest): Promise<CheckoutOutcome> {
  const captured = hasCapturedCb(payload);
  if (isOffline()) {
    if (payload.kind === 'refund') {
      throw new ApiError('OFFLINE_FORBIDDEN', 'Remboursement impossible hors ligne');
    }
    const q = await queueOfflineSale(payload, context, { force: captured });
    return {
      status: 'queued',
      ticket: q.ticket,
      provisionalRef: q.provisionalRef,
      reason: 'offline',
    };
  }
  try {
    const result = await edge.checkout(payload);
    void saveReceipt(result.transaction.id, result.ticket).catch(() => undefined);
    return { status: 'recorded', result, ticket: result.ticket };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    if (payload.kind === 'refund') {
      if (!captured) throw e;
      await enqueueSale(payload, { error: describeApiError(e) });
      throw new ApiError('QUEUED_AFTER_CB', undefined, { client_txn_id: payload.client_txn_id });
    }
    const q = await queueOfflineSale(payload, context, {
      force: captured,
      error: describeApiError(e),
    });
    return {
      status: 'queued',
      ticket: q.ticket,
      provisionalRef: q.provisionalRef,
      reason: 'network',
    };
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
