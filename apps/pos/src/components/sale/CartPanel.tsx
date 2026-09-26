import { useEffect, useMemo, useState } from 'react';
import { Clock, Loader2, Minus, PauseCircle, Percent, Plus, Trash2 } from 'lucide-react';
import type { ComputedLine } from '@pos/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Separator } from '@/components/ui/separator';
import { useIsAdmin } from '@/hooks/useIsAdmin';
import { formatEurCents, formatPercent, formatQty, formatVatRate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { selectTotals, useCartStore } from '@/stores/cartStore';
import type { CartLine } from '@/stores/cartStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { CustomerBadge } from '@/components/customer/CustomerBadge';
import { LineDiscountDialog } from './LineDiscountDialog';
import { QtyDialog } from './QtyDialog';

interface CartLineRowProps {
  line: CartLine;
  computed: ComputedLine | undefined;
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onDiscount: (line: CartLine) => void;
  onEditQty: (line: CartLine) => void;
}

function CartLineRow({ line, computed, onQty, onRemove, onDiscount, onEditQty }: CartLineRowProps) {
  const pro = !!line.pricing_rule_id;
  const publicPrice = line.public_price_ttc_cents ?? null;
  const lowStock = line.stock_boutique !== null && line.stock_boutique < line.qty;
  return (
    <li
      className="flex flex-col gap-1.5 border-b border-border px-3 py-2.5"
      data-testid="cart-line"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">{line.label}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            {line.price_tier_title && <Badge variant="secondary">{line.price_tier_title}</Badge>}
            {pro && <Badge variant="success">Tarif pro</Badge>}
            {line.price_overridden && !line.price_tier_title && (
              <Badge variant="warning">Prix forcé</Badge>
            )}
            {(computed?.discount_percent ?? 0) > 0 && (
              <Badge variant="warning">−{formatPercent(computed?.discount_percent ?? 0)}</Badge>
            )}
            {lowStock && <Badge variant="warning">Stock {line.stock_boutique}</Badge>}
            <span>TVA {formatVatRate(line.vat_rate)}</span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-base font-semibold tabular">
            {formatEurCents(computed?.line_ttc_cents ?? 0)}
          </p>
          <p className="text-xs text-muted tabular">
            {pro && publicPrice !== null && publicPrice !== line.unit_price_ttc_cents && (
              <span className="mr-1 line-through">{formatEurCents(publicPrice)}</span>
            )}
            {formatEurCents(line.unit_price_ttc_cents)} / u
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="secondary"
          size="icon-touch"
          aria-label="Diminuer"
          onClick={() => onQty(line.key, line.qty - 1)}
        >
          <Minus className="h-5 w-5" />
        </Button>
        <button
          type="button"
          className="min-h-touch min-w-[56px] rounded-lg text-center text-lg font-semibold tabular hover:bg-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => onEditQty(line)}
          aria-label={`Quantité ${formatQty(line.qty)}, modifier`}
          data-testid="line-qty"
        >
          {formatQty(line.qty)}
        </button>
        <Button
          variant="secondary"
          size="icon-touch"
          aria-label="Augmenter"
          onClick={() => onQty(line.key, line.qty + 1)}
        >
          <Plus className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-touch"
          aria-label="Remise"
          onClick={() => onDiscount(line)}
          className="ml-auto"
        >
          <Percent className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon-touch"
          aria-label="Supprimer"
          onClick={() => onRemove(line.key)}
          className="text-danger"
        >
          <Trash2 className="h-5 w-5" />
        </Button>
      </div>
    </li>
  );
}

export interface CartPanelProps {
  onCheckout: () => void;
  onCustomer: () => void;
  onQuotes: () => void;
  onPark: () => void;
  onShowParked: () => void;
  parkedCount: number;
  /** Tarifs pro en cours de résolution : l'encaissement attend (totaux non définitifs). */
  pricingBusy: boolean;
  /** Un dialogue du panier est ouvert (la douchette et les raccourcis sont suspendus). */
  onModalChange: (open: boolean) => void;
  onGlobalDiscount: () => void;
}

/** Colonne droite : client, lignes, totaux, bouton Encaisser. */
export function CartPanel({
  onCheckout,
  onCustomer,
  onQuotes,
  onPark,
  onShowParked,
  parkedCount,
  pricingBusy,
  onModalChange,
  onGlobalDiscount,
}: CartPanelProps) {
  const lines = useCartStore((s) => s.lines);
  const setQty = useCartStore((s) => s.setQty);
  const setDiscount = useCartStore((s) => s.setDiscount);
  const setUnitPrice = useCartStore((s) => s.setUnitPrice);
  const remove = useCartStore((s) => s.remove);
  const clear = useCartStore((s) => s.clear);
  const [discountLine, setDiscountLine] = useState<CartLine | null>(null);
  const [qtyLine, setQtyLine] = useState<CartLine | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const maxDiscountPercent = useSettingsStore((s) => s.maxDiscountPercent);
  const { isAdmin } = useIsAdmin();
  const modalOpen = discountLine !== null || qtyLine !== null || confirmClear;
  useEffect(() => {
    onModalChange(modalOpen);
  }, [modalOpen, onModalChange]);
  const globalDiscount = useCartStore((s) => s.global_discount_percent);
  const totals = useMemo(
    () => selectTotals({ lines, global_discount_percent: globalDiscount }),
    [lines, globalDiscount],
  );
  /** Montant réellement retiré par la remise globale (au-delà des remises de ligne). */
  const globalSavedCents = useMemo(
    () =>
      globalDiscount > 0 ? selectTotals({ lines }).total_ttc_cents - totals.total_ttc_cents : 0,
    [lines, globalDiscount, totals],
  );
  const computedByKey = useMemo(() => {
    const map = new Map<string, ComputedLine>();
    totals.lines.forEach((c, i) => {
      const key = lines[i]?.key;
      if (key) map.set(key, c);
    });
    return map;
  }, [totals, lines]);

  return (
    <aside
      className="flex h-full min-h-0 flex-col border-l border-border bg-surface"
      data-testid="cart-panel"
    >
      <CustomerBadge onSearch={onCustomer} onQuotes={onQuotes} />
      <Separator />
      <div className="flex items-center gap-1 px-3 py-1 text-xs uppercase tracking-wide text-muted">
        <span className="flex-1">
          Panier · {lines.length} {lines.length > 1 ? 'lignes' : 'ligne'}
        </span>
        <Button
          variant="ghost"
          size="touch"
          className="px-3 text-sm normal-case"
          onClick={onShowParked}
          title="Tickets en attente (F9)"
          data-testid="show-parked"
        >
          <Clock className="h-4 w-4" />
          {parkedCount > 0 ? <Badge variant="secondary">{parkedCount}</Badge> : null}
        </Button>
        {lines.length > 0 && (
          <>
            <Button
              variant="ghost"
              size="touch"
              className="px-3 text-sm normal-case"
              onClick={onPark}
              title="Mettre en attente (F8)"
              data-testid="park-cart"
            >
              <PauseCircle className="h-4 w-4" /> Attente
            </Button>
            <Button
              variant="ghost"
              size="touch"
              className="px-3 text-sm normal-case text-danger"
              onClick={() => setConfirmClear(true)}
              data-testid="clear-cart"
            >
              Vider
            </Button>
          </>
        )}
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {lines.length === 0 && <li className="px-3 py-8 text-center text-muted">Panier vide</li>}
        {lines.map((line) => (
          <CartLineRow
            key={line.key}
            line={line}
            computed={computedByKey.get(line.key)}
            onQty={setQty}
            onRemove={remove}
            onDiscount={setDiscountLine}
            onEditQty={setQtyLine}
          />
        ))}
      </ul>
      <div className="border-t border-border px-4 pt-3">
        {lines.length > 0 && (
          <button
            type="button"
            onClick={onGlobalDiscount}
            className="mb-1 flex min-h-touch w-full items-center justify-between rounded-lg text-sm text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            title="Remise globale (F6)"
            data-testid="global-discount"
          >
            <span className="flex items-center gap-1.5">
              <Percent className="h-4 w-4" />
              {globalDiscount > 0
                ? `Remise globale −${formatPercent(globalDiscount)}`
                : 'Remise globale'}
            </span>
            {globalDiscount > 0 && (
              <span className="tabular text-warning" data-testid="global-discount-amount">
                −{formatEurCents(globalSavedCents)}
              </span>
            )}
          </button>
        )}
        <div className="flex justify-between text-sm text-muted">
          <span>Total HT</span>
          <span className="tabular">{formatEurCents(totals.total_ht_cents)}</span>
        </div>
        {totals.vat_breakdown.map((v) => (
          <div key={v.rate} className="flex justify-between text-sm text-muted">
            <span>TVA {formatVatRate(v.rate)}</span>
            <span className="tabular">{formatEurCents(v.vat_cents)}</span>
          </div>
        ))}
        <div className="mt-2 flex items-baseline justify-between">
          <span className="text-lg font-medium">Total TTC</span>
          <span className="text-[44px] font-bold leading-none tabular" data-testid="cart-total">
            {formatEurCents(totals.total_ttc_cents)}
          </span>
        </div>
      </div>
      <div className="p-4 pt-3">
        <Button
          size="pay"
          className={cn('w-full', lines.length === 0 && 'opacity-40')}
          disabled={lines.length === 0 || pricingBusy}
          onClick={onCheckout}
          title="Encaisser (F12)"
          data-testid="checkout-button"
        >
          {pricingBusy ? (
            <>
              <Loader2 className="h-5 w-5 animate-spin" /> Tarifs pro…
            </>
          ) : (
            <>Encaisser {lines.length > 0 && formatEurCents(totals.total_ttc_cents)}</>
          )}
        </Button>
      </div>
      <LineDiscountDialog
        line={discountLine}
        onClose={() => setDiscountLine(null)}
        onDiscount={setDiscount}
        onUnitPrice={setUnitPrice}
        maxPercent={maxDiscountPercent}
        isAdmin={isAdmin}
      />
      <QtyDialog line={qtyLine} onClose={() => setQtyLine(null)} onQty={setQty} />
      <ConfirmDialog
        open={confirmClear}
        title="Vider le panier ?"
        description={`${lines.length} ligne(s) · ${formatEurCents(totals.total_ttc_cents)}. L’abandon est tracé au journal. Pour garder le panier, mettez-le en attente.`}
        confirmLabel="Vider le panier"
        danger
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          clear('abandoned');
          setConfirmClear(false);
        }}
      />
    </aside>
  );
}
