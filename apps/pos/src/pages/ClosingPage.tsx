import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, LockKeyhole, Printer, Unlock, WifiOff } from 'lucide-react';
import { parseEuroToCents } from '@pos/core';
import type { TicketPayload } from '@pos/core';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumPad } from '@/components/ui/numpad';
import { CashCountGrid, cashCountTotal } from '@/components/session/CashCountGrid';
import type { CashCounts } from '@/components/session/CashCountGrid';
import { ReceiptPreview } from '@/components/ticket/ReceiptPreview';
import { usePrinter } from '@/hooks/usePrinter';
import { updateCachedSession, useSession } from '@/hooks/useSession';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { useTodayTickets } from '@/hooks/useTodayTickets';
import { describeApiError } from '@/lib/edge';
import { env } from '@/lib/env';
import { formatDateTime, formatEurCents, formatVatRate } from '@/lib/format';
import { replayQueue } from '@/lib/offlineQueue';
import { rpc } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useCartStore } from '@/stores/cartStore';
import { draftCapturedCents, useCheckoutDraftStore } from '@/stores/checkoutDraftStore';
import { useParkedStore } from '@/stores/parkedStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { CloseSessionResult, PosClosing, PosRegister, PosSession } from '@/types/pos';

const PAYMENT_LABELS: Record<string, string> = {
  cb: 'Carte bancaire',
  cash: 'Espèces',
  cheque: 'Chèque',
  gift_ucia: 'Bon cadeau UCIA',
  transfer: 'Virement',
};

/** Normalise `payments_breakdown` (objet `{method: cents}` ou tableau `[{method, amount_cents}]`). */
export function normalizePaymentsBreakdown(
  raw: unknown,
): Array<{ method: string; amount_cents: number }> {
  if (Array.isArray(raw)) {
    return raw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => ({
        method: String(r['method'] ?? r['key'] ?? '?'),
        amount_cents: Number(r['amount_cents'] ?? r['total_cents'] ?? r['amount'] ?? 0),
      }));
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([method, v]) => ({
      method,
      amount_cents:
        typeof v === 'number'
          ? v
          : Number((v as { amount_cents?: unknown })?.amount_cents ?? v ?? 0),
    }));
  }
  return [];
}

/** Ticket « Z » imprimable via le pont (mêmes 42 colonnes que le ticket de vente). */
export function buildClosingTicket(
  closing: PosClosing,
  session: PosSession,
  register: PosRegister | null,
): TicketPayload {
  const payments = normalizePaymentsBreakdown(closing.payments_breakdown);
  const lines: TicketPayload['lines'] = [
    {
      label: `Tickets ${closing.first_ticket_number ?? '-'} à ${closing.last_ticket_number ?? '-'} (${closing.txn_count})`,
      qty: 1,
      unit_price_ttc_cents: closing.total_ttc_cents,
      discount_percent: 0,
      line_ttc_cents: closing.total_ttc_cents,
      vat_rate: '0.00',
    },
    {
      label: 'Remboursements',
      qty: 1,
      unit_price_ttc_cents: closing.refunds_ttc_cents,
      discount_percent: 0,
      line_ttc_cents: closing.refunds_ttc_cents,
      vat_rate: '0.00',
    },
    {
      label: `Fond de caisse ${formatEurCents(session.opening_float_cents)} · compté ${formatEurCents(session.counted_cash_cents ?? 0)}`,
      qty: 1,
      unit_price_ttc_cents: session.variance_cents ?? 0,
      discount_percent: 0,
      line_ttc_cents: session.variance_cents ?? 0,
      vat_rate: '0.00',
    },
  ];
  return {
    version: 1,
    register_code: register?.code ?? '',
    ticket_number: null,
    ticket_code: `Z-${closing.closing_number}`,
    duplicate: false,
    kind: 'sale',
    business_at: closing.period_end || new Date().toISOString(),
    cashier_name: '',
    header: {
      company_name: 'CLÔTURE DE CAISSE (Z)',
      address_lines: [`Session n°${session.session_number}`],
      siret: '',
      vat_number: '',
    },
    lines,
    vat_breakdown: closing.vat_breakdown ?? [],
    total_ht_cents: closing.total_ht_cents,
    total_vat_cents: closing.total_vat_cents,
    total_ttc_cents: closing.total_ttc_cents,
    payments: payments.map((p) => ({
      method: (p.method in PAYMENT_LABELS
        ? p.method
        : 'cash') as TicketPayload['payments'][number]['method'],
      label: PAYMENT_LABELS[p.method] ?? p.method,
      amount_cents: p.amount_cents,
    })),
    change_cents: 0,
    footer: { lines: [`Total perpétuel ${formatEurCents(closing.grand_total_perpetual_cents)}`] },
    compliance: {
      hash_short: String(closing.hash ?? '').slice(0, 8),
      signature_status: 'pending_signature',
      software: 'Ma Papeterie POS',
      version: env.appVersion,
    },
    invoice_requested: false,
  };
}

function OfflineNotice({ action }: { action: string }) {
  return (
    <p
      className="flex items-center gap-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
      data-testid="closing-offline"
    >
      <WifiOff className="h-4 w-4 shrink-0" /> Hors ligne : {action.charAt(0).toLowerCase()}
      {action.slice(1)} est impossible sans connexion au serveur.
    </p>
  );
}

function OpenSession({ register }: { register: PosRegister }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const setSession = useSessionStore((s) => s.setSession);
  const toast = useUiStore((s) => s.toast);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const cents = input === '' ? 0 : parseEuroToCents(input);

  const open = async (): Promise<void> => {
    if (cents === null) return;
    setPending(true);
    try {
      const session = await rpc<PosSession>('pos_open_session', {
        p_register_id: register.id,
        p_opening_float_cents: cents,
      });
      setSession(session);
      updateCachedSession(session);
      await qc.invalidateQueries({ queryKey: ['session'] });
      toast({ title: `Session n°${session.session_number} ouverte`, variant: 'success' });
      // Ventes hors ligne en attente d'une session ouverte (SESSION_NOT_OPEN) : rejeu immédiat.
      useUiStore.getState().setReplayBlock(null);
      void replayQueue();
      navigate('/', { replace: true });
    } catch (e) {
      toast({ title: 'Ouverture impossible', description: describeApiError(e), variant: 'danger' });
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="mx-auto flex w-full max-w-lg flex-col gap-5 rounded-3xl border border-border bg-surface p-8"
      data-testid="open-session"
    >
      <div>
        <h2 className="text-2xl font-semibold">Ouvrir la caisse {register.code}</h2>
        <p className="text-sm text-muted">
          Saisissez le fond de caisse (espèces présentes dans le tiroir).
        </p>
      </div>
      <div className="rounded-2xl border border-border bg-bg p-4 text-center">
        <p className="text-sm text-muted">Fond de caisse</p>
        <p className="text-5xl font-bold tabular" data-testid="opening-float">
          {cents === null ? '—' : formatEurCents(cents)}
        </p>
      </div>
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        inputMode="decimal"
        placeholder="0,00"
        className="text-center text-2xl"
        aria-label="Fond de caisse en euros"
        data-testid="opening-float-input"
      />
      <NumPad
        decimal
        onDigit={(d) => setInput((p) => (d === ',' && p.includes(',') ? p : p + d))}
        onBackspace={() => setInput((p) => p.slice(0, -1))}
      />
      {offline && <OfflineNotice action="L’ouverture de session" />}
      <Button
        size="pay"
        disabled={cents === null || pending || offline}
        onClick={() => void open()}
        data-testid="open-session-button"
      >
        {pending ? <Loader2 className="h-6 w-6 animate-spin" /> : <Unlock className="h-6 w-6" />}{' '}
        Ouvrir la session
      </Button>
    </div>
  );
}

function CloseSession({
  session,
  register,
}: {
  session: PosSession;
  register: PosRegister | null;
}) {
  const qc = useQueryClient();
  const setSession = useSessionStore((s) => s.setSession);
  const toast = useUiStore((s) => s.toast);
  const { print } = usePrinter();
  const tickets = useTodayTickets();
  const cartLines = useCartStore((s) => s.lines.length);
  const [counts, setCounts] = useState<CashCounts>({});
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<CloseSessionResult | null>(null);
  const counted = useMemo(() => cashCountTotal(counts), [counts]);
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const { stats } = useOfflineQueue();
  const queueBlocks = stats.pending > 0 || stats.failed > 0;
  // Encaissement interrompu : de l'argent a pu être perçu (CB débitée, espèces au tiroir) sans
  // ticket. Le Z le figerait dans la mauvaise période et fausserait l'écart de caisse.
  const draft = useCheckoutDraftStore((s) => s.draft);
  const draftCaptured = draftCapturedCents(draft);
  const draftBlocks = draft !== null;
  // Tickets en attente : sans valeur fiscale, ils survivent au Z (simple avertissement).
  const parked = useParkedStore((s) => s.parked);
  const parkedTotal = parked.reduce((sum, p) => sum + p.total_ttc_cents, 0);

  const todaySales = (tickets.data ?? []).filter((t) => t.session_id === session.id);
  const todayTotal = todaySales.reduce((s, t) => s + Number(t.total_ttc_cents), 0);

  const close = async (): Promise<void> => {
    setPending(true);
    try {
      const r = await rpc<CloseSessionResult>('pos_close_session', {
        p_session_id: session.id,
        p_counted_cash_cents: counted,
        p_notes: notes.trim() || null,
      });
      setResult(r);
      setSession(null);
      updateCachedSession(null);
      await qc.invalidateQueries({ queryKey: ['session'] });
      toast({ title: 'Session clôturée', variant: 'success' });
    } catch (e) {
      toast({ title: 'Clôture impossible', description: describeApiError(e), variant: 'danger' });
    } finally {
      setPending(false);
    }
  };

  if (result) {
    const closed = result.session;
    const closing = result.closing;
    const zTicket = closing ? buildClosingTicket(closing, closed, register) : null;
    const variance = closed.variance_cents ?? 0;
    return (
      <div
        className="mx-auto grid w-full max-w-5xl grid-cols-[1fr_400px] gap-6"
        data-testid="closing-result"
      >
        <div className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-6">
          <h2 className="text-2xl font-semibold">Clôture Z · session n°{closed.session_number}</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-base">
            <dt className="text-muted">Ouverte le</dt>
            <dd>{formatDateTime(closed.opened_at)}</dd>
            <dt className="text-muted">Fermée le</dt>
            <dd>{closed.closed_at ? formatDateTime(closed.closed_at) : '—'}</dd>
            <dt className="text-muted">Fond de caisse</dt>
            <dd className="tabular">{formatEurCents(closed.opening_float_cents)}</dd>
            <dt className="text-muted">Espèces attendues</dt>
            <dd className="tabular">{formatEurCents(closed.expected_cash_cents ?? 0)}</dd>
            <dt className="text-muted">Espèces comptées</dt>
            <dd className="tabular">{formatEurCents(closed.counted_cash_cents ?? 0)}</dd>
            <dt className="text-muted">Écart</dt>
            <dd
              className={cn(
                'font-semibold tabular',
                variance === 0 ? 'text-success' : 'text-warning',
              )}
              data-testid="variance"
            >
              {formatEurCents(variance)}
            </dd>
          </dl>
          {closing && (
            <>
              <div className="border-t border-border pt-3">
                <p className="mb-2 text-xs uppercase tracking-wide text-muted">Ventes</p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-base">
                  <dt className="text-muted">Tickets</dt>
                  <dd>
                    {closing.txn_count} ({closing.first_ticket_number ?? '-'} →{' '}
                    {closing.last_ticket_number ?? '-'})
                  </dd>
                  <dt className="text-muted">Total HT</dt>
                  <dd className="tabular">{formatEurCents(closing.total_ht_cents)}</dd>
                  {(closing.vat_breakdown ?? []).map((v) => (
                    <div key={v.rate} className="contents">
                      <dt className="text-muted">TVA {formatVatRate(v.rate)}</dt>
                      <dd className="tabular">{formatEurCents(v.vat_cents)}</dd>
                    </div>
                  ))}
                  <dt className="text-muted">Total TTC</dt>
                  <dd className="text-xl font-semibold tabular">
                    {formatEurCents(closing.total_ttc_cents)}
                  </dd>
                  <dt className="text-muted">Remboursements</dt>
                  <dd className="tabular">{formatEurCents(closing.refunds_ttc_cents)}</dd>
                  <dt className="text-muted">Total perpétuel</dt>
                  <dd className="tabular">{formatEurCents(closing.grand_total_perpetual_cents)}</dd>
                </dl>
              </div>
              <div className="border-t border-border pt-3">
                <p className="mb-2 text-xs uppercase tracking-wide text-muted">
                  Moyens de paiement
                </p>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-base">
                  {normalizePaymentsBreakdown(closing.payments_breakdown).map((p) => (
                    <div key={p.method} className="contents">
                      <dt className="text-muted">{PAYMENT_LABELS[p.method] ?? p.method}</dt>
                      <dd className="tabular">{formatEurCents(p.amount_cents)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </>
          )}
          <div className="mt-auto flex gap-3">
            {zTicket && (
              <Button size="touch" onClick={() => void print(zTicket)}>
                <Printer className="h-5 w-5" /> Imprimer le Z
              </Button>
            )}
          </div>
        </div>
        <div className="overflow-y-auto">{zTicket && <ReceiptPreview ticket={zTicket} />}</div>
      </div>
    );
  }

  return (
    <div
      className="mx-auto flex w-full max-w-4xl flex-col gap-5 rounded-3xl border border-border bg-surface p-6"
      data-testid="close-session"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Clôturer la session n°{session.session_number}</h2>
          <p className="text-sm text-muted">
            Ouverte le {formatDateTime(session.opened_at)} · fond de caisse{' '}
            {formatEurCents(session.opening_float_cents)} · {todaySales.length} ticket(s)
            aujourd’hui ({formatEurCents(todayTotal)})
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-bg px-5 py-3 text-right">
          <p className="text-xs uppercase tracking-wide text-muted">Espèces comptées</p>
          <p className="text-4xl font-bold tabular" data-testid="counted-cash">
            {formatEurCents(counted)}
          </p>
        </div>
      </div>
      {draftBlocks && (
        <p
          className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
          role="alert"
          data-testid="closing-draft-blocked"
        >
          Encaissement interrompu
          {draftCaptured > 0 ? ` (CB déjà débitée : ${formatEurCents(draftCaptured)})` : ''}
          {draft.session_id && draft.session_id !== session.id
            ? ', commencé dans une session précédente'
            : ''}{' '}
          : reprenez-le ou abandonnez-le avant de clôturer.{' '}
          <Link to="/" className="underline">
            Aller à la vente
          </Link>
        </p>
      )}
      {parked.length > 0 && (
        <p
          className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"
          data-testid="closing-parked-warning"
        >
          {parked.length} ticket(s) en attente ({formatEurCents(parkedTotal)}) : ils resteront en
          attente après la clôture.
        </p>
      )}
      {cartLines > 0 && (
        <p
          className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"
          data-testid="closing-cart-blocked"
        >
          Le panier en cours contient {cartLines} ligne(s) : videz-le ou encaissez avant de
          clôturer.
        </p>
      )}
      {offline && <OfflineNotice action="La clôture (Z)" />}
      {queueBlocks && (
        <p
          className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"
          data-testid="closing-queue-blocked"
        >
          {stats.pending} vente(s) hors ligne en attente
          {stats.failed ? ` et ${stats.failed} en échec` : ''} : synchronisez-les avant de clôturer.{' '}
          <Link to="/offline" className="underline">
            Voir la file hors ligne
          </Link>
        </p>
      )}
      <CashCountGrid counts={counts} onChange={setCounts} />
      <label className="flex flex-col gap-1.5 text-sm text-muted">
        Notes (optionnel)
        <Input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Remarques sur la journée…"
        />
      </label>
      <p className="text-sm text-muted">
        L’écart (comptage − attendu) est calculé par le serveur à la clôture.
      </p>
      <Button
        variant="danger"
        size="pay"
        disabled={pending || cartLines > 0 || offline || queueBlocks || draftBlocks}
        onClick={() => void close()}
        data-testid="close-session-button"
      >
        {pending ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <LockKeyhole className="h-6 w-6" />
        )}{' '}
        Clôturer la caisse
      </Button>
    </div>
  );
}

/** Ouverture (fond de caisse) ou fermeture (comptage, Z) de la session. */
export function ClosingPage() {
  const sessionQuery = useSession();
  const session = useSessionStore((s) => s.session);
  const register = useSessionStore((s) => s.register);

  return (
    <div className="h-full overflow-y-auto p-6" data-testid="closing-page">
      {sessionQuery.isLoading && (
        <div className="flex justify-center py-10 text-muted">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}
      {sessionQuery.isError && (
        <p className="text-center text-danger">{describeApiError(sessionQuery.error)}</p>
      )}
      {sessionQuery.isSuccess && !register && (
        <p className="text-center text-warning">
          Aucune caisse active (`pos_registers`). Contactez l’administrateur.
        </p>
      )}
      {register && !session && <OpenSession register={register} />}
      {register && session && <CloseSession session={session} register={register} />}
    </div>
  );
}
