/**
 * Inventaire valorisé au prix d'achat (comptable) : fusion du comptage saisi et du stock système,
 * valorisation, CSV (Excel FR) et document A4. Les données viennent de l'Edge Function
 * `pos-inventory-valuation` (admin) ; le calcul est fait ici pour être testé.
 */

export interface ValuationRaw {
  as_of: string;
  generated_at: string;
  /** Lot compté en cours (pos_inventory_lines). */
  counted: Array<{ product_id: string; label: string; ean: string | null; counted: number }>;
  /** Références au stock boutique non nul + celles du lot, avec prix d'achat HT. */
  products: Array<{
    product_id: string;
    ean: string | null;
    name: string;
    brand: string | null;
    category: string | null;
    stock_boutique: number;
    cost_price: number | string | null;
  }>;
}

export type ValuationSource = 'compté' | 'stock';
export type ValuationFlag = 'stock_negatif' | 'sans_prix_achat';

export interface ValuationLine {
  product_id: string;
  ean: string | null;
  name: string;
  brand: string | null;
  category: string;
  qty: number;
  source: ValuationSource;
  /** Prix d'achat HT unitaire en dix-millièmes d'euro (0,0939 € = 939), null si inconnu. */
  unit_cost_e4: number | null;
  value_cents: number;
  flag: ValuationFlag | null;
}

export interface ValuationCategoryTotal {
  category: string;
  references: number;
  units: number;
  value_cents: number;
}

export interface ValuationReport {
  as_of: string;
  generated_at: string;
  lines: ValuationLine[];
  totals: {
    references: number;
    units: number;
    value_cents: number;
    counted_lines: number;
    stock_lines: number;
    zero_counted: number;
    negative: number;
    without_cost: number;
  };
  by_category: ValuationCategoryTotal[];
}

const NO_CATEGORY = 'Non classé';

function costE4(value: number | string | null): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10_000) : null;
}

/**
 * Quantité retenue : comptage saisi pour les références du lot, stock système pour les autres.
 * Seules les quantités positives sont valorisées ; un stock négatif est signalé (valeur 0), une
 * référence en stock sans prix d'achat aussi. Les quantités nulles sont omises du document.
 */
export function buildValuationReport(raw: ValuationRaw): ValuationReport {
  const countedBy = new Map(raw.counted.map((c) => [c.product_id, c]));
  const seen = new Set<string>();
  const lines: ValuationLine[] = [];
  let zeroCounted = 0;

  const push = (
    id: string,
    meta: { ean: string | null; name: string; brand: string | null; category: string | null },
    qty: number,
    source: ValuationSource,
    cost: number | string | null,
  ): void => {
    if (qty === 0) {
      if (source === 'compté') zeroCounted += 1;
      return;
    }
    const e4 = costE4(cost);
    const flag: ValuationFlag | null =
      qty < 0 ? 'stock_negatif' : e4 === null ? 'sans_prix_achat' : null;
    lines.push({
      product_id: id,
      ean: meta.ean,
      name: meta.name,
      brand: meta.brand,
      category: meta.category?.trim() || NO_CATEGORY,
      qty,
      source,
      unit_cost_e4: e4,
      value_cents: flag === null && e4 !== null ? Math.round((qty * e4) / 100) : 0,
      flag,
    });
  };

  for (const p of raw.products) {
    seen.add(p.product_id);
    const c = countedBy.get(p.product_id);
    push(p.product_id, p, c ? c.counted : p.stock_boutique, c ? 'compté' : 'stock', p.cost_price);
  }
  // Références comptées mais absentes de la base catalogue : listées, sans prix d'achat.
  for (const c of raw.counted) {
    if (seen.has(c.product_id)) continue;
    push(
      c.product_id,
      { ean: c.ean, name: c.label, brand: null, category: null },
      c.counted,
      'compté',
      null,
    );
  }

  lines.sort(
    (a, b) => a.category.localeCompare(b.category, 'fr') || a.name.localeCompare(b.name, 'fr'),
  );

  const byCat = new Map<string, ValuationCategoryTotal>();
  let references = 0;
  let units = 0;
  let value = 0;
  for (const l of lines) {
    const t = byCat.get(l.category) ?? {
      category: l.category,
      references: 0,
      units: 0,
      value_cents: 0,
    };
    if (l.qty > 0) {
      t.references += 1;
      t.units += l.qty;
      t.value_cents += l.value_cents;
      references += 1;
      units += l.qty;
      value += l.value_cents;
    }
    byCat.set(l.category, t);
  }

  return {
    as_of: raw.as_of,
    generated_at: raw.generated_at,
    lines,
    totals: {
      references,
      units,
      value_cents: value,
      counted_lines: lines.filter((l) => l.source === 'compté').length,
      stock_lines: lines.filter((l) => l.source === 'stock').length,
      zero_counted: zeroCounted,
      negative: lines.filter((l) => l.flag === 'stock_negatif').length,
      without_cost: lines.filter((l) => l.flag === 'sans_prix_achat').length,
    },
    by_category: [...byCat.values()].sort((a, b) => a.category.localeCompare(b.category, 'fr')),
  };
}

// --- Formats --------------------------------------------------------------------------------------

const eurFmt = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const eur = (cents: number): string => eurFmt.format(cents / 100).replace(/[\u00a0\u202f]/g, ' ');

/** `939` → « 0,0939 », `2500` → « 0,25 » (au moins 2 décimales, jusqu'à 4). */
export function formatUnitCost(e4: number | null): string {
  if (e4 === null) return '';
  return (e4 / 10_000)
    .toFixed(4)
    .replace(/0{1,2}$/, '')
    .replace('.', ',');
}

/** `2026-11-15` → `15/11/2026`. */
export function formatAsOf(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}

export function inventoryFileName(asOf: string, ext: 'csv' | 'html'): string {
  return `inventaire-valorise-${asOf}.${ext}`;
}

const FLAG_LABEL: Record<ValuationFlag, string> = {
  stock_negatif: 'Stock négatif — non valorisé',
  sans_prix_achat: 'Sans prix d’achat — non valorisé',
};

function csvText(value: string): string {
  // Neutralise l'interprétation d'une formule par le tableur (= + - @) puis protège ; " et retours.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const BOM = String.fromCharCode(0xfeff);

/** CSV Excel FR : séparateur « ; », décimale « , », UTF-8 avec BOM, lignes CRLF. */
export function buildInventoryCsv(report: ValuationReport): string {
  const rows: string[] = [
    [
      'Catégorie',
      'EAN',
      'Désignation',
      'Marque',
      'Quantité',
      'Source',
      'Prix d’achat HT',
      'Valeur HT',
      'Remarque',
    ].join(';'),
  ];
  for (const l of report.lines) {
    rows.push(
      [
        csvText(l.category),
        csvText(l.ean ?? ''),
        csvText(l.name),
        csvText(l.brand ?? ''),
        String(l.qty),
        l.source,
        formatUnitCost(l.unit_cost_e4),
        (l.value_cents / 100).toFixed(2).replace('.', ','),
        l.flag ? csvText(FLAG_LABEL[l.flag]) : '',
      ].join(';'),
    );
  }
  rows.push(
    [
      'TOTAL',
      '',
      `Inventaire au ${formatAsOf(report.as_of)} — valorisation au prix d’achat HT`,
      '',
      String(report.totals.units),
      '',
      '',
      (report.totals.value_cents / 100).toFixed(2).replace('.', ','),
      `${report.totals.references} références`,
    ].join(';'),
  );
  return BOM + rows.join('\r\n') + '\r\n';
}

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface InventoryCompany {
  company_name: string;
  address_lines: string[];
  siret?: string;
}

/** Document A4 (HTML autonome, impression navigateur) : détail par catégorie, totaux, anomalies. */
export function buildInventoryHtml(report: ValuationReport, company: InventoryCompany): string {
  const t = report.totals;
  const groups = new Map<string, ValuationLine[]>();
  for (const l of report.lines) groups.set(l.category, [...(groups.get(l.category) ?? []), l]);
  const catTotal = new Map(report.by_category.map((c) => [c.category, c]));

  const body = [...groups.entries()]
    .map(([cat, ls]) => {
      const ct = catTotal.get(cat);
      const rows = ls
        .map(
          (l) => `<tr${l.flag ? ' class="anom"' : ''}>
        <td>${esc(l.ean ?? '')}</td>
        <td>${esc(l.name)}${l.flag ? `<br><small>${esc(FLAG_LABEL[l.flag])}</small>` : ''}</td>
        <td class="n">${l.qty}</td>
        <td class="c">${l.source === 'compté' ? 'C' : 'S'}</td>
        <td class="n">${esc(formatUnitCost(l.unit_cost_e4))}</td>
        <td class="n">${esc(eur(l.value_cents))}</td>
      </tr>`,
        )
        .join('');
      return `<tr class="cat"><td colspan="6">${esc(cat)}</td></tr>${rows}
      <tr class="sub"><td colspan="2">Sous-total ${esc(cat)}</td><td class="n">${ct?.units ?? 0}</td><td></td><td></td><td class="n">${esc(eur(ct?.value_cents ?? 0))}</td></tr>`;
    })
    .join('');

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>Inventaire au ${esc(formatAsOf(report.as_of))}</title>
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font: 9.5pt/1.35 Arial, Helvetica, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 17pt; margin: 8px 0 2px; }
  .meta { color: #444; font-size: 9pt; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; background: #eee; }
  th, td { padding: 3px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
  .n { text-align: right; white-space: nowrap; }
  .c { text-align: center; }
  tr.cat td { background: #f4f4f4; font-weight: bold; }
  tr.sub td { font-weight: bold; border-bottom: 1px solid #999; }
  tr.anom td { background: #fff4e5; }
  small { color: #8a4b00; }
  .total { margin-top: 14px; width: 55%; margin-left: auto; }
  .total td { font-size: 11pt; font-weight: bold; border-top: 2px solid #111; }
  .note { margin-top: 14px; color: #333; font-size: 8.5pt; }
  thead { display: table-header-group; } tr { page-break-inside: avoid; }
</style></head><body>
  <strong>${esc(company.company_name)}</strong>${company.address_lines.length ? `<br>${company.address_lines.map(esc).join('<br>')}` : ''}${company.siret ? `<br>SIRET ${esc(company.siret)}` : ''}
  <h1>Inventaire au ${esc(formatAsOf(report.as_of))}</h1>
  <div class="meta">Valorisation au prix d’achat HT · édité le ${esc(new Date(report.generated_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }))}</div>
  <table>
    <thead><tr><th>EAN</th><th>Désignation</th><th class="n">Qté</th><th class="c">Src</th><th class="n">PA HT</th><th class="n">Valeur HT</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <table class="total">
    <tr><td>Total ${t.references} références · ${t.units} unités</td><td class="n">${esc(eur(t.value_cents))} HT</td></tr>
  </table>
  <p class="note">Source : C = quantité comptée et saisie en caisse (${t.counted_lines} lignes) ; S = stock enregistré en caisse pour les références non comptées (${t.stock_lines} lignes).
  Seul le stock physique de la boutique est valorisé, au prix d’achat HT enregistré. Les stocks négatifs (${t.negative}) et les références sans prix d’achat (${t.without_cost}) ne sont pas valorisés.</p>
</body></html>`;
}

/** Télécharge un texte (CSV) côté navigateur. */
export function downloadText(content: string, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
