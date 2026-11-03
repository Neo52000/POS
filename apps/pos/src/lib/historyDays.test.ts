import { describe, expect, it } from 'vitest';
import { entryKey, historyEntries, parseEntryKey } from './historyDays';

const z = (date: string, n: number) => ({
  date,
  closing_number: n,
  total_ttc_cents: 100,
  txn_count: 1,
});
const shp = (date: string, orders: number) => ({
  date,
  orders,
  total_ttc_cents: 500,
  total_tax_cents: 83,
});

describe('jours de l’historique', () => {
  it('aujourd’hui en tête, puis NF525 et Shopify mêlés par date, NF525 avant Shopify à date égale', () => {
    const e = historyEntries(
      '2026-11-03',
      [z('2026-11-02', 2), z('2026-10-31', 1)],
      [shp('2026-10-31', 12), shp('2026-10-30', 9)],
    );
    expect(e.map((x) => x.key)).toEqual([
      'nf525:2026-11-03',
      'nf525:2026-11-02',
      'nf525:2026-10-31',
      'shopify:2026-10-31',
      'shopify:2026-10-30',
    ]);
    expect(e[3]).toMatchObject({ orders: 12, total_ttc_cents: 500 });
  });

  it('un Z d’aujourd’hui ne double pas l’entrée du jour', () => {
    const e = historyEntries('2026-11-03', [z('2026-11-03', 3)], []);
    expect(e).toHaveLength(1);
  });

  it('clé ↔ source et date', () => {
    expect(parseEntryKey(entryKey('shopify', '2026-10-30'))).toEqual({
      source: 'shopify',
      date: '2026-10-30',
    });
    expect(parseEntryKey('nf525:2026-11-03').source).toBe('nf525');
  });
});
