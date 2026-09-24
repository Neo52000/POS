import { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { computeCart } from '@pos/core';
import type { CartLineInput } from '@pos/core';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { PaymentSheet } from '@/components/payment/PaymentSheet';
import type { PosCheckoutResult } from '@/lib/edge';
import { formatEurCents, formatQty } from '@/lib/format';
import { ticketCode } from '@/lib/ticket';
import { useUiStore } from '@/stores/uiStore';
import type { TransactionFull } from '@/types/pos';

export interface RefundDialogProps {
  full: TransactionFull | null;
  onClose: () => void;
  onDone?: (result: PosCheckoutResult) => void;
}

/** Remboursement partiel/total d'un ticket : lignes + quantités, motif obligatoire, puis moyen de remboursement. */
export function RefundDialog({ full, onClose, onDone }: RefundDialogProps) {
  const [qtys, setQtys] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [paying, setPaying] = useState(false);
  const offline = useUiStore((s) => s.connectivity === 'offline');

  const lines = full?.lines ?? [];
  const refundLines: CartLineInput[] = useMemo(
    () =>
      lines
        .filter((l) => (qtys[l.id] ?? 0) > 0)
        .map((l, i) => ({
          line_no: i + 1,
          product_id: l.product_id,
          ean: l.ean,
          sku: l.sku,
          label: l.label,
          qty: -(qtys[l.id] ?? 0),
          unit_price_ttc_cents: Number(l.unit_price_ttc_cents),
          vat_rate: l.vat_rate,
          discount_percent: Number(l.discount_percent ?? 0),
          eco_tax_cents: Number(l.eco_tax_cents ?? 0),
          pricing_rule_id: l.pricing_rule_id,
          price_tier_title: l.price_tier_title,
          public_price_ttc_cents: l.public_price_ttc_cents,
        })),
    [lines, qtys],
  );
  const totals = useMemo(() => computeCart(refundLines), [refundLines]);
  const valid = refundLines.length > 0 && reason.trim().length >= 3 && !offline;

  const setQty = (id: string, max: number, n: number): void =>
    setQtys((q) => ({ ...q, [id]: Math.min(max, Math.max(0, n)) }));

  const close = (): void => {
    setQtys({});
    setReason('');
    setPaying(false);
    onClose();
  };

  const code =
    full?.transaction.ticket_number != null
      ? ticketCode(full.transaction.business_at, full.transaction.ticket_number)
      : '';

  return (
    <>
      <Dialog open={full !== null && !paying} onOpenChange={(o) => !o && close()}>
        <DialogContent className="max-h-[90vh] max-w-2xl">
          <DialogHeader>
            <DialogTitle>Rembourser · {code}</DialogTitle>
            <DialogDescription>
              Sélectionnez les lignes et quantités à rembourser.
            </DialogDescription>
          </DialogHeader>
          <ul className="min-h-0 flex-1 overflow-y-auto">
            {lines.map((l) => {
              const max = Math.abs(Number(l.qty));
              const n = qtys[l.id] ?? 0;
              return (
                <li
                  key={l.id}
                  className="flex items-center gap-3 border-b border-border py-2"
                  data-testid="refund-line"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{l.label}</p>
                    <p className="text-xs text-muted">
                      vendu {formatQty(max)} × {formatEurCents(Number(l.unit_price_ttc_cents))}
                      {Number(l.discount_percent) > 0 ? ` (−${l.discount_percent} %)` : ''}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="icon-touch"
                    aria-label="Moins"
                    onClick={() => setQty(l.id, max, n - 1)}
                  >
                    <Minus className="h-5 w-5" />
                  </Button>
                  <span
                    className="w-10 text-center text-lg font-semibold tabular"
                    data-testid="refund-qty"
                  >
                    {formatQty(n)}
                  </span>
                  <Button
                    variant="secondary"
                    size="icon-touch"
                    aria-label="Plus"
                    onClick={() => setQty(l.id, max, n + 1)}
                    data-testid="refund-plus"
                  >
                    <Plus className="h-5 w-5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setQty(l.id, max, max)}>
                    Tout
                  </Button>
                </li>
              );
            })}
          </ul>
          <label className="flex flex-col gap-1.5 text-sm text-muted">
            Motif (obligatoire)
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Article défectueux, erreur de caisse…"
              data-testid="refund-reason"
            />
          </label>
          <div className="flex items-center justify-between text-lg">
            <span>À rembourser</span>
            <span className="text-3xl font-bold tabular" data-testid="refund-total">
              {formatEurCents(Math.abs(totals.total_ttc_cents))}
            </span>
          </div>
          {offline && (
            <p className="text-sm text-danger" data-testid="refund-offline">
              Hors ligne : remboursement impossible (il sera possible au retour du réseau).
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" size="touch" onClick={close}>
              Annuler
            </Button>
            <Button
              variant="danger"
              size="touch"
              disabled={!valid}
              title={offline ? 'Remboursement impossible hors ligne' : undefined}
              onClick={() => setPaying(true)}
              data-testid="refund-next"
            >
              Choisir le remboursement
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {full && (
        <PaymentSheet
          open={paying}
          onOpenChange={(o) => {
            if (!o) setPaying(false);
          }}
          totals={totals}
          refund={{ transaction_id: full.transaction.id, reason: reason.trim() }}
          onSuccess={(r) => {
            onDone?.(r);
            setTimeout(close, 3100);
          }}
        />
      )}
    </>
  );
}
