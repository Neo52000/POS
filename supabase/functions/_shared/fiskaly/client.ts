import {
  FISKALY_PATHS,
  FiskalyError,
  type FiskalyClient,
  type FiskalyClosingRef,
  type FiskalyRegister,
  type FiskalySignature,
  type TransactionForSigning,
} from './types.ts';

interface AuthToken {
  access_token: string;
  expires_at: number; // epoch ms
}

const REQUEST_TIMEOUT_MS = 8_000;

/** Convertit un montant en centimes vers une chaîne décimale "12.34" (format attendu par Fiskaly). */
function cents(n: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const PAYMENT_TYPE_MAP: Record<string, string> = {
  cb: 'CARD',
  cash: 'CASH',
  cheque: 'CHEQUE',
  gift_ucia: 'VOUCHER',
  transfer: 'TRANSFER',
};

/**
 * Client HTTP Fiskaly SIGN FR. Les chemins et corps JSON suivent la structure documentée
 * publiquement (System → Record TRANSACTION/RECEIPT) et sont à confirmer sur la doc officielle.
 */
export class LiveFiskalyClient implements FiskalyClient {
  readonly mode = 'live' as const;
  private token: AuthToken | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    withAuth = true,
  ): Promise<T> {
    if (withAuth) await this.auth();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(withAuth && this.token ? { Authorization: `Bearer ${this.token.access_token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // corps non JSON conservé brut
      }
      if (!res.ok) throw new FiskalyError(`Fiskaly ${method} ${path} → ${res.status}`, res.status, parsed);
      return parsed as T;
    } catch (e) {
      if (e instanceof FiskalyError) throw e;
      throw new FiskalyError(`Fiskaly ${method} ${path} : ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async auth(): Promise<void> {
    if (this.token && this.token.expires_at - Date.now() > 60_000) return;
    const data = await this.request<{ access_token: string; access_token_expires_in?: number }>(
      'POST',
      FISKALY_PATHS.auth,
      { api_key: this.apiKey, api_secret: this.apiSecret },
      false,
    );
    const ttl = (data.access_token_expires_in ?? 23 * 3600) * 1000;
    this.token = { access_token: data.access_token, expires_at: Date.now() + ttl };
  }

  async commissionSystem(register: FiskalyRegister): Promise<string> {
    const systemId = register.fiskaly_system_id ?? crypto.randomUUID();
    await this.request('PUT', FISKALY_PATHS.system(systemId), {
      metadata: { register_code: register.code, label: register.label ?? register.code },
    });
    await this.request('PATCH', FISKALY_PATHS.system(systemId), { state: 'COMMISSIONED' });
    return systemId;
  }

  async createTransactionRecord(
    systemId: string,
    tx: TransactionForSigning,
  ): Promise<FiskalySignature> {
    const recordId = crypto.randomUUID();
    // Appel 1 : intention de démarrer la transaction.
    await this.request('PUT', FISKALY_PATHS.record(systemId, recordId), {
      type: 'TRANSACTION',
      state: 'ACTIVE',
      metadata: { ticket_code: tx.ticket_code, pos_hash: tx.hash },
    });
    // Appel 2 : données de la transaction (opération RECEIPT).
    const finished = await this.request<Record<string, unknown>>(
      'PUT',
      FISKALY_PATHS.record(systemId, recordId),
      {
        type: 'TRANSACTION',
        state: 'FINISHED',
        operation: {
          type: 'RECEIPT',
          document: {
            number: tx.ticket_code,
            date: tx.business_at,
            kind: tx.kind === 'refund' ? 'CREDIT_NOTE' : 'SALE',
            amount_including_vat: cents(tx.total_ttc_cents),
            amount_excluding_vat: cents(tx.total_ht_cents),
            vat_amount: cents(tx.total_vat_cents),
          },
          vat_breakdown: tx.vat_breakdown.map((v) => ({
            rate: v.rate,
            amount_excluding_vat: cents(v.base_ht_cents),
            vat_amount: cents(v.vat_cents),
            amount_including_vat: cents(v.ttc_cents),
          })),
          items: tx.lines.map((l) => ({
            number: l.line_no,
            description: l.label,
            quantity: String(l.qty),
            unit_price_including_vat: cents(l.unit_price_ttc_cents),
            discount_percent: String(l.discount_percent),
            vat_rate: String(l.vat_rate),
            amount_including_vat: cents(l.line_ttc_cents),
            amount_excluding_vat: cents(l.line_ht_cents),
          })),
          payments: tx.payments.map((p) => ({
            type: PAYMENT_TYPE_MAP[p.method] ?? 'OTHER',
            amount: cents(p.amount_cents),
            reference: p.reference ?? undefined,
          })),
          customer: tx.customer_snapshot ?? undefined,
        },
        metadata: { pos_hash: tx.hash, pos_prev_hash: tx.prev_hash ?? '' },
      },
    );
    const sig = finished.signature as { value?: string } | string | undefined;
    const signature = typeof sig === 'string' ? sig : (sig?.value ?? '');
    const signedAt = (finished.time_end as string | undefined) ?? new Date().toISOString();
    if (!signature) throw new FiskalyError('Réponse Fiskaly sans signature', 502, finished);
    return { record_id: recordId, signature, signed_at: signedAt, raw: finished };
  }

  getRecord(systemId: string, recordId: string): Promise<unknown> {
    return this.request('GET', FISKALY_PATHS.record(systemId, recordId));
  }

  async listClosings(systemId: string, from: string, to: string): Promise<FiskalyClosingRef[]> {
    const data = await this.request<{ data?: Array<Record<string, unknown>> }>(
      'GET',
      `${FISKALY_PATHS.closings(systemId)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    return (data.data ?? []).map((c) => ({
      closing_id: String(c._id ?? c.id ?? ''),
      period_type: (String(c.type ?? 'daily').toLowerCase() as FiskalyClosingRef['period_type']),
      period_start: String(c.period_start ?? c.time_start ?? ''),
      period_end: String(c.period_end ?? c.time_end ?? ''),
      raw: c,
    }));
  }
}
