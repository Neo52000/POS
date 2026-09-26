/**
 * Écran client (second écran) : la caisse diffuse l'état visible par le client sur un
 * `BroadcastChannel` (même origine, même navigateur). Aucune donnée sensible : libellés,
 * quantités, prix, totaux et au plus le nom affiché du client pro.
 */

export interface DisplayLine {
  key: string;
  label: string;
  qty: number;
  unit_price_ttc_cents: number;
  discount_percent: number;
  line_ttc_cents: number;
}

export type DisplayMessage =
  | { type: 'idle' }
  | {
      type: 'cart';
      lines: DisplayLine[];
      total_ttc_cents: number;
      global_discount_percent: number;
      customer_name: string | null;
    }
  | { type: 'payment'; total_ttc_cents: number; paid_cents: number; remaining_cents: number }
  | { type: 'sale_completed'; total_ttc_cents: number; change_cents: number; ticket_code: string }
  | { type: 'hello' };

export const DISPLAY_CHANNEL = 'pos-display';

let channel: BroadcastChannel | null = null;
let last: DisplayMessage = { type: 'idle' };

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) {
    channel = new BroadcastChannel(DISPLAY_CHANNEL);
    // Écran ouvert en cours de vente : on lui renvoie le dernier état connu.
    channel.addEventListener('message', (e: MessageEvent<DisplayMessage>) => {
      if (e.data?.type === 'hello') channel?.postMessage(last);
    });
  }
  return channel;
}

/** Côté caisse : diffuse un état (dédoublonné) et le mémorise pour les écrans qui arrivent. */
export function publishDisplay(msg: DisplayMessage): void {
  if (JSON.stringify(msg) === JSON.stringify(last)) return;
  last = msg;
  try {
    getChannel()?.postMessage(msg);
  } catch {
    // canal fermé (onglet en cours de déchargement) : ignoré
  }
}

/** Côté écran client : écoute la caisse et demande l'état courant. */
export function subscribeDisplay(onMessage: (msg: DisplayMessage) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const ch = new BroadcastChannel(DISPLAY_CHANNEL);
  ch.addEventListener('message', (e: MessageEvent<DisplayMessage>) => {
    if (e.data && e.data.type !== 'hello') onMessage(e.data);
  });
  ch.postMessage({ type: 'hello' } satisfies DisplayMessage);
  return () => ch.close();
}

/** Tests : réinitialise l'état mémorisé et le canal. */
export function resetDisplayForTests(): void {
  channel?.close();
  channel = null;
  last = { type: 'idle' };
}
