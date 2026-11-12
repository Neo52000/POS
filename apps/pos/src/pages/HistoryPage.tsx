import { useMemo, useState } from 'react';
import type { TicketPayload } from '@pos/core';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Mail,
  Lock,
  Printer,
  RotateCcw,
  Undo2,
  WifiOff,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { isBillingComplete } from '@/components/customer/PassageBillingDialog';
import { RefundDialog } from '@/components/history/RefundDialog';
import { SendInvoiceEmailDialog } from '@/components/ticket/SendInvoiceEmailDialog';
import { ShopifyDayView } from '@/components/history/ShopifyDayView';
import { ReceiptPreview } from '@/components/ticket/ReceiptPreview';
import { usePrinter } from '@/hooks/usePrinter';
import { DayKpiStrip } from '@/components/kpi/DayKpiStrip';
import { paymentSummary, useClosedDays, useDayTickets } from '@/hooks/useTodayTickets';
import { useShopifyPosDays } from '@/hooks/useShopifyPosHistory';
import { useTransactionFull } from '@/hooks/useTransactionFull';
import { entryKey, historyEntries, parseEntryKey } from '@/lib/historyDays';
import { edge } from '@/lib/edge';
import { buildInvoiceHtml, invoicePartyFor, printHtml } from '@/lib/invoiceA4';
import { rpc } from '@/lib/supabase';
import { businessDate, formatEurCents, formatLongDate, formatTime } from '@/lib/format';
import { buildTicketPayload, ticketCode } from '@/lib/ticket';
import { cn, errorMessage } from '@/lib/utils';
import { useTrainingStore } from '@/stores/trainingStore';
import { useUiStore } from '@/stores/uiStore';
import type { PassageBilling, PosTransaction, TransactionFull } from '@/types/pos';

type ReprintMode = 'ticket' | 'a4' | 'both';

function codeOf(t: PosTransaction): string {
  return t.ticket_number != null
    ? ticketCode(t.business_at, t.ticket_number)
    : (t.provisional_ref ?? '—');
}

const SIGNATURE_BADGE: Record<
  string,
  { label: string; variant: 'success' | 'warning' | 'danger' | 'muted' }
> = {
  signed: { label: 'Signé', variant: 'success' },
  pending_signature: { label: 'Signature en attente', variant: 'warning' },
  failed: { label: 'Signature en échec', variant: 'danger' },
  mock: { label: 'Signature test', variant: 'muted' },
};

/** `2026-09-23` → `mardi 23 septembre 2026` (date métier lue à midi UTC : jamais de décalage). */
function dayLabel(date: string): string {
  return formatLongDate(`${date}T12:00:00Z`);
}

/**
 * Historique : tickets du jour ou d'un jour clôturé (Z journalier) — liste + détail,
 * réimpression DUPLICATA, remboursement (le remboursement d'un ticket passé est un ticket du jour).
 * Jours de l'ancienne caisse Shopify POS : consultation seule, hors fiscal (`ShopifyDayView`).
 */
export function HistoryPage() {
  const today = businessDate();
  const todayKey = entryKey('nf525', today);
  const [selectedKey, setSelectedKey] = useState<string>(todayKey);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const closedDays = useClosedDays();
  const shopifyDays = useShopifyPosDays();
  const entries = useMemo(
    () => historyEntries(today, closedDays.data ?? [], shopifyDays.data ?? []),
    [today, closedDays.data, shopifyDays.data],
  );
  const { source, date: selectedDate } = parseEntryKey(selectedKey);
  // Jour NF525 affiché (aujourd'hui pendant la consultation d'un jour Shopify : aucune requête de plus).
  const day = source === 'nf525' ? selectedDate : today;
  const tickets = useDayTickets(day);
  const isToday = selectedKey === todayKey;
  const closedDay =
    source === 'nf525' ? ((closedDays.data ?? []).find((d) => d.date === day) ?? null) : null;
  // Navigation ‹ › : jours plus anciens = index croissant dans `entries` (trié du plus récent).
  const idx = entries.findIndex((e) => e.key === selectedKey);
  const olderKey = idx >= 0 ? entries[idx + 1]?.key : undefined;
  const newerKey = idx > 0 ? entries[idx - 1]?.key : undefined;
  const goTo = (key: string): void => {
    setSelectedKey(key);
    setSelectedId(null);
  };
  const nfEntries = entries.filter((e) => e.source === 'nf525' && e.key !== todayKey);
  const shopifyEntries = entries.filter((e) => e.source === 'shopify');
  const [refundOf, setRefundOf] = useState<TransactionFull | null>(null);
  const full = useTransactionFull(selectedId);
  const { print } = usePrinter();
  const toast = useUiStore((s) => s.toast);
  const training = useTrainingStore((s) => s.active);
  const offline = useUiStore((s) => s.connectivity === 'offline');

  const ticket = useMemo(
    () => (full.data ? buildTicketPayload(full.data, { duplicate: true }) : null),
    [full.data],
  );

  const [reprinting, setReprinting] = useState(false);
  const [mailOpen, setMailOpen] = useState(false);
  const [mailDefault, setMailDefault] = useState<string | null>(null);

  /** Facture par e-mail : propose l'adresse de l'en-tête de facture (personne de passage). */
  const openMail = async (transactionId: string): Promise<void> => {
    setMailDefault(null);
    setMailOpen(true);
    try {
      const r = await edge.passageBillingForTransaction(transactionId);
      setMailDefault(r.billing.email ?? null);
    } catch {
      setMailDefault(null);
    }
  };

  /**
   * Duplicata A4 : même document que la facture A4 de l'encaissement, marqué « DUPLICATA n°X ».
   * Personne de passage : l'en-tête enregistré est relu côté serveur (lien vente → contact).
   */
  const printDuplicateA4 = async (dup: TicketPayload, transactionId: string): Promise<void> => {
    let billing: PassageBilling | null = null;
    let linked = false;
    try {
      const r = await edge.passageBillingForTransaction(transactionId);
      linked = r.contact_id !== null;
      billing = r.billing;
    } catch {
      billing = null;
    }
    const passageName = dup.customer?.display_name.startsWith('Passage — ')
      ? dup.customer.display_name.slice('Passage — '.length).trim() || null
      : null;
    if ((linked || passageName) && !isBillingComplete(billing)) {
      toast({
        title: 'En-tête de facture incomplet',
        description: 'Le duplicata est imprimé sans adresse : complétez l’en-tête du client.',
        variant: 'warning',
      });
    }
    printHtml(buildInvoiceHtml(dup, invoicePartyFor(dup, billing, passageName)));
  };

  /**
   * Duplicata (0.4.0) : `pos_reprint` journalise d'abord la réimpression (JET synchrone) et
   * renvoie son rang ; « DUPLICATA n°X » n'est imprimé qu'après ce succès. Refusé hors ligne.
   */
  const reprint = async (mode: ReprintMode = 'ticket'): Promise<void> => {
    if (!full.data || reprinting) return;
    if (offline) {
      toast({
        title: 'Duplicata impossible hors ligne',
        description: 'La réimpression doit d’abord être enregistrée au journal.',
        variant: 'danger',
      });
      return;
    }
    setReprinting(true);
    try {
      const r = await rpc<{ duplicate_number: number }>('pos_reprint', {
        p_transaction_id: full.data.transaction.id,
        p_training: training,
      });
      const dup = buildTicketPayload(full.data, {
        duplicate: true,
        duplicateNumber: r.duplicate_number,
      });
      let outcome: 'printed' | 'fallback' | null = null;
      if (mode !== 'a4') outcome = await print(dup);
      if (mode !== 'ticket') await printDuplicateA4(dup, full.data.transaction.id);
      if (mode === 'a4' || outcome === 'printed')
        toast({
          title: `Duplicata n°${r.duplicate_number} de ${dup.ticket_code} ${mode === 'a4' ? 'envoyé en A4' : 'imprimé'}`,
          variant: 'success',
        });
    } catch (e) {
      toast({ title: 'Duplicata non imprimé', description: errorMessage(e), variant: 'danger' });
    } finally {
      setReprinting(false);
    }
  };

  const totalDay = (tickets.data ?? []).reduce((s, t) => s + Number(t.total_ttc_cents), 0);

  const nav = (
    <div className="mb-3 flex items-center gap-2" data-testid="history-day-nav">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => olderKey && goTo(olderKey)}
        disabled={!olderKey}
        aria-label="Jour précédent"
        data-testid="history-day-prev"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <select
        className="h-9 min-w-0 flex-1 rounded-xl border border-border bg-surface px-3 text-sm font-medium"
        value={selectedKey}
        onChange={(e) => goTo(e.target.value)}
        aria-label="Jour affiché"
        data-testid="history-day-select"
      >
        <option value={todayKey}>Aujourd’hui — {dayLabel(today)}</option>
        {nfEntries.length > 0 && (
          <optgroup label="Caisse NF525 — jours clôturés">
            {nfEntries.map((e) => (
              <option key={e.key} value={e.key}>
                {dayLabel(e.date)} · Z n°{e.closing_number} ·{' '}
                {formatEurCents(e.total_ttc_cents ?? 0)}
              </option>
            ))}
          </optgroup>
        )}
        {shopifyEntries.length > 0 && (
          <optgroup label="Shopify POS — archive (hors fiscal)">
            {shopifyEntries.map((e) => (
              <option key={e.key} value={e.key}>
                {dayLabel(e.date)} · Shopify · {e.orders} cde(s) ·{' '}
                {formatEurCents(e.total_ttc_cents ?? 0)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => newerKey && goTo(newerKey)}
        disabled={!newerKey}
        aria-label="Jour suivant"
        data-testid="history-day-next"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      {!isToday && (
        <Button variant="ghost" size="sm" onClick={() => goTo(todayKey)}>
          Aujourd’hui
        </Button>
      )}
    </div>
  );

  if (source === 'shopify') {
    return <ShopifyDayView date={selectedDate} dayLabel={dayLabel(selectedDate)} nav={nav} />;
  }

  return (
    <div className="grid h-full grid-cols-[1fr_440px]" data-testid="history-page">
      <section className="flex min-h-0 flex-col p-4">
        {training && (
          <p
            className="mb-3 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"
            data-testid="history-training"
          >
            Mode formation : cet historique ne contient que les ventes réelles. Les ventes de
            formation figurent dans la lecture X de formation (Rapports). Un duplicata d’un ticket
            réel reste tracé au journal.
          </p>
        )}
        {nav}
        <DayKpiStrip tickets={tickets.data} past={!isToday} />
        <div className="mb-3 mt-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            {isToday ? 'Tickets du jour' : `Tickets du ${dayLabel(day)}`}
            {closedDay && (
              <Badge variant="muted" data-testid="history-day-closed">
                <Lock className="mr-1 h-3 w-3" /> Clôturé · Z n°{closedDay.closing_number}
              </Badge>
            )}
          </h2>
          <div className="flex items-center gap-3 text-sm text-muted">
            <span>
              {tickets.data?.length ?? 0} ticket(s) · {formatEurCents(totalDay)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void tickets.refetch()}
              aria-label="Rafraîchir"
            >
              <RotateCcw className={cn('h-4 w-4', tickets.isFetching && 'animate-spin')} />
            </Button>
          </div>
        </div>
        {offline && (
          <p
            className="mb-3 flex items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"
            data-testid="history-offline"
          >
            <WifiOff className="h-4 w-4" /> Hors ligne : historique serveur indisponible, ventes
            hors ligne visibles dans « Hors ligne ».
          </p>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-surface">
          {tickets.isError && <p className="p-4 text-danger">{errorMessage(tickets.error)}</p>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Ticket</TableHead>
                <TableHead>Heure</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Règlement</TableHead>
                <TableHead className="text-right">TTC</TableHead>
                <TableHead>Signature</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(tickets.data ?? []).map((t) => {
                const sig = SIGNATURE_BADGE[t.signature_status] ?? {
                  label: t.signature_status,
                  variant: 'muted' as const,
                };
                return (
                  <TableRow
                    key={t.id}
                    data-state={selectedId === t.id ? 'selected' : undefined}
                    className="h-14 cursor-pointer hover:bg-border/40"
                    onClick={() => setSelectedId(t.id)}
                    data-testid="history-row"
                  >
                    <TableCell className="font-medium">{codeOf(t)}</TableCell>
                    <TableCell>{formatTime(t.business_at)}</TableCell>
                    <TableCell>
                      {t.kind === 'refund' ? (
                        <Badge variant="danger">Remboursement</Badge>
                      ) : (
                        <Badge variant="secondary">Vente</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted">
                      {t.customer_snapshot?.display_name ?? ''}
                    </TableCell>
                    <TableCell data-testid="history-payment">
                      {paymentSummary(t.payments)}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular">
                      {formatEurCents(Number(t.total_ttc_cents))}
                    </TableCell>
                    <TableCell>
                      <Badge variant={sig.variant}>{sig.label}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {tickets.data && tickets.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-muted">
                    {isToday ? 'Aucun ticket aujourd’hui.' : 'Aucun ticket ce jour-là.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <aside
        className="flex min-h-0 flex-col border-l border-border bg-surface p-4"
        data-testid="ticket-detail"
      >
        {!selectedId && <p className="m-auto text-muted">Sélectionnez un ticket.</p>}
        {selectedId && full.isLoading && (
          <div className="m-auto text-muted">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
        {full.isError && <p className="text-danger">{errorMessage(full.error)}</p>}
        {ticket && full.data && (
          <>
            <div className="mb-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="touch"
                className="min-w-[30%] flex-1"
                onClick={() => void reprint('ticket')}
                disabled={offline || reprinting}
                title={offline ? 'Duplicata impossible hors ligne' : 'Duplicata du ticket'}
                data-testid="reprint-button"
              >
                <Printer className="h-5 w-5" /> Ticket
              </Button>
              <Button
                variant="secondary"
                size="touch"
                className="min-w-[30%] flex-1"
                onClick={() => void reprint('a4')}
                disabled={offline || reprinting}
                title={offline ? 'Duplicata impossible hors ligne' : 'Duplicata A4 (facture)'}
                data-testid="reprint-a4-button"
              >
                <FileText className="h-5 w-5" /> A4
              </Button>
              <Button
                variant="secondary"
                size="touch"
                className="min-w-[30%] flex-1"
                onClick={() => void reprint('both')}
                disabled={offline || reprinting}
                title={offline ? 'Duplicata impossible hors ligne' : 'Duplicata ticket et A4'}
                data-testid="reprint-both-button"
              >
                <Printer className="h-5 w-5" /> Ticket + A4
              </Button>
              <Button
                variant="secondary"
                size="touch"
                className="min-w-[30%] flex-1"
                onClick={() => void openMail(full.data.transaction.id)}
                disabled={offline}
                title={offline ? 'Envoi impossible hors ligne' : 'Envoyer la facture par e-mail'}
                data-testid="reprint-mail-button"
              >
                <Mail className="h-5 w-5" /> E-mail
              </Button>
              {full.data.transaction.kind === 'sale' && (
                <span
                  className="flex basis-full"
                  title={offline ? 'Remboursement impossible hors ligne' : undefined}
                >
                  <Button
                    variant="danger"
                    size="touch"
                    className="flex-1"
                    onClick={() => setRefundOf(full.data ?? null)}
                    disabled={offline}
                    data-testid="refund-button"
                  >
                    <Undo2 className="h-5 w-5" /> Rembourser
                  </Button>
                </span>
              )}
            </div>
            {full.data.transaction.refund_reason && (
              <p className="mb-2 text-sm text-muted">
                Motif : {full.data.transaction.refund_reason}
              </p>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ReceiptPreview ticket={ticket} />
            </div>
          </>
        )}
      </aside>

      {full.data && (
        <SendInvoiceEmailDialog
          open={mailOpen}
          onOpenChange={setMailOpen}
          transactionId={full.data.transaction.id}
          ticketCode={codeOf(full.data.transaction)}
          defaultEmail={mailDefault}
          onSent={() => toast({ title: 'Facture envoyée par e-mail', variant: 'success' })}
        />
      )}

      <RefundDialog
        full={refundOf}
        onClose={() => setRefundOf(null)}
        onDone={(r) => {
          // Le remboursement est un ticket du jour, même pour une vente d'un jour clôturé.
          if (!isToday) setSelectedKey(todayKey);
          void tickets.refetch();
          setSelectedId(r.transaction.id);
        }}
      />
    </div>
  );
}
