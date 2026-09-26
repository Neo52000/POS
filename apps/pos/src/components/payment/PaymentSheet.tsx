import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Banknote,
  CheckCircle2,
  CreditCard,
  FileCheck,
  Gift,
  Landmark,
  Loader2,
  Lock,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { PAYMENT_METHOD_LABELS, validatePayments } from '@pos/core';
import type { CartTotals, CheckoutPayload, PaymentMethod } from '@pos/core';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ReceiptPreview } from '@/components/ticket/ReceiptPreview';
import { useCheckout } from '@/hooks/useCheckout';
import type { CheckoutOutcome } from '@/hooks/useCheckout';
import { useOfflineQueue } from '@/hooks/useOfflineQueue';
import { usePrinter } from '@/hooks/usePrinter';
import { describeApiError, isApiError } from '@/lib/apiError';
import type { PosCheckoutResult } from '@/lib/edge';
import { publishDisplay } from '@/lib/customerDisplay';
import { cachedTicketSettings } from '@/lib/ticketSettings';
import type { ProvisionalTicketContext } from '@/lib/ticket';
import { env } from '@/lib/env';
import { formatEurCents } from '@/lib/format';
import { uuidv4 } from '@/lib/uuid';
import { cn } from '@/lib/utils';
import { useCartStore } from '@/stores/cartStore';
import { useCheckoutDraftStore } from '@/stores/checkoutDraftStore';
import type { DraftPayment } from '@/stores/checkoutDraftStore';
import { useCustomerStore } from '@/stores/customerStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { CashPaymentPad } from './CashPaymentPad';
import { CbPaymentDialog } from './CbPaymentDialog';
import type { CbPaymentOutcome } from './CbPaymentDialog';
import { ReferenceForm } from './ReferenceForm';

export interface PaymentSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totals: CartTotals;
  /** Remboursement : cible + motif ; les lignes de `totals` ont des quantités négatives. */
  refund?: { transaction_id: string; reason: string } | null;
  onSuccess?: (result: PosCheckoutResult) => void;
}

type AddedPayment = DraftPayment;

const METHODS: Array<{ method: PaymentMethod; icon: typeof CreditCard; testId: string }> = [
  { method: 'cb', icon: CreditCard, testId: 'pay-cb' },
  { method: 'cash', icon: Banknote, testId: 'pay-cash' },
  { method: 'cheque', icon: FileCheck, testId: 'pay-cheque' },
  { method: 'gift_ucia', icon: Gift, testId: 'pay-gift' },
  { method: 'transfer', icon: Landmark, testId: 'pay-transfer' },
];

const CONFIRM_DELAY_MS = 3000;

/** Feuille de paiement plein écran : reste à payer, moyens multiples, validation → `pos-checkout`. */
export function PaymentSheet({
  open,
  onOpenChange,
  totals,
  refund = null,
  onSuccess,
}: PaymentSheetProps) {
  const [payments, setPayments] = useState<AddedPayment[]>([]);
  const [change, setChange] = useState(0);
  const [mode, setMode] = useState<PaymentMethod | null>(null);
  const [invoiceRequested, setInvoiceRequested] = useState(false);
  const [clientTxnId, setClientTxnId] = useState(() => uuidv4());
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckoutOutcome | null>(null);
  /** Garde synchrone : `checkout.isPending` n'est vrai qu'au rendu suivant (double tap). */
  const inFlight = useRef(false);

  const navigate = useNavigate();
  const checkout = useCheckout();
  const offline = useUiStore((s) => s.connectivity === 'offline');
  const { limitState } = useOfflineQueue();
  const user = useSessionStore((s) => s.user);
  const quotes = useCustomerStore((s) => s.quotes);
  const { print, openDrawer } = usePrinter();
  const toast = useUiStore((s) => s.toast);
  const register = useSessionStore((s) => s.register);
  const session = useSessionStore((s) => s.session);
  const account = useCustomerStore((s) => s.account);
  const quoteId = useCartStore((s) => s.quote_id);
  const clearCart = useCartStore((s) => s.clear);
  const detachCustomer = useCustomerStore((s) => s.detach);
  const saveDraft = useCheckoutDraftStore((s) => s.save);
  const discardDraft = useCheckoutDraftStore((s) => s.discard);

  const total = totals.total_ttc_cents;
  const paid = payments.reduce((s, p) => s + p.amount_cents, 0);
  const remaining = total - (paid - change);
  /** Vente à 0 € (remise totale) : un paiement espèces de 0 € est enregistré (SPEC §3 : ≥ 1). */
  const zeroSale = !refund && total === 0 && payments.length === 0;
  const effectivePayments = useMemo<AddedPayment[]>(
    () =>
      zeroSale ? [{ key: 'zero', method: 'cash', amount_cents: 0, captured: false }] : payments,
    [zeroSale, payments],
  );
  const validation = useMemo(
    () => validatePayments(total, effectivePayments, change),
    [total, effectivePayments, change],
  );
  /** Argent déjà débité par le TPE : la feuille ne peut plus être fermée sans enregistrer. */
  const hasCaptured = payments.some((p) => p.captured);
  const refundBlockedOffline = offline && !!refund;
  /** Limites hors ligne atteintes : aucun nouvel encaissement (sauf CB déjà débitée). */
  const saleBlockedOffline = offline && !refund && limitState.blocked;
  const canSubmit =
    validation.ok &&
    totals.lines.length > 0 &&
    !checkout.isPending &&
    !!session &&
    !!register &&
    !refundBlockedOffline;

  // `refund` est souvent un objet littéral recréé à chaque rendu du parent : seul le mode compte.
  const isRefund = refund !== null;

  // À chaque ouverture : reprise du brouillon de vente s'il existe, sinon réinitialisation.
  useEffect(() => {
    if (!open) return;
    const draft = isRefund ? null : useCheckoutDraftStore.getState().draft;
    setPayments(draft?.payments ?? []);
    setChange(draft?.change_cents ?? 0);
    setMode(null);
    setInvoiceRequested(draft?.invoice_requested ?? false);
    setClientTxnId(draft?.client_txn_id ?? uuidv4());
    setError(null);
    setResult(null);
    inFlight.current = false;
  }, [open, isRefund]);

  // Brouillon persistant (vente) : écrit à chaque paiement, effacé quand il n'y en a plus.
  useEffect(() => {
    if (!open || isRefund || result) return;
    if (payments.length === 0) {
      discardDraft();
      return;
    }
    saveDraft({
      client_txn_id: clientTxnId,
      session_id: useSessionStore.getState().session?.id ?? null,
      lines: useCartStore.getState().lines,
      quote_id: useCartStore.getState().quote_id,
      global_discount_percent: useCartStore.getState().global_discount_percent,
      account: useCustomerStore.getState().account,
      payments,
      change_cents: change,
      invoice_requested: invoiceRequested,
    });
  }, [
    open,
    isRefund,
    result,
    payments,
    change,
    invoiceRequested,
    clientTxnId,
    saveDraft,
    discardDraft,
  ]);

  // Écran de confirmation 3 s puis fermeture — sauf rendu monnaie à compter (fermeture manuelle).
  useEffect(() => {
    if (!result || result.ticket.change_cents > 0) return;
    const t = setTimeout(() => {
      onOpenChange(false);
    }, CONFIRM_DELAY_MS);
    return () => clearTimeout(t);
  }, [result, onOpenChange]);

  /**
   * Fermeture : interdite tant qu'une CB captée n'est pas enregistrée, sauf après un refus serveur
   * (le brouillon est alors conservé et repris depuis la page de vente).
   */
  // Écran client : reste à payer pendant l'encaissement, puis total et rendu monnaie.
  useEffect(() => {
    if (!open || isRefund) return;
    if (result) {
      publishDisplay({
        type: 'sale_completed',
        total_ttc_cents: result.ticket.total_ttc_cents,
        change_cents: result.ticket.change_cents,
        ticket_code: result.ticket.ticket_code,
      });
      return;
    }
    publishDisplay({
      type: 'payment',
      total_ttc_cents: total,
      paid_cents: paid - change,
      remaining_cents: Math.max(0, remaining),
    });
  }, [open, isRefund, result, total, paid, change, remaining]);

  const close = (): void => {
    if (checkout.isPending || inFlight.current) return;
    if (hasCaptured && !result && !error) {
      toast({
        title: 'Paiement CB déjà débité',
        description: 'Validez la vente : le montant capté par le TPE doit être enregistré.',
        variant: 'warning',
      });
      return;
    }
    if (!refund && !hasCaptured) discardDraft();
    onOpenChange(false);
  };

  const addPayment = (p: Omit<AddedPayment, 'key'>): void => {
    setPayments((prev) => [...prev, { ...p, key: uuidv4() }]);
    setMode(null);
  };

  const removePayment = (key: string): void => {
    setPayments((prev) => {
      const target = prev.find((p) => p.key === key);
      if (target?.method === 'cash') setChange(0);
      return prev.filter((p) => p.key !== key);
    });
  };

  const onCbApproved = (o: CbPaymentOutcome): void => {
    addPayment({
      method: 'cb',
      amount_cents: o.amount_cents,
      tpe_response: o.tpe_response,
      manual_fallback: o.manual_fallback,
      captured: !o.manual_fallback,
    });
  };

  const submit = async (): Promise<void> => {
    if (!canSubmit || !session || !register || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const payload: CheckoutPayload = {
      client_txn_id: clientTxnId,
      register_id: register.id,
      session_id: session.id,
      kind: refund ? 'refund' : 'sale',
      ...(refund
        ? { refund_of_transaction_id: refund.transaction_id, refund_reason: refund.reason }
        : {}),
      business_at: new Date().toISOString(),
      offline_queued: false,
      ...(account && !refund ? { customer_account_id: account.id } : {}),
      ...(quoteId && !refund ? { quote_id: quoteId } : {}),
      invoice_requested: !!account && invoiceRequested && !refund,
      lines: totals.lines.map((l) => ({
        line_no: l.line_no,
        product_id: l.product_id ?? null,
        ean: l.ean ?? null,
        sku: l.sku ?? null,
        label: l.label,
        qty: l.qty,
        unit_price_ttc_cents: l.unit_price_ttc_cents,
        vat_rate: l.vat_rate,
        discount_percent: l.discount_percent,
        eco_tax_cents: l.eco_tax_cents,
        pricing_rule_id: l.pricing_rule_id ?? null,
        price_tier_title: l.price_tier_title ?? null,
        public_price_ttc_cents: l.public_price_ttc_cents ?? null,
      })),
      payments: effectivePayments.map(
        ({ method, amount_cents, reference, tpe_response, manual_fallback }) => ({
          method,
          amount_cents,
          ...(reference ? { reference } : {}),
          ...(tpe_response !== undefined ? { tpe_response } : {}),
          ...(manual_fallback ? { manual_fallback: true } : {}),
        }),
      ),
      change_cents: change,
      totals: {
        total_ht_cents: totals.total_ht_cents,
        total_vat_cents: totals.total_vat_cents,
        total_ttc_cents: totals.total_ttc_cents,
      },
      app_version: env.appVersion,
    };
    const quoteNumber = quoteId ? quotes.find((q) => q.id === quoteId)?.quote_number : null;
    const context: ProvisionalTicketContext = {
      register_code: register.code,
      cashier_name: user?.email?.split('@')[0] ?? '',
      settings: cachedTicketSettings(),
      customer:
        account && !refund
          ? {
              display_name: account.display_name,
              ...(account.company_name ? { company_name: account.company_name } : {}),
              ...(account.siret ? { siret: account.siret } : {}),
              ...(account.vat_number ? { vat_number: account.vat_number } : {}),
            }
          : null,
      quote_number: !refund ? (quoteNumber ?? null) : null,
    };
    try {
      const outcome = await checkout.mutateAsync({ payload, context });
      if (!refund) discardDraft();
      setResult(outcome);
      if (outcome.status === 'recorded' && outcome.result.idempotent_replay)
        toast({ title: 'Vente déjà enregistrée (rejeu idempotent)', variant: 'warning' });
      if (outcome.status === 'queued') {
        toast({
          title: `Vente hors ligne ${outcome.provisionalRef}`,
          description:
            'Ticket provisoire : la vente sera synchronisée automatiquement au retour du réseau.',
          variant: 'warning',
          durationMs: 6000,
        });
      }
      void print(outcome.ticket);
      if (payments.some((p) => p.method === 'cash')) void openDrawer('Encaissement espèces', false);
      if (refund) {
        toast({
          title: `Remboursement ${outcome.ticket.ticket_code} enregistré`,
          variant: 'success',
        });
      } else {
        clearCart('sale_completed');
        detachCustomer();
      }
      if (outcome.status === 'recorded') onSuccess?.(outcome.result);
    } catch (e) {
      const message = describeApiError(e);
      setError(message);
      if (isApiError(e) && e.code === 'OFFLINE_LIMIT_REACHED') {
        toast({
          title: 'Ventes hors ligne bloquées',
          description: e.message !== e.code ? e.message : message,
          variant: 'danger',
          durationMs: 10_000,
        });
        onOpenChange(false);
        navigate('/offline');
      } else if (isApiError(e) && e.code === 'QUEUED_AFTER_CB') {
        toast({
          title: 'Vente à rejouer',
          description: message,
          variant: 'warning',
          durationMs: 10_000,
        });
      } else {
        toast({
          title: 'Vente non enregistrée',
          description: message,
          variant: 'danger',
          durationMs: 8000,
        });
      }
    } finally {
      inFlight.current = false;
    }
  };

  // Raccourcis 1 à 5 : choix du moyen de paiement.
  const methodsEnabled =
    open &&
    !result &&
    mode === null &&
    remaining !== 0 &&
    !refundBlockedOffline &&
    !saleBlockedOffline;
  useEffect(() => {
    if (!methodsEnabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const index = Number(e.key) - 1;
      const entry = Number.isInteger(index) ? METHODS[index] : undefined;
      if (!entry) return;
      e.preventDefault();
      setMode(entry.method);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [methodsEnabled]);

  const signedRemaining = remaining;
  const title = refund ? 'Rembourser' : 'Encaisser';

  return (
    <Sheet open={open} onOpenChange={(o) => (o ? onOpenChange(true) : !result && close())}>
      <SheetContent side="full" className="p-0" hideClose data-testid="payment-sheet">
        {result ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-4 p-8"
            data-testid="checkout-success"
          >
            <CheckCircle2 className="h-20 w-20 text-success" />
            <p className="text-3xl font-semibold">
              {refund
                ? 'Remboursement enregistré'
                : result.status === 'queued'
                  ? 'Vente enregistrée hors ligne'
                  : 'Vente enregistrée'}
            </p>
            <p className="text-5xl font-bold tabular" data-testid="ticket-code">
              {result.ticket.ticket_code}
            </p>
            {result.status === 'queued' && (
              <p
                className="flex items-center gap-2 text-base text-warning"
                data-testid="checkout-provisional"
              >
                <WifiOff className="h-5 w-5" /> Ticket provisoire · synchronisation automatique au
                retour du réseau
              </p>
            )}
            {result.ticket.change_cents > 0 && (
              <p className="text-2xl">
                Rendu monnaie :{' '}
                <span className="font-semibold text-success">
                  {formatEurCents(result.ticket.change_cents)}
                </span>
              </p>
            )}
            <div className="max-h-[45vh] overflow-y-auto">
              <ReceiptPreview ticket={result.ticket} className="w-[380px]" />
            </div>
            <Button
              variant="secondary"
              size="touch"
              onClick={() => onOpenChange(false)}
              data-testid="close-success"
            >
              Fermer
            </Button>
          </div>
        ) : (
          <div className="grid h-full grid-cols-[1fr_460px]">
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-6">
              <SheetHeader>
                <SheetTitle>{title}</SheetTitle>
                <SheetDescription>
                  {totals.lines.length} ligne(s) · total {formatEurCents(total)}
                </SheetDescription>
              </SheetHeader>
              <div
                className={cn(
                  'rounded-2xl border border-border bg-bg',
                  mode === null ? 'p-6' : 'flex items-baseline gap-4 px-6 py-3',
                )}
              >
                <p className="text-sm uppercase tracking-wide text-muted">
                  {signedRemaining === 0
                    ? 'Soldé'
                    : refund
                      ? 'Reste à rembourser'
                      : 'Reste à payer'}
                </p>
                <p
                  className={cn(
                    'text-[64px] font-bold leading-none tabular',
                    signedRemaining === 0 && 'text-success',
                  )}
                  data-testid="remaining"
                >
                  {formatEurCents(Math.abs(signedRemaining))}
                </p>
              </div>

              {mode === null && (
                <div
                  className="grid grid-cols-2 gap-3 lg:grid-cols-3"
                  data-testid="payment-methods"
                >
                  {METHODS.map(({ method, icon: Icon, testId }, i) => (
                    <Button
                      key={method}
                      size="pay"
                      variant="secondary"
                      className="relative justify-start"
                      disabled={signedRemaining === 0 || refundBlockedOffline || saleBlockedOffline}
                      onClick={() => setMode(method)}
                      data-testid={testId}
                    >
                      <Icon className="h-7 w-7 shrink-0 text-accent" />{' '}
                      {PAYMENT_METHOD_LABELS[method]}
                      <kbd className="absolute right-2 top-2 rounded border border-border px-1 text-xs leading-4 text-muted">
                        {i + 1}
                      </kbd>
                    </Button>
                  ))}
                </div>
              )}

              {mode === 'cash' && (
                <CashPaymentPad
                  dueCents={signedRemaining}
                  onCancel={() => setMode(null)}
                  onConfirm={(amount, chg) => {
                    setChange((c) => c + chg);
                    addPayment({ method: 'cash', amount_cents: amount, captured: false });
                  }}
                />
              )}
              {(mode === 'cheque' || mode === 'gift_ucia' || mode === 'transfer') && (
                <ReferenceForm
                  method={mode}
                  dueCents={signedRemaining}
                  onCancel={() => setMode(null)}
                  onConfirm={(amount, reference) =>
                    addPayment({ method: mode, amount_cents: amount, reference, captured: false })
                  }
                />
              )}
              <CbPaymentDialog
                open={mode === 'cb'}
                amountCents={signedRemaining}
                onOpenChange={(o) => !o && setMode(null)}
                onApproved={onCbApproved}
              />
            </div>

            <aside className="flex min-h-0 flex-col border-l border-border bg-bg">
              <div className="flex items-center justify-between p-4">
                <p className="text-sm uppercase tracking-wide text-muted">Paiements</p>
                <Button
                  variant="ghost"
                  size="touch"
                  onClick={close}
                  disabled={checkout.isPending || (hasCaptured && !error)}
                  title={hasCaptured && !error ? 'CB déjà débitée : validez la vente' : undefined}
                  data-testid="back-to-cart"
                >
                  {hasCaptured && !error ? <Lock className="h-4 w-4" /> : null}
                  Retour au panier
                </Button>
              </div>
              <ul className="min-h-0 flex-1 overflow-y-auto px-4" data-testid="payment-list">
                {payments.length === 0 && (
                  <li className="py-6 text-center text-muted">
                    {zeroSale ? 'Vente à 0 € : aucun paiement requis' : 'Aucun paiement saisi'}
                  </li>
                )}
                {payments.map((p) => (
                  <li key={p.key} className="flex items-center gap-3 border-b border-border py-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {PAYMENT_METHOD_LABELS[p.method]}
                        {p.manual_fallback && (
                          <span className="ml-2 text-xs text-warning">(validée manuellement)</span>
                        )}
                      </p>
                      {p.reference && (
                        <p className="truncate text-xs text-muted">Réf. {p.reference}</p>
                      )}
                    </div>
                    <span className="text-lg font-semibold tabular">
                      {formatEurCents(p.amount_cents)}
                    </span>
                    {p.captured ? (
                      <Lock className="h-5 w-5 text-muted" aria-label="Paiement CB capturé" />
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon-touch"
                        aria-label="Retirer"
                        onClick={() => removePayment(p.key)}
                      >
                        <Trash2 className="h-5 w-5 text-danger" />
                      </Button>
                    )}
                  </li>
                ))}
                {change > 0 && (
                  <li className="flex items-center justify-between py-3 text-success">
                    <span>Rendu monnaie</span>
                    <span className="text-lg font-semibold tabular" data-testid="change-total">
                      {formatEurCents(change)}
                    </span>
                  </li>
                )}
              </ul>
              {account && !refund && (
                <label className="flex min-h-touch items-center gap-3 border-t border-border px-4 text-base">
                  <input
                    type="checkbox"
                    className="h-6 w-6 accent-accent"
                    checked={invoiceRequested}
                    onChange={(e) => setInvoiceRequested(e.target.checked)}
                    data-testid="invoice-requested"
                  />
                  Facture pro ({account.display_name})
                </label>
              )}
              {!validation.ok && payments.length > 0 && (
                <p className="px-4 py-2 text-sm text-warning" data-testid="validation-message">
                  {validation.code === 'PAYMENTS_MISMATCH'
                    ? 'Le total des paiements ne couvre pas le montant.'
                    : validation.message}
                </p>
              )}
              {offline && (
                <div
                  className={cn(
                    'mx-4 my-2 rounded-xl px-3 py-2 text-sm',
                    refund || limitState.blocked
                      ? 'bg-danger/10 text-danger'
                      : 'bg-warning/10 text-warning',
                  )}
                  data-testid="payment-offline-notice"
                >
                  {refund ? (
                    'Hors ligne : remboursement impossible.'
                  ) : limitState.blocked ? (
                    <>
                      {limitState.message}{' '}
                      <Link to="/offline" className="underline" onClick={() => onOpenChange(false)}>
                        Voir la file
                      </Link>
                    </>
                  ) : (
                    'Hors ligne : la vente sera enregistrée avec un ticket provisoire (OFF-…).'
                  )}
                </div>
              )}
              {error && (
                <p
                  className="px-4 py-2 text-sm text-danger"
                  role="alert"
                  data-testid="checkout-error"
                >
                  {error}
                </p>
              )}
              <div className="border-t border-border p-4">
                <Button
                  size="pay"
                  variant="success"
                  className="w-full"
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                  data-testid="validate-payment"
                >
                  {checkout.isPending ? <Loader2 className="h-6 w-6 animate-spin" /> : null}
                  Valider {formatEurCents(Math.abs(total))}
                </Button>
              </div>
            </aside>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
