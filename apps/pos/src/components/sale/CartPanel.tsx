import { useMemo, useState } from 'react';
import { Minus, Percent, Plus, Trash2 } from 'lucide-react';
import type { ComputedLine } from '@pos/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { formatEurCents, formatPercent, formatQty, formatVatRate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { selectTotals, useCartStore } from '@/stores/cartStore';
import type { CartLine } from '@/stores/cartStore';
import { CustomerBadge } from '@/components/customer/CustomerBadge';
import { LineDiscountDialog } from './LineDiscountDialog';

interface CartLineRowProps {
  line: CartLine;
  computed: ComputedLine | undefined;
  onQty: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  onDiscount: (line: CartLine) => void;
}

function CartLineRow({ line, computed, onQty, onRemove, onDiscount }: CartLineRowProps) {
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
            {(line.discount_percent ?? 0) > 0 && (
              <Badge variant="warning">−{formatPercent(line.discount_percent ?? 0)}</Badge>
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
        <span
          className="min-w-[48px] text-center text-lg font-semibold tabular"
          data-testid="line-qty"
        >
          {formatQty(line.qty)}
        </span>
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
}

/** Colonne droite : client, lignes, totaux, bouton Encaisser. */
export function CartPanel({ onCheckout, onCustomer, onQuotes }: CartPanelProps) {
  const lines = useCartStore((s) => s.lines);
  const setQty = useCartStore((s) => s.setQty);
  const setDiscount = useCartStore((s) => s.setDiscount);
  const setUnitPrice = useCartStore((s) => s.setUnitPrice);
  const remove = useCartStore((s) => s.remove);
  const clear = useCartStore((s) => s.clear);
  const [discountLine, setDiscountLine] = useState<CartLine | null>(null);
  const totals = useMemo(() => selectTotals({ lines }), [lines]);
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
      <div className="flex items-center justify-between px-3 py-2 text-xs uppercase tracking-wide text-muted">
        <span>
          Panier · {lines.length} {lines.length > 1 ? 'lignes' : 'ligne'}
        </span>
        {lines.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 text-danger"
            onClick={() => clear('abandoned')}
          >
            Vider
          </Button>
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
          />
        ))}
      </ul>
      <div className="border-t border-border px-4 pt-3">
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
          disabled={lines.length === 0}
          onClick={onCheckout}
          data-testid="checkout-button"
        >
          Encaisser {lines.length > 0 && formatEurCents(totals.total_ttc_cents)}
        </Button>
      </div>
      <LineDiscountDialog
        line={discountLine}
        onClose={() => setDiscountLine(null)}
        onDiscount={setDiscount}
        onUnitPrice={setUnitPrice}
      />
    </aside>
  );
}
