import { useQuery } from '@tanstack/react-query';
import { edge } from '@/lib/edge';
import type { ShopifyPosOrder } from '@/types/pos';

/**
 * Historique de l'ancienne caisse Shopify POS (avant la bascule NF525) — HORS FISCAL,
 * consultation seule. Données figées : cache long, aucune nouvelle tentative (un échec laisse
 * simplement la liste des jours sans Shopify).
 */
export function useShopifyPosDays() {
  return useQuery({
    queryKey: ['shopify-pos', 'days'],
    queryFn: () => edge.shopifyPosDays(),
    staleTime: 30 * 60_000,
    retry: false,
  });
}

/** Commandes Shopify POS d'une date métier ; inactif si `date` est nul. */
export function useShopifyPosDay(date: string | null) {
  return useQuery({
    queryKey: ['shopify-pos', 'day', date],
    queryFn: () => edge.shopifyPosDay(date ?? ''),
    enabled: !!date,
    staleTime: 30 * 60_000,
    retry: false,
  });
}

/** CA du jour : hors commandes remboursées ou annulées, comme le dashboard /admin. */
export function countsInRevenue(o: Pick<ShopifyPosOrder, 'financial_status'>): boolean {
  return o.financial_status !== 'refunded' && o.financial_status !== 'voided';
}

export interface ShopifyDayKpi {
  net_ttc_cents: number;
  orders: number;
  avg_basket_cents: number;
}

export function shopifyDayKpi(orders: readonly ShopifyPosOrder[]): ShopifyDayKpi {
  const counted = orders.filter(countsInRevenue);
  const net = counted.reduce((s, o) => s + Number(o.total_ttc_cents), 0);
  return {
    net_ttc_cents: net,
    orders: counted.length,
    avg_basket_cents: counted.length > 0 ? Math.round(net / counted.length) : 0,
  };
}
