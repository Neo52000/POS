/** Hub de diffusion des événements WebSocket (`WS /events`, SPEC §8). */
import type { PaymentPhase, PaymentResult } from './caisseap/client.js';

export interface PaymentEvent {
  type: 'payment';
  txn_id: string;
  phase: PaymentPhase;
  result?: PaymentResult;
  detail?: Record<string, unknown>;
}

export type BridgeEvent = PaymentEvent;

/** Sous-ensemble de `ws.WebSocket` utilisé (permet des doublures en test). */
export interface EventSocket {
  readyState: number;
  send(data: string): void;
}

const OPEN = 1;

export class EventHub {
  private readonly sockets = new Set<EventSocket>();

  add(socket: EventSocket): () => void {
    this.sockets.add(socket);
    return () => this.sockets.delete(socket);
  }

  get size(): number {
    return this.sockets.size;
  }

  broadcast(event: BridgeEvent): void {
    const data = JSON.stringify(event);
    for (const socket of this.sockets) {
      if (socket.readyState !== OPEN) {
        this.sockets.delete(socket);
        continue;
      }
      try {
        socket.send(data);
      } catch {
        this.sockets.delete(socket);
      }
    }
  }
}
