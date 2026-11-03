import { useMemo, useState, type ReactNode } from 'react';
import { Archive, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { countsInRevenue, shopifyDayKpi, useShopifyPosDay } from '@/hooks/useShopifyPosHistory';
import { formatEurCents, formatQty, formatTime } from '@/lib/format';
import { errorMessage } from '@/lib/utils';
import type { ShopifyPosOrder } from '@/types/pos';

const STATUS_BADGE: Record<string, { label: string; variant: 'danger' | 'warning' }> = {
  refunded: { label: 'Remboursée', variant: 'danger' },
  partially_refunded: { label: 'Remb. partiel', variant: 'warning' },
};

function Kpi({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="text-2xl font-semibold tabular" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

function OrderDetail({ order }: { order: ShopifyPosOrder }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="shopify-order-detail">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-lg font-semibold">Commande {order.name}</h3>
        <span className="text-sm text-muted">{formatTime(order.created_at)}</span>
      </div>
      {order.customer_name && <p className="mb-2 text-sm text-muted">{order.customer_name}</p>}
      <ul className="divide-y divide-border rounded-xl border border-border">
        {order.lines.map((l, i) => (
          <li key={i} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="font-medium">{l.title ?? 'Article'}</p>
              <p className="text-muted">
                {formatQty(Number(l.qty))} × {formatEurCents(Number(l.price_cents))}
                {l.sku ? ` · ${l.sku}` : ''}
              </p>
            </div>
            <span className="tabular">
              {formatEurCents(Number(l.qty) * Number(l.price_cents) - Number(l.discount_cents))}
            </span>
          </li>
        ))}
      </ul>
      <dl className="mt-3 space-y-1 text-sm">
        {Number(order.total_discount_cents) > 0 && (
          <div className="flex justify-between">
            <dt className="text-muted">Remises</dt>
            <dd className="tabular">−{formatEurCents(Number(order.total_discount_cents))}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-muted">dont TVA</dt>
          <dd className="tabular">{formatEurCents(Number(order.total_tax_cents))}</dd>
        </div>
        <div className="flex justify-between text-base font-semibold">
          <dt>Total TTC</dt>
          <dd className="tabular">{formatEurCents(Number(order.total_ttc_cents))}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted">Règlement</dt>
          <dd>{order.payment_methods.join(' · ') || '—'}</dd>
        </div>
      </dl>
    </div>
  );
}

export interface ShopifyDayViewProps {
  date: string;
  /** Libellé lisible du jour (titre). */
  dayLabel: string;
  /** Sélecteur de jour de l'historique, affiché en tête. */
  nav: ReactNode;
}

/**
 * Jour de l'ancienne caisse Shopify POS : consultation seule, HORS PÉRIMÈTRE NF525.
 * Aucun duplicata ni remboursement : ces ventes n'existent pas dans le journal fiscal de la caisse.
 */
export function ShopifyDayView({ date, dayLabel, nav }: ShopifyDayViewProps) {
  const day = useShopifyPosDay(date);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const orders = useMemo(() => day.data ?? [], [day.data]);
  const kpi = useMemo(() => shopifyDayKpi(orders), [orders]);
  const selected = orders.find((o) => o.id === selectedId) ?? null;

  return (
    <div className="grid h-full grid-cols-[1fr_440px]" data-testid="history-page">
      <section className="flex min-h-0 flex-col p-4">
        {nav}
        <p
          className="mb-3 flex items-start gap-2 rounded-xl bg-border/50 px-3 py-2 text-sm text-muted"
          data-testid="shopify-notice"
        >
          <Archive className="mt-0.5 h-4 w-4 shrink-0" />
          Ventes de l’ancienne caisse Shopify POS, en consultation seule : hors journal fiscal NF525
          de cette caisse, ni duplicata ni remboursement ici. Leur valeur fiscale reste dans les
          archives Shopify.
        </p>
        <div
          className="grid grid-cols-[minmax(0,1.3fr)_repeat(3,minmax(0,1fr))] items-center gap-4 rounded-2xl border border-border bg-surface px-4 py-3"
          data-testid="day-kpi"
        >
          <p className="text-sm text-muted">Shopify POS · archive</p>
          <Kpi label="CA net" value={formatEurCents(kpi.net_ttc_cents)} testId="kpi-net" />
          <Kpi label="Commandes" value={String(kpi.orders)} testId="kpi-tickets" />
          <Kpi
            label="Panier moyen"
            value={formatEurCents(kpi.avg_basket_cents)}
            testId="kpi-basket"
          />
        </div>
        <div className="mb-3 mt-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-xl font-semibold">
            Ventes Shopify POS du {dayLabel}
            <Badge variant="muted" data-testid="history-day-shopify">
              Shopify POS
            </Badge>
          </h2>
          <span className="text-sm text-muted">
            {orders.length} commande(s) · {formatEurCents(kpi.net_ttc_cents)}
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-surface">
          {day.isError && <p className="p-4 text-danger">{errorMessage(day.error)}</p>}
          {day.isLoading && (
            <div className="flex justify-center p-6 text-muted">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Commande</TableHead>
                <TableHead>Heure</TableHead>
                <TableHead>Client</TableHead>
                <TableHead>Règlement</TableHead>
                <TableHead className="text-right">TTC</TableHead>
                <TableHead>Statut</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((o) => {
                const status = o.financial_status ? STATUS_BADGE[o.financial_status] : undefined;
                return (
                  <TableRow
                    key={o.id}
                    data-state={selectedId === o.id ? 'selected' : undefined}
                    className="h-14 cursor-pointer hover:bg-border/40"
                    onClick={() => setSelectedId(o.id)}
                    data-testid="shopify-row"
                  >
                    <TableCell className="font-medium">{o.name}</TableCell>
                    <TableCell>{formatTime(o.created_at)}</TableCell>
                    <TableCell className="text-muted">{o.customer_name ?? ''}</TableCell>
                    <TableCell>{o.payment_methods.join(' · ')}</TableCell>
                    <TableCell
                      className={
                        countsInRevenue(o)
                          ? 'text-right font-semibold tabular'
                          : 'text-right tabular text-muted line-through'
                      }
                    >
                      {formatEurCents(Number(o.total_ttc_cents))}
                    </TableCell>
                    <TableCell>
                      {status && <Badge variant={status.variant}>{status.label}</Badge>}
                    </TableCell>
                  </TableRow>
                );
              })}
              {day.data && orders.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-muted">
                    Aucune vente Shopify POS ce jour-là.
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
        {selected ? (
          <OrderDetail order={selected} />
        ) : (
          <p className="m-auto text-muted">Sélectionnez une commande.</p>
        )}
      </aside>
    </div>
  );
}
