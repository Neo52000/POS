import type { CheckoutPayload, TicketPayload } from '@pos/core';
import { logEvent } from '@/lib/events';
import { buildProvisionalTicket } from '@/lib/ticket';
import type { ProvisionalTicketContext } from '@/lib/ticket';
import { useCartStore } from '@/stores/cartStore';
import { useCheckoutDraftStore } from '@/stores/checkoutDraftStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useParkedStore } from '@/stores/parkedStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useTrainingStore } from '@/stores/trainingStore';

/** Raison pour laquelle le mode ne peut pas changer maintenant (`null` : possible). */
export function trainingSwitchBlocker(): string | null {
  if (useCartStore.getState().lines.length > 0) {
    return 'Le panier contient des articles : encaissez ou videz-le avant de changer de mode.';
  }
  if (useCheckoutDraftStore.getState().draft) {
    return 'Un encaissement est interrompu : reprenez-le ou abandonnez-le avant de changer de mode.';
  }
  return null;
}

/**
 * Entrée en mode formation. L'entrée et la sortie sont les seuls événements journalisés au JET
 * (preuve que les tickets « FORMATION » imprimés entre les deux n'ont aucune valeur).
 */
export function startTraining(): void {
  const blocker = trainingSwitchBlocker();
  if (blocker) throw new Error(blocker);
  const user = useSessionStore.getState().user;
  void logEvent('training_mode_start', { user_email: user?.email ?? null });
  const parked = useParkedStore.getState().parked;
  useParkedStore.setState({ parked: [] });
  useTrainingStore.getState().begin(user?.email ?? null, parked);
}

/**
 * Sortie : panier, encaissement interrompu et tickets de formation effacés (aucun argent réel :
 * le TPE était simulé), tickets en attente réels restaurés.
 */
export function stopTraining(): void {
  const { tickets, startedAt } = useTrainingStore.getState();
  // Encore en formation : ces effacements ne sont pas journalisés.
  useCheckoutDraftStore.getState().discard();
  useCartStore.getState().clear('training_exit');
  useCustomerStore.getState().detach();
  const stashed = useTrainingStore.getState().end();
  useParkedStore.setState({ parked: stashed });
  void logEvent('training_mode_end', {
    started_at: startedAt,
    tickets: tickets.length,
    total_ttc_cents: tickets.reduce((s, t) => s + t.total_ttc_cents, 0),
  });
}

/**
 * Ticket de formation : mêmes calculs que le serveur (`computeCart`), numéro `FORM-nnnn`, sans
 * empreinte ni signature, marqué `compliance.training` (imprimé « FORMATION »). Jamais envoyé.
 */
export function buildTrainingTicket(
  payload: CheckoutPayload,
  context: ProvisionalTicketContext,
): TicketPayload {
  const store = useTrainingStore.getState();
  const base = buildProvisionalTicket(payload, context);
  const ticket: TicketPayload = {
    ...base,
    ticket_code: store.nextCode(),
    compliance: {
      hash_short: '',
      signature_status: 'mock',
      software: base.compliance.software,
      version: base.compliance.version,
      training: true,
    },
  };
  store.addTicket(ticket);
  return ticket;
}
