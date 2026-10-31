import { AlertTriangle, Layers, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import { documentItemUnitTtcCents, importDocumentsIntoCart } from '@/lib/documentImport';
import type { ImportedDocument } from '@/lib/documentImport';
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

function orderDocument(order: CustomerOrder): ImportedDocument {
  return {
    items: order.items,
    tag: `Commande ${order.order_number}`,
    extraFreeLine:
      order.shipping_ttc && order.shipping_ttc > 0
        ? { label: 'Frais de port', ttc: order.shipping_ttc }
        : null,
  };
}

/** Commande ayant au moins une ligne restant due (sinon rien à encaisser). */
export function orderSellable(order: CustomerOrder): boolean {
  return order.items.some((it) => it.quantity > 0);
}

/**
 * Transfère une ou plusieurs commandes ma-papeterie non réglées dans le panier (remplace le
 * panier courant) : un seul ticket, une seule facture, toutes réglées après encaissement. Les
 * commandes sans ligne due sont ignorées ; ordre chronologique (plus ancienne d'abord).
 */
export function importOrdersIntoCart(
  orders: CustomerOrder[],
  opts: { invoiceRequested?: boolean } = {},
): void {
  const picked = orders
    .filter(orderSellable)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (picked.length === 0) return;
  importDocumentsIntoCart(picked.map(orderDocument), {
    reason: 'order_import',
    quoteId: null,
    orderIds: picked.map((o) => o.id),
  });
  useCartStore.getState().setInvoiceHint(opts.invoiceRequested === true);
}

/**
 * Lot préparé au back-office et encore complet : ses commandes (toutes encaissables) et sa
 * demande de facture. `null` si aucun lot ou si une commande du lot manque.
 */
export function preparedGroup(
  orders: CustomerOrder[],
): { orders: CustomerOrder[]; invoiceRequested: boolean; id: string } | null {
  const first = orders.find((o) => o.prepared_group);
  const group = first?.prepared_group;
  if (!group) return null;
  const members = orders.filter((o) => o.prepared_group?.id === group.id);
  if (members.length !== group.order_count || !members.every(orderSellable)) return null;
  return { orders: members, invoiceRequested: group.invoice_requested, id: group.id };
}

/** Transfère une commande ma-papeterie non réglée dans le panier (remplace le panier courant). */
export function importOrderIntoCart(order: CustomerOrder): void {
  importOrdersIntoCart([order]);
}

export function OrderImportDialog({ open, onOpenChange }: OrderImportDialogProps) {
  const account = useCustomerStore((s) => s.account);
  const passageContact = useCustomerStore((s) => s.passageContact);
  const cartCount = useCartStore((s) => s.lines.length);
  const { data, isFetching, isError, error } = useCustomerOrders(
    open && account ? account.id : null,
    passageContact?.id,
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const orders = useMemo(() => data ?? [], [data]);
  const group = useMemo(() => preparedGroup(orders), [orders]);

  // Sélection remise à zéro à chaque ouverture / changement de client ; le lot préparé au
  // back-office est présélectionné.
  useEffect(() => {
    setSelected(new Set(group ? group.orders.map((o) => o.id) : []));
  }, [open, account?.id, passageContact?.id, group]);
  const sellable = useMemo(() => orders.filter(orderSellable), [orders]);
  const picked = useMemo(() => sellable.filter((o) => selected.has(o.id)), [sellable, selected]);
  const pickedTotal = picked.reduce((sum, o) => sum + orderCartTotalCents(o), 0);
  const allSelected = sellable.length > 0 && picked.length === sellable.length;

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(sellable.map((o) => o.id)));
  };

  const transfer = (list: CustomerOrder[]): void => {
    // Sélection identique au lot préparé : sa demande de facture suit.
    const isGroup =
      !!group &&
      list.length === group.orders.length &&
      list.every((o) => o.prepared_group?.id === group.id);
    importOrdersIntoCart(list, { invoiceRequested: isGroup && group.invoiceRequested });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>Commandes à encaisser · {account?.display_name}</DialogTitle>
          <DialogDescription>
            Commandes non réglées (hors payées en ligne, annulées ou facturées). Cochez plusieurs
            commandes pour les regrouper sur un seul ticket (une facture, un encaissement). Le
            transfert remplace le panier courant
            {cartCount > 0 ? ` (${cartCount} ligne(s))` : ''} par les lignes restant dues.
          </DialogDescription>
        </DialogHeader>
        {group && (
          <div
            className="flex items-center justify-between gap-3 rounded-xl border border-accent bg-accent-soft p-3"
            data-testid="prepared-group"
          >
            <p className="text-sm">
              <span className="font-semibold">Lot préparé au back-office</span> ·{' '}
              {group.orders.length} commandes ·{' '}
              {formatEurCents(group.orders.reduce((sum, o) => sum + orderCartTotalCents(o), 0))} TTC
              {group.invoiceRequested ? ' · facture demandée' : ''}
            </p>
            <Button
              size="touch"
              onClick={() => transfer(group.orders)}
              data-testid="import-prepared-group"
            >
              <Layers className="mr-2 h-4 w-4" />
              Encaisser le lot
            </Button>
          </div>
        )}
        {sellable.length > 1 && (
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-accent"
              checked={allSelected}
              onChange={toggleAll}
              data-testid="select-all-orders"
            />
            Tout sélectionner ({sellable.length})
          </label>
        )}
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
            {orders.map((o) => {
              const cartTotal = orderCartTotalCents(o);
              const orderTotal = o.total_ttc != null ? Math.round(o.total_ttc * 100) : null;
              const mismatch = orderTotal != null && Math.abs(orderTotal - cartTotal) > 5;
              const canSell = orderSellable(o);
              const checked = selected.has(o.id);
              return (
                <li
                  key={o.id}
                  className={`rounded-xl border bg-bg p-3 ${checked ? 'border-accent' : 'border-border'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <label className="flex flex-1 cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 h-5 w-5 shrink-0 accent-accent"
                        checked={checked}
                        disabled={!canSell}
                        onChange={() => toggle(o.id)}
                        aria-label={`Sélectionner la commande ${o.order_number}`}
                        data-testid="select-order"
                      />
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
                    </label>
                    <Button
                      size="touch"
                      variant="outline"
                      onClick={() => transfer([o])}
                      disabled={!canSell}
                      data-testid="import-order"
                    >
                      Transférer
                    </Button>
                  </div>
                  <ul className="mt-2 pl-8 text-xs text-muted">
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
        {sellable.length > 1 && (
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <p className="text-sm" data-testid="grouped-summary">
              {picked.length === 0
                ? 'Aucune commande sélectionnée'
                : `${picked.length} commande(s) · ${formatEurCents(pickedTotal)} TTC`}
            </p>
            <Button
              size="touch"
              onClick={() => transfer(picked)}
              disabled={picked.length < 2}
              data-testid="import-orders-grouped"
            >
              <Layers className="mr-2 h-4 w-4" />
              Regrouper et transférer
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
