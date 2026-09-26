import type { PosTransaction } from '@/types/pos';

/** Indicateurs du jour de la caisse, à partir des tickets du jour (`pos_today_transactions`). */
export interface DayKpi {
  /** CA TTC net : ventes − remboursements. */
  net_ttc_cents: number;
  sales_count: number;
  refunds_count: number;
  refunds_ttc_cents: number;
  /** Panier moyen sur les seules ventes (0 sans vente). */
  avg_basket_cents: number;
}

export function computeDayKpi(tickets: readonly PosTransaction[]): DayKpi {
  let salesTtc = 0;
  let salesCount = 0;
  let refundsTtc = 0;
  let refundsCount = 0;
  for (const t of tickets) {
    const ttc = Number(t.total_ttc_cents);
    if (t.kind === 'refund') {
      refundsCount += 1;
      refundsTtc += Math.abs(ttc);
    } else {
      salesCount += 1;
      salesTtc += ttc;
    }
  }
  return {
    net_ttc_cents: salesTtc - refundsTtc,
    sales_count: salesCount,
    refunds_count: refundsCount,
    refunds_ttc_cents: refundsTtc,
    avg_basket_cents: salesCount > 0 ? Math.round(salesTtc / salesCount) : 0,
  };
}
