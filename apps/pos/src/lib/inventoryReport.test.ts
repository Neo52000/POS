import { describe, expect, it } from 'vitest';
import {
  buildInventoryCsv,
  buildInventoryHtml,
  buildValuationReport,
  formatAsOf,
  formatUnitCost,
} from './inventoryReport';
import type { ValuationRaw } from './inventoryReport';

const raw: ValuationRaw = {
  as_of: '2026-11-15',
  generated_at: '2026-11-16T10:00:00.000Z',
  counted: [
    { product_id: 'p1', label: 'Cahier', ean: '111', counted: 12 },
    { product_id: 'p3', label: 'Stylo compté à zéro', ean: null, counted: 0 },
    { product_id: 'p9', label: 'Inconnu du catalogue', ean: null, counted: 2 },
  ],
  products: [
    {
      product_id: 'p1',
      ean: '111',
      name: 'Cahier',
      brand: 'Oxford',
      category: 'Papier',
      stock_boutique: 15,
      cost_price: '2.5000',
    },
    {
      product_id: 'p2',
      ean: '222',
      name: 'Copie N/B',
      brand: null,
      category: 'Papier',
      stock_boutique: 100,
      cost_price: 0.0356,
    },
    {
      product_id: 'p3',
      ean: null,
      name: 'Stylo',
      brand: null,
      category: 'Écriture',
      stock_boutique: 4,
      cost_price: 1,
    },
    {
      product_id: 'p4',
      ean: '444',
      name: 'Gomme',
      brand: null,
      category: 'Écriture',
      stock_boutique: -3,
      cost_price: 0.5,
    },
    {
      product_id: 'p5',
      ean: '555',
      name: 'Colle',
      brand: null,
      category: null,
      stock_boutique: 7,
      cost_price: null,
    },
    {
      product_id: 'p6',
      ean: '666',
      name: '=Formule;piège',
      brand: null,
      category: 'Papier',
      stock_boutique: 1,
      cost_price: 10,
    },
  ],
};

describe('buildValuationReport', () => {
  const r = buildValuationReport(raw);
  const by = (id: string) => r.lines.find((l) => l.product_id === id);

  it('compté pour les références du lot, stock système pour les autres', () => {
    expect(by('p1')).toMatchObject({ qty: 12, source: 'compté', value_cents: 3000 });
    expect(by('p2')).toMatchObject({ qty: 100, source: 'stock' });
  });

  it('valorise au prix d’achat HT avec arrondi au centime par ligne', () => {
    // 100 × 0,0356 = 3,56 €
    expect(by('p2')!.value_cents).toBe(356);
    expect(by('p2')!.unit_cost_e4).toBe(356);
  });

  it('omet les quantités nulles, signale stock négatif et prix d’achat manquant', () => {
    expect(by('p3')).toBeUndefined();
    expect(r.totals.zero_counted).toBe(1);
    expect(by('p4')).toMatchObject({ flag: 'stock_negatif', value_cents: 0 });
    expect(by('p5')).toMatchObject({
      flag: 'sans_prix_achat',
      value_cents: 0,
      category: 'Non classé',
    });
    expect(by('p9')).toMatchObject({ flag: 'sans_prix_achat', qty: 2, source: 'compté' });
    expect(r.totals.negative).toBe(1);
    expect(r.totals.without_cost).toBe(2);
  });

  it('totaux : références et unités positives, valeur = somme des lignes', () => {
    // p1 3000 + p2 356 + p6 1000 = 4356 ; positives : p1, p2, p5, p6, p9
    expect(r.totals.value_cents).toBe(4356);
    expect(r.totals.references).toBe(5);
    expect(r.totals.units).toBe(12 + 100 + 7 + 1 + 2);
    expect(r.by_category.reduce((s, c) => s + c.value_cents, 0)).toBe(r.totals.value_cents);
    expect(r.totals.counted_lines + r.totals.stock_lines).toBe(r.lines.length);
  });
});

describe('formats', () => {
  it('formatUnitCost / formatAsOf', () => {
    expect(formatUnitCost(939)).toBe('0,0939');
    expect(formatUnitCost(356)).toBe('0,0356');
    expect(formatUnitCost(2500)).toBe('0,25');
    expect(formatUnitCost(25000)).toBe('2,50');
    expect(formatUnitCost(null)).toBe('');
    expect(formatAsOf('2026-11-15')).toBe('15/11/2026');
  });
});

describe('buildInventoryCsv', () => {
  const csv = buildInventoryCsv(buildValuationReport(raw));
  it('BOM, séparateur « ; », décimale « , », ligne TOTAL', () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Catégorie;EAN;Désignation;Marque;Quantité;Source;Prix d’achat HT;Valeur HT;Remarque',
    );
    expect(lines.at(-1)).toMatch(/^TOTAL;;Inventaire au 15\/11\/2026/);
    expect(lines.at(-1)).toContain(';43,56;');
    expect(csv).toContain('Papier;111;Cahier;Oxford;12;compté;2,50;30,00;');
  });
  it('neutralise les formules et protège les séparateurs', () => {
    expect(csv).toContain(`"'=Formule;piège"`);
  });
});

describe('buildInventoryHtml', () => {
  const html = buildInventoryHtml(buildValuationReport(raw), {
    company_name: 'Ma <Papeterie>',
    address_lines: ['10 rue X'],
    siret: '123',
  });
  it('titre daté, société échappée, totaux et mentions', () => {
    expect(html).toContain('Inventaire au 15/11/2026');
    expect(html).toContain('Ma &lt;Papeterie&gt;');
    expect(html).toContain('@page { size: A4');
    expect(html).toContain('5 références');
    expect(html).toContain('Stock négatif — non valorisé');
    expect(html).not.toContain('<Papeterie>');
  });
});
