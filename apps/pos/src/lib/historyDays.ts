import type { ClosedDay } from '@/hooks/useTodayTickets';
import type { ShopifyPosDay } from '@/types/pos';

/** Source d'un jour de l'historique : caisse NF525 (journal fiscal) ou archive Shopify POS. */
export type HistorySource = 'nf525' | 'shopify';

export interface HistoryEntry {
  key: string;
  source: HistorySource;
  date: string;
  /** Z journalier (NF525) ou commandes (Shopify) : complément du libellé. */
  closing_number?: number;
  orders?: number;
  total_ttc_cents?: number;
}

export const entryKey = (source: HistorySource, date: string): string => `${source}:${date}`;

export function parseEntryKey(key: string): { source: HistorySource; date: string } {
  const [source, date] = key.split(':') as [string, string];
  return { source: source === 'shopify' ? 'shopify' : 'nf525', date: date ?? '' };
}

/**
 * Jours de l'historique, du plus récent au plus ancien : aujourd'hui (NF525) d'abord, puis jours
 * clôturés et jours Shopify POS mêlés par date ; à date égale, la caisse NF525 précède Shopify.
 */
export function historyEntries(
  today: string,
  closed: readonly ClosedDay[],
  shopify: readonly ShopifyPosDay[],
): HistoryEntry[] {
  const rest: HistoryEntry[] = [
    ...closed
      .filter((d) => d.date !== today)
      .map<HistoryEntry>((d) => ({
        key: entryKey('nf525', d.date),
        source: 'nf525',
        date: d.date,
        closing_number: d.closing_number,
        total_ttc_cents: d.total_ttc_cents,
      })),
    ...shopify.map<HistoryEntry>((d) => ({
      key: entryKey('shopify', d.date),
      source: 'shopify',
      date: d.date,
      orders: Number(d.orders),
      total_ttc_cents: Number(d.total_ttc_cents),
    })),
  ].sort(
    (a, b) =>
      b.date.localeCompare(a.date) || (a.source === b.source ? 0 : a.source === 'nf525' ? -1 : 1),
  );
  return [{ key: entryKey('nf525', today), source: 'nf525', date: today }, ...rest];
}
