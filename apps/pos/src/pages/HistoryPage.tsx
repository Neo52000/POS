import { useMemo, useState } from 'react';
import { Loader2, Printer, RotateCcw, Undo2, WifiOff } from 'lucide-react';
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
import { RefundDialog } from '@/components/history/RefundDialog';
import { ReceiptPreview } from '@/components/ticket/ReceiptPreview';
import { usePrinter } from '@/hooks/usePrinter';
import { useTodayTickets } from '@/hooks/useTodayTickets';
import { useTransactionFull } from '@/hooks/useTransactionFull';
import { logEvent } from '@/lib/events';
import { formatEurCents, formatTime } from '@/lib/format';
import { buildTicketPayload, ticketCode } from '@/lib/ticket';
import { cn, errorMessage } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';
import type { PosTransaction, TransactionFull } from '@/types/pos';

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

/** Tickets du jour : liste + détail, réimpression DUPLICATA, remboursement. */
export function HistoryPage() {
  const tickets = useTodayTickets();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refundOf, setRefundOf] = useState<TransactionFull | null>(null);
  const full = useTransactionFull(selectedId);
  const { print } = usePrinter();
  const toast = useUiStore((s) => s.toast);
  const offline = useUiStore((s) => s.connectivity === 'offline');

  const ticket = useMemo(
    () => (full.data ? buildTicketPayload(full.data, { duplicate: true }) : null),
    [full.data],
  );

  const reprint = async (): Promise<void> => {
    if (!ticket || !full.data) return;
    void logEvent('reprint', {
      transaction_id: full.data.transaction.id,
      ticket_code: ticket.ticket_code,
    });
    const outcome = await print(ticket);
    if (outcome === 'printed')
      toast({ title: `Duplicata ${ticket.ticket_code} imprimé`, variant: 'success' });
  };

  const totalDay = (tickets.data ?? []).reduce((s, t) => s + Number(t.total_ttc_cents), 0);

  return (
    <div className="grid h-full grid-cols-[1fr_440px]" data-testid="history-page">
      <section className="flex min-h-0 flex-col p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Tickets du jour</h2>
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
                  <TableCell colSpan={6} className="py-10 text-center text-muted">
                    Aucun ticket aujourd’hui.
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
            <div className="mb-3 flex gap-2">
              <Button
                variant="secondary"
                size="touch"
                className="flex-1"
                onClick={() => void reprint()}
                data-testid="reprint-button"
              >
                <Printer className="h-5 w-5" /> Duplicata
              </Button>
              {full.data.transaction.kind === 'sale' && (
                <span
                  className="flex flex-1"
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

      <RefundDialog
        full={refundOf}
        onClose={() => setRefundOf(null)}
        onDone={(r) => {
          void tickets.refetch();
          setSelectedId(r.transaction.id);
        }}
      />
    </div>
  );
}
