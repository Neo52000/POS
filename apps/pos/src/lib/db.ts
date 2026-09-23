import Dexie from 'dexie';
import type { EntityTable } from 'dexie';
import type { CheckoutPayload, TicketPayload } from '@pos/core';

/** Dernier tickets (réimpression rapide, aperçu). */
export interface StoredReceipt {
  id?: number;
  transaction_id: string;
  ticket_code: string;
  ticket: TicketPayload;
  created_at: string;
}

export type QueueStatus = 'pending' | 'replaying' | 'done' | 'failed';

/**
 * File des ventes à rejouer (lot 4 hors ligne). Aujourd'hui : uniquement les ventes dont le
 * paiement CB a été approuvé mais dont l'enregistrement serveur a échoué (aucun rejeu automatique).
 */
export interface QueuedCheckout {
  client_txn_id: string;
  local_seq?: number;
  payload: CheckoutPayload;
  status: QueueStatus;
  created_at: string;
  last_error?: string;
  attempts?: number;
}

export class PosDb extends Dexie {
  receipts!: EntityTable<StoredReceipt, 'id'>;
  queue!: EntityTable<QueuedCheckout, 'local_seq'>;

  constructor(name = 'ma-papeterie-pos') {
    super(name);
    this.version(1).stores({
      receipts: '++id, transaction_id, ticket_code, created_at',
      queue: '++local_seq, &client_txn_id, status, created_at',
    });
  }
}

export const db = new PosDb();

const MAX_RECEIPTS = 100;

export async function saveReceipt(transactionId: string, ticket: TicketPayload): Promise<void> {
  await db.receipts.add({
    transaction_id: transactionId,
    ticket_code: ticket.ticket_code,
    ticket,
    created_at: new Date().toISOString(),
  });
  const count = await db.receipts.count();
  if (count > MAX_RECEIPTS) {
    const oldest = await db.receipts
      .orderBy('id')
      .limit(count - MAX_RECEIPTS)
      .primaryKeys();
    await db.receipts.bulkDelete(oldest);
  }
}

export async function lastReceipts(limit = 20): Promise<StoredReceipt[]> {
  return db.receipts.orderBy('id').reverse().limit(limit).toArray();
}

export async function enqueueCheckout(payload: CheckoutPayload, error?: string): Promise<void> {
  const existing = await db.queue.where('client_txn_id').equals(payload.client_txn_id).first();
  if (existing) return;
  await db.queue.add({
    client_txn_id: payload.client_txn_id,
    payload,
    status: 'pending',
    created_at: new Date().toISOString(),
    last_error: error,
    attempts: 0,
  });
}

export async function pendingQueue(): Promise<QueuedCheckout[]> {
  return db.queue.where('status').equals('pending').sortBy('local_seq');
}
