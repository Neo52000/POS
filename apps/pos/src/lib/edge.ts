import type { CheckoutPayload, CheckoutResult } from '@pos/core';
import { env } from '@/lib/env';
import { getAccessToken } from '@/lib/supabase';
import { ApiError, ERROR_MESSAGES, isNetworkError } from '@/lib/apiError';
import type { ApiErrorCode } from '@/lib/apiError';
import { reportNetworkFailure } from '@/lib/connectivity';

export { ApiError, describeApiError, isApiError, isNetworkError } from '@/lib/apiError';
export type { ApiErrorCode } from '@/lib/apiError';
import type {
  CustomerQuote,
  ExportArchiveResult,
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

export interface EdgeClient {
  checkout(payload: CheckoutPayload): Promise<PosCheckoutResult>;
  customerSearch(q: string, limit?: number): Promise<PosCustomer[]>;
  customerQuotes(accountId: string): Promise<CustomerQuote[]>;
  /** Tarifs pro (`pos-resolve-prices`) : `{account_id, lines}` → `{prices}`. */
  resolvePrices(accountId: string, lines: PriceLineInput[]): Promise<ResolvedPrice[]>;
  /** Archive NF525 (`pos-export-archive`, admin) : défaut = mois précédent, toutes caisses. */
  exportArchive(input: {
    register_id?: string;
    period_start?: string;
  }): Promise<ExportArchiveResult>;
  /** Inventaire (`pos-stock-adjust`, admin) : ≤ 200 lignes par appel, idempotent par ligne. */
  stockAdjust(input: StockAdjustInput): Promise<StockAdjustResult>;
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
