import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { htToTtcCents } from '@pos/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCustomerQuotes } from '@/hooks/useCustomerQuotes';
import { formatEurCents } from '@/lib/format';
import { errorMessage } from '@/lib/utils';
import { useCartStore } from '@/stores/cartStore';
import { useCustomerStore } from '@/stores/customerStore';
import type { CustomerQuote } from '@/types/pos';

export interface QuoteImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** `unit_price_ttc_cents = round(unit_price_ht × 100 × (1 + vat_rate / 100))`. */
export function quoteItemUnitTtcCents(item: { unit_price_ht: number; vat_rate: number }): number {
  return htToTtcCents(Math.round(item.unit_price_ht * 100), item.vat_rate);
}

/** Importe un devis dans le panier (remplace le panier courant). */
export function importQuoteIntoCart(quote: CustomerQuote): void {
  const cart = useCartStore.getState();
  cart.clear('quote_import');
  for (const item of quote.items) {
    // Ligne de devis sans quantité vendable : rien à encaisser (la quantité doit être > 0).
    if (!(item.quantity > 0)) continue;
    const cents = quoteItemUnitTtcCents(item);
    const tier = `Devis ${quote.quote_number}`;
    if (item.product_id) {
      cart.addProduct(
        {
          id: item.product_id,
          name: item.label,
          brand: null,
          ean: null,
          image_url: null,
          price_ttc_cents: cents,
          price_ht_cents: Math.round(item.unit_price_ht * 100),
          vat_rate: item.vat_rate,
          eco_tax_cents: 0,
          stock_boutique: 0,
          pos_price_tiers: null,
        },
        {
          qty: item.quantity,
          unit_price_ttc_cents: cents,
          price_tier_title: tier,
          discount_percent: item.discount_percent ?? 0,
          public_price_ttc_cents: null,
          resolvePricing: false,
        },
      );
    } else {
      const line = cart.addFreeLine({
        label: item.label,
        unit_price_ttc_cents: cents,
        vat_rate: item.vat_rate,
        qty: item.quantity,
      });
      cart.setUnitPrice(line.key, cents, { price_tier_title: tier });
      if (item.discount_percent) cart.setDiscount(line.key, item.discount_percent);
    }
  }
  useCartStore.getState().setQuoteId(quote.id);
}

export function QuoteImportDialog({ open, onOpenChange }: QuoteImportDialogProps) {
  const account = useCustomerStore((s) => s.account);
  const setQuotes = useCustomerStore((s) => s.setQuotes);
  const cartCount = useCartStore((s) => s.lines.length);
  const { data, isFetching, isError, error } = useCustomerQuotes(
    open && account ? account.id : null,
  );
  useEffect(() => {
    if (data) setQuotes(data);
  }, [data, setQuotes]);

  const pick = (quote: CustomerQuote): void => {
    importQuoteIntoCart(quote);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl">
        <DialogHeader>
          <DialogTitle>Devis ouverts · {account?.display_name}</DialogTitle>
          <DialogDescription>
            L’import remplace le panier courant{cartCount > 0 ? ` (${cartCount} ligne(s))` : ''} par
            les lignes du devis.
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
            <p className="py-6 text-center text-muted">Aucun devis ouvert.</p>
          )}
          <ul className="flex flex-col gap-2">
            {(data ?? []).map((q) => (
              <li key={q.id} className="rounded-xl border border-border bg-bg p-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {q.quote_number} <Badge variant="secondary">{q.status}</Badge>
                    </p>
                    <p className="text-xs text-muted">
                      {q.items.length} ligne(s)
                      {q.valid_until ? ` · valable jusqu’au ${q.valid_until}` : ''}
                      {q.total_ttc != null
                        ? ` · ${formatEurCents(Math.round(q.total_ttc * 100))} TTC`
                        : ''}
                    </p>
                  </div>
                  <Button size="touch" onClick={() => pick(q)} data-testid="import-quote">
                    Importer
                  </Button>
                </div>
                <ul className="mt-2 text-xs text-muted">
                  {q.items.slice(0, 4).map((it, i) => (
                    <li key={i}>
                      {it.quantity} × {it.label} — {formatEurCents(quoteItemUnitTtcCents(it))} TTC
                    </li>
                  ))}
                  {q.items.length > 4 && <li>…</li>}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
