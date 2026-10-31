import type { CheckoutPayload, CheckoutResult } from '@pos/core';
import { env } from '@/lib/env';
import { getAccessToken } from '@/lib/supabase';
import { ApiError, ERROR_MESSAGES, isNetworkError } from '@/lib/apiError';
import type { ApiErrorCode } from '@/lib/apiError';
import { reportNetworkFailure } from '@/lib/connectivity';

export { ApiError, describeApiError, isApiError, isNetworkError } from '@/lib/apiError';
export type { ApiErrorCode } from '@/lib/apiError';
import type {
  ClosePeriodResult,
  CustomerOpenDocuments,
  CustomerQuote,
  ExportArchiveResult,
  PassageContact,
  PosCustomer,
  PosPayment,
  PosTransaction,
  PosTransactionLine,
  ResolvedPrice,
  StockAdjustInput,
  StockAdjustResult,
} from '@/types/pos';

export type PosCheckoutResult = CheckoutResult<PosTransaction, PosTransactionLine, PosPayment>;

export interface PriceLineInput {
  product_id: string;
  qty: number;
}

export type ReceiptChannel = 'email' | 'sms';

export interface SendReceiptInput {
  transaction_id: string;
  channel: ReceiptChannel;
  /** Adresse e-mail ou numéro de mobile (normalisé côté serveur). */
  to: string;
}

export interface EdgeClient {
  checkout(payload: CheckoutPayload): Promise<PosCheckoutResult>;
  customerSearch(q: string, limit?: number): Promise<PosCustomer[]>;
  customerQuotes(accountId: string): Promise<CustomerQuote[]>;
  /**
   * Commandes (partie non livrée) et BL (lignes livrées) non réglés du client pro, ou de la
   * personne de passage si `passageContactId` (`pos-customer-orders`, `documents: true`).
   */
  customerDocuments(
    accountId: string,
    passageContactId?: string | null,
  ): Promise<CustomerOpenDocuments>;
  /** Personnes de passage par nom ou téléphone (`pos-passage-contacts`, action `search`). */
  passageSearch(q: string, limit?: number): Promise<PassageContact[]>;
  /** Crée (ou retrouve par téléphone) une personne de passage (`pos-passage-contacts`). */
  passageCreate(fullName: string, phone: string | null): Promise<PassageContact>;
  /** Tarifs pro (`pos-resolve-prices`) : `{account_id, lines}` → `{prices}`. */
  resolvePrices(accountId: string, lines: PriceLineInput[]): Promise<ResolvedPrice[]>;
  /** Archive NF525 (`pos-export-archive`, admin) : défaut = mois précédent, toutes caisses. */
  exportArchive(input: {
    register_id?: string;
    period_start?: string;
  }): Promise<ExportArchiveResult>;
  /** Inventaire (`pos-stock-adjust`, admin) : ≤ 200 lignes par appel, idempotent par ligne. */
  stockAdjust(input: StockAdjustInput): Promise<StockAdjustResult>;
  /**
   * Clôture Z2 / Z3 (`pos-closing`) de la caisse : sans `period_start`, période précédente
   * (mois ou année écoulés, Europe/Paris). Idempotent (`already_exists`).
   */
  closePeriod(input: {
    register_id: string;
    period_type: 'monthly' | 'annual';
    period_start?: string;
  }): Promise<ClosePeriodResult>;
  /** Ticket dématérialisé (`pos-send-receipt`) : e-mail ou SMS via Brevo, contenu relu en base. */
  sendReceipt(input: SendReceiptInput): Promise<{ ok: true; ticket_code: string }>;
}

const EDGE_TIMEOUT_MS = 30_000;

/** Appel générique d'une Edge Function avec le JWT vendeur (SPEC §9). */
export async function callEdge<T>(
  name: string,
  body: unknown,
  timeoutMs = EDGE_TIMEOUT_MS,
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new ApiError('UNAUTHORIZED', 'Non connecté', undefined, 401);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${env.supabaseUrl}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        apikey: env.supabaseAnonKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    throw new ApiError(aborted ? 'TIMEOUT' : 'NETWORK', undefined, e);
  }
  clearTimeout(timer);
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)
      ?.error;
    const code = (err?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : 'INTERNAL')) as ApiErrorCode;
    throw new ApiError(
      code in ERROR_MESSAGES ? code : 'INTERNAL',
      err?.message,
      err?.details,
      res.status,
    );
  }
  return json as T;
}

function createRealEdge(): EdgeClient {
  return {
    checkout: (payload) => callEdge<PosCheckoutResult>('pos-checkout', payload),
    customerSearch: async (q, limit = 10) => {
      const r = await callEdge<{ customers: PosCustomer[] }>('pos-customer-search', { q, limit });
      return r.customers ?? [];
    },
    customerQuotes: async (account_id) => {
      const r = await callEdge<{ quotes: CustomerQuote[] }>('pos-customer-quotes', { account_id });
      return r.quotes ?? [];
    },
    customerDocuments: async (account_id, passageContactId) => {
      const r = await callEdge<{ documents?: CustomerOpenDocuments }>(
        'pos-customer-orders',
        passageContactId
          ? { passage_contact_id: passageContactId, documents: true }
          : { account_id, documents: true },
      );
      // Fonction serveur antérieure (sans `documents`) : rien de réglable à la ligne.
      if (!r.documents) {
        throw new Error('Fonctions caisse à mettre à jour (commandes et BL indisponibles)');
      }
      return r.documents;
    },
    passageSearch: async (q, limit = 10) => {
      const r = await callEdge<{ contacts: PassageContact[] }>('pos-passage-contacts', {
        action: 'search',
        q,
        limit,
      });
      return r.contacts ?? [];
    },
    passageCreate: async (full_name, phone) => {
      const r = await callEdge<{ contact: PassageContact }>('pos-passage-contacts', {
        action: 'create',
        full_name,
        phone,
      });
      return r.contact;
    },
    resolvePrices: async (account_id, lines) => {
      if (lines.length === 0) return [];
      const r = await callEdge<{ prices: ResolvedPrice[] }>('pos-resolve-prices', {
        account_id,
        lines,
      });
      return r.prices ?? [];
    },
    exportArchive: (input) => callEdge<ExportArchiveResult>('pos-export-archive', input, 120_000),
    stockAdjust: (input) => callEdge<StockAdjustResult>('pos-stock-adjust', input),
    closePeriod: (input) => callEdge<ClosePeriodResult>('pos-closing', input, 60_000),
    sendReceipt: (input) =>
      callEdge<{ ok: true; ticket_code: string }>('pos-send-receipt', input, 20_000),
  };
}

/** Toute erreur NETWORK/TIMEOUT d'une Edge Function fait basculer la caisse hors ligne. */
function withConnectivity(client: EdgeClient): EdgeClient {
  const wrapped = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(client) as Array<
    [string, (...args: unknown[]) => Promise<unknown>]
  >) {
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (e) {
        if (isNetworkError(e)) reportNetworkFailure(`edge:${name}`);
        throw e;
      }
    };
  }
  return wrapped as unknown as EdgeClient;
}

async function buildEdge(): Promise<EdgeClient> {
  if (env.e2eMock) {
    const { createMockEdge } = await import('./mocks/mockEdge');
    return withConnectivity(createMockEdge());
  }
  return withConnectivity(createRealEdge());
}

export const edge: EdgeClient = await buildEdge();
