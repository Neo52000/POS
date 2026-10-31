import type { CheckoutPayload, TicketPayload } from '@pos/core';
import { ApiError } from '@/lib/apiError';
import { isOffline } from '@/lib/connectivity';
import { logEvent, logEventNow } from '@/lib/events';
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
 * Entrée en mode formation, réservée à un administrateur (0.4.0) : contrôle local, puis
 * `training_mode_start` enregistré au JET **avant** l'activation (le serveur refuse un
 * non-administrateur : FORBIDDEN_ROLE). En ligne obligatoire. L'entrée, la sortie et chaque vente
 * de formation (`training_sale`) sont journalisées : preuve que les tickets « FORMATION »
 * imprimés n'ont aucune valeur.
 */
export async function startTraining(opts: { isAdmin: boolean }): Promise<void> {
  if (!opts.isAdmin) {
    throw new ApiError('FORBIDDEN_ROLE', 'Mode formation réservé à un administrateur');
  }
  const blocker = trainingSwitchBlocker();
  if (blocker) throw new Error(blocker);
  if (isOffline()) {
    throw new ApiError('OFFLINE_FORBIDDEN', 'Mode formation : activation impossible hors ligne');
  }
  const user = useSessionStore.getState().user;
  await logEventNow('training_mode_start', { user_email: user?.email ?? null });
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
  // 0.4.0 : vente de formation tracée au JET (lignes, total, horodatage, drapeau formation), sans
  // numéro ni ticket fiscal ; `logEvent` ajoute `training: true` et met en file hors ligne.
  void logEvent('training_sale', trainingSaleEvent(payload, ticket));
  return ticket;
}

/** Payload JET `training_sale` : aucune donnée fiscale (ni numéro, ni empreinte, ni transaction). */
export function trainingSaleEvent(
  payload: CheckoutPayload,
  ticket: TicketPayload,
): Record<string, unknown> {
  return {
    training: true,
    training_code: ticket.ticket_code,
    kind: payload.kind,
    business_at: payload.business_at,
    lines: ticket.lines.map((l) => ({
      label: l.label,
      qty: l.qty,
      unit_price_ttc_cents: l.unit_price_ttc_cents,
      discount_percent: l.discount_percent,
      line_ttc_cents: l.line_ttc_cents,
      vat_rate: l.vat_rate,
    })),
    total_ttc_cents: ticket.total_ttc_cents,
    payments: ticket.payments.map((p) => ({ method: p.method, amount_cents: p.amount_cents })),
  };
}
