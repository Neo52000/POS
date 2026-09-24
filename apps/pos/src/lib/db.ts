import Dexie from 'dexie';
import type { EntityTable } from 'dexie';
import type { CheckoutPayload, TicketPayload } from '@pos/core';
import type { PosEventType, PosProduct } from '@/types/pos';

/** Derniers tickets (réimpression rapide, aperçu). */
export interface StoredReceipt {
  id?: number;
  /** Id serveur de la transaction, ou `client_txn_id` tant que la vente est en file. */
  transaction_id: string;
  ticket_code: string;
  ticket: TicketPayload;
  created_at: string;
}

/**
 * `abandoned` : élément en échec abandonné par un admin après journalisation JET
 * (`offline_sale_abandoned`, payload complet) ; conservé localement, exclu des compteurs et du Z.
 */
export type QueueStatus = 'pending' | 'replaying' | 'done' | 'failed' | 'abandoned';

/**
 * File des ventes à rejouer (lot 4 hors ligne) : ventes encaissées hors ligne (ticket provisoire
 * `OFF-…`) ou dont l'enregistrement a échoué pour cause réseau. Rejeu FIFO par `local_seq`.
 */
export interface QueuedCheckout {
  local_seq?: number;
  client_txn_id: string;
  payload: CheckoutPayload;
  status: QueueStatus;
  created_at: string;
  updated_at?: string;
  /** Horodatage métier de la vente (= `payload.business_at`, jamais modifié au rejeu). */
  business_at: string;
  provisional_ref: string | null;
  /** Ticket provisoire imprimé (réimpression depuis /offline). */
  provisional_ticket?: TicketPayload | null;
  attempts: number;
  last_error?: string | null;
  last_error_code?: string | null;
  last_attempt_at?: string | null;
  /** Ticket définitif `T-YYYY-NNNNNN` attribué au rejeu. */
  server_ticket_code?: string | null;
  server_transaction_id?: string | null;
  abandoned_at?: string | null;
  abandon_reason?: string | null;
  done_at?: string | null;
}

/** Produit du catalogue local (recherche hors ligne). `data` = projection complète. */
export interface LocalProduct {
  id: string;
  /** Index unique : absent si l'EAN est déjà porté par un autre produit local. */
  ean?: string;
  tokens: string[];
  updated_at: string;
  data: PosProduct;
}

export type QueuedEventStatus = 'pending' | 'failed';

/** Événement JET (`pos_log_event`) en attente d'envoi, rejoué en FIFO avec son `client_at`. */
export interface QueuedEvent {
  local_seq?: number;
  event_type: PosEventType;
  payload: Record<string, unknown>;
  client_at: string;
  register_id: string | null;
  session_id: string | null;
  status: QueuedEventStatus;
  attempts: number;
  last_error?: string | null;
  created_at: string;
}

export interface MetaRow {
  key: string;
  value: unknown;
}

export type InventoryLineStatus = 'pending' | 'error';

/** Ligne du lot d'inventaire en cours (lot 6), conservée jusqu'à confirmation serveur. */
export interface InventoryLine {
  /** Clé d'idempotence (uuid) générée une fois et conservée jusqu'à confirmation. */
  idempotency_key: string;
  product_id: string;
  label: string;
  ean: string | null;
  /** Stock boutique affiché au moment du comptage. */
  stock_seen: number;
  counted: number;
  added_at: string;
  status: InventoryLineStatus;
  error?: string | null;
}

export class PosDb extends Dexie {
  receipts!: EntityTable<StoredReceipt, 'id'>;
  queue!: EntityTable<QueuedCheckout, 'local_seq'>;
  products!: EntityTable<LocalProduct, 'id'>;
  events!: EntityTable<QueuedEvent, 'local_seq'>;
  meta!: EntityTable<MetaRow, 'key'>;
  inventory!: EntityTable<InventoryLine, 'idempotency_key'>;

  constructor(name = 'ma-papeterie-pos') {
    super(name);
    this.version(1).stores({
      receipts: '++id, transaction_id, ticket_code, created_at',
      queue: '++local_seq, &client_txn_id, status, created_at',
    });
    this.version(2)
      .stores({
        receipts: '++id, transaction_id, ticket_code, created_at',
        queue: '++local_seq, &client_txn_id, status, created_at',
        products: 'id, &ean, *tokens, updated_at',
        events: '++local_seq, status, created_at',
        meta: 'key',
        inventory: 'idempotency_key, &product_id, added_at',
      })
      .upgrade(async (tx) => {
        // v1 → v2 : complète les éléments de file existants (ventes CB mises en attente).
        await tx
          .table<QueuedCheckout, number>('queue')
          .toCollection()
          .modify((item) => {
            item.business_at = item.business_at ?? item.payload.business_at;
            item.provisional_ref = item.provisional_ref ?? item.payload.provisional_ref ?? null;
            item.attempts = item.attempts ?? 0;
            item.last_error_code = item.last_error_code ?? null;
            item.server_ticket_code = item.server_ticket_code ?? null;
          });
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

/** Remplace le ticket provisoire enregistré (clé `client_txn_id`) par le ticket définitif. */
export async function replaceReceipt(
  previousTransactionId: string,
  transactionId: string,
  ticket: TicketPayload,
): Promise<void> {
  const n = await db.receipts
    .where('transaction_id')
    .equals(previousTransactionId)
    .modify({ transaction_id: transactionId, ticket_code: ticket.ticket_code, ticket });
  if (n === 0) await saveReceipt(transactionId, ticket);
}

export async function lastReceipts(limit = 20): Promise<StoredReceipt[]> {
  return db.receipts.orderBy('id').reverse().limit(limit).toArray();
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

/** Vide toutes les tables (tests). */
export async function clearDb(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
}
