import { AlertTriangle, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCustomerOrders } from '@/hooks/useCustomerOrders';
import { documentItemUnitTtcCents, importDocumentIntoCart } from '@/lib/documentImport';
import { formatEurCents } from '@/lib/format';
import { errorMessage } from '@/lib/utils';
import { useCartStore } from '@/stores/cartStore';
import { useCustomerStore } from '@/stores/customerStore';
import type { CustomerOrder } from '@/types/pos';

export interface OrderImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'brouillon',
  confirmed: 'confirmée',
  partially_delivered: 'livrée partiellement',
  delivered: 'livrée',
};

/** Total TTC (centimes) que la commande produira dans le panier : lignes restant dues + port. */
export function orderCartTotalCents(order: CustomerOrder): number {
  let total = 0;
  for (const it of order.items) {
    if (!(it.quantity > 0)) continue;
    const gross = documentItemUnitTtcCents(it) * it.quantity;
    total += Math.round(gross * (1 - (it.discount_percent ?? 0) / 100));
  }
  return total + Math.round((order.shipping_ttc ?? 0) * 100);
}

/** Transfère une commande ma-papeterie non réglée dans le panier (remplace le panier courant). */
export function importOrderIntoCart(order: CustomerOrder): void {
  importDocumentIntoCart(order.items, {
    tag: `Commande ${order.order_number}`,
    reason: 'order_import',
    quoteId: null,
    orderId: order.id,
    extraFreeLine:
      order.shipping_ttc && order.shipping_ttc > 0
        ? { label: 'Frais de port', ttc: order.shipping_ttc }
        : null,
  });
}

export function OrderImportDialog({ open, onOpenChange }: OrderImportDialogProps) {
  const account = useCustomerStore((s) => s.account);
  const cartCount = useCartStore((s) => s.lines.length);
  const { data, isFetching, isError, error } = useCustomerOrders(
    open && account ? account.id : null,
  );

  const pick = (order: CustomerOrder): void => {
    importOrderIntoCart(order);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>Commandes à encaisser · {account?.display_name}</DialogTitle>
          <DialogDescription>
            Commandes non réglées (hors payées en ligne, annulées ou facturées). Le transfert
            remplace le panier courant{cartCount > 0 ? ` (${cartCount} ligne(s))` : ''} par les
            lignes restant dues.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-[160px] flex-1 overflow-y-auto">
          {isFetching && (
            <div className="flex justify-center py-6 text-muted">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          {isError && <p className="py-4 text-center text-danger">{errorMessage(error)}</p>}
          {data && data.length === 0 && (
            <p className="py-6 text-center text-muted">Aucune commande à encaisser.</p>
          )}
          <ul className="flex flex-col gap-2">
            {(data ?? []).map((o) => {
              const cartTotal = orderCartTotalCents(o);
              const orderTotal = o.total_ttc != null ? Math.round(o.total_ttc * 100) : null;
              const mismatch = orderTotal != null && Math.abs(orderTotal - cartTotal) > 5;
              const sellable = o.items.some((it) => it.quantity > 0);
              return (
                <li key={o.id} className="rounded-xl border border-border bg-bg p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">
                        {o.order_number}{' '}
                        <Badge variant="secondary">{STATUS_LABELS[o.status] ?? o.status}</Badge>
                        {o.origin === 'shopify' && (
                          <Badge variant="outline" className="ml-1">
                            web
                          </Badge>
                        )}
                      </p>
                      <p className="text-xs text-muted">
                        {new Date(o.created_at).toLocaleDateString('fr-FR')} · {o.items.length}{' '}
                        ligne(s) · {formatEurCents(cartTotal)} TTC
                        {o.shipping_ttc
                          ? ` (dont port ${formatEurCents(Math.round(o.shipping_ttc * 100))})`
                          : ''}
                      </p>
                      {mismatch && (
                        <p className="mt-1 flex items-center gap-1 text-xs text-danger">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          Total commande {formatEurCents(orderTotal)} ≠ lignes — vérifier avant
                          encaissement.
                        </p>
                      )}
                    </div>
                    <Button
                      size="touch"
                      onClick={() => pick(o)}
                      disabled={!sellable}
                      data-testid="import-order"
                    >
                      Transférer
                    </Button>
                  </div>
                  <ul className="mt-2 text-xs text-muted">
                    {o.items.slice(0, 4).map((it, i) => (
                      <li key={i}>
                        {it.quantity} × {it.label} — {formatEurCents(documentItemUnitTtcCents(it))}{' '}
                        TTC
                      </li>
                    ))}
                    {o.items.length > 4 && <li>…</li>}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
