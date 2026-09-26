import { useEffect } from 'react';
import { publishDisplay } from '@/lib/customerDisplay';
import { selectTotals, useCartStore } from '@/stores/cartStore';
import { useCustomerStore } from '@/stores/customerStore';

/**
 * Diffuse le panier vers l'écran client. Pendant l'encaissement (`locked`), c'est la feuille de
 * paiement qui publie (reste à payer, rendu).
 */
export function useCustomerDisplayPublisher(): void {
  const lines = useCartStore((s) => s.lines);
  const globalDiscount = useCartStore((s) => s.global_discount_percent);
  const locked = useCartStore((s) => s.locked);
  const customerName = useCustomerStore((s) => s.account?.display_name ?? null);

  useEffect(() => {
    if (locked) return;
    if (lines.length === 0) {
      publishDisplay({ type: 'idle' });
      return;
    }
    const totals = selectTotals({ lines, global_discount_percent: globalDiscount });
    publishDisplay({
      type: 'cart',
      lines: totals.lines.map((c, i) => ({
        key: lines[i]?.key ?? String(i),
        label: c.label,
        qty: c.qty,
        unit_price_ttc_cents: c.unit_price_ttc_cents,
        discount_percent: c.discount_percent,
        line_ttc_cents: c.line_ttc_cents,
      })),
      total_ttc_cents: totals.total_ttc_cents,
      global_discount_percent: globalDiscount,
      customer_name: customerName,
    });
  }, [lines, globalDiscount, locked, customerName]);
}
