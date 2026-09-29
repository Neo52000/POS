/**
 * Rapports de caisse imprimables (SPEC §13) : lecture X (intermédiaire, sans remise à zéro) et
 * clôtures Z1 (jour / session), Z2 (mois), Z3 (année).
 *
 * Un seul format (`ReportPayload`) pour l'aperçu PWA et l'impression par le pont (ESC/POS ou
 * Star) : des sections de lignes `libellé … valeur` déjà formatées. Le pont n'a donc aucune règle
 * métier à connaître ; toute la logique est ici, testée une fois.
 */
import { PAYMENT_METHOD_LABELS, isPaymentMethod } from './cart.js';
import type { VatBreakdownEntry } from './cart.js';
import { formatEurCents } from './money.js';
import { SOFTWARE_NAME } from './ticket.js';
import type { TicketHeader } from './ticket.js';

export const REPORT_PAYLOAD_VERSION = 1;

/** X = lecture ; Z1 = clôture journalière (session) ; Z2 = mensuelle ; Z3 = annuelle. */
export type ReportKind = 'X' | 'Z1' | 'Z2' | 'Z3';

export const REPORT_KINDS: readonly ReportKind[] = ['X', 'Z1', 'Z2', 'Z3'];

/** `period_type` de `pos_closings` ↔ type de rapport Z. */
export const CLOSING_REPORT_KIND: Readonly<Record<'daily' | 'monthly' | 'annual', ReportKind>> = {
  daily: 'Z1',
  monthly: 'Z2',
  annual: 'Z3',
};

export const REPORT_TITLES: Readonly<Record<ReportKind, string>> = {
  X: 'LECTURE X',
  Z1: 'CLÔTURE JOURNALIÈRE Z1',
  Z2: 'CLÔTURE MENSUELLE Z2',
  Z3: 'CLÔTURE ANNUELLE Z3',
};

export interface ReportRow {
  label: string;
  /** Valeur déjà formatée (montant, nombre, date). Absente : ligne de texte seule. */
  value?: string;
  bold?: boolean;
}

export interface ReportSection {
  title?: string;
  rows: ReportRow[];
}

/** Document imprimable (aperçu HTML PWA, rendu ESC/POS / Star par le pont). */
export interface ReportPayload {
  version: typeof REPORT_PAYLOAD_VERSION;
  kind: ReportKind;
  title: string;
  /** Mention sous le titre (ex. « Document non fiscal »). */
  subtitle?: string;
  register_code: string;
  header: TicketHeader;
  /** Horodatage d'édition (ISO UTC). */
  printed_at: string;
  sections: ReportSection[];
  footer: string[];
  /** Mode formation : imprimé « FORMATION — SANS VALEUR ». */
  training?: boolean;
  /** Réimpression d'une clôture existante. */
  duplicate?: boolean;
  software: typeof SOFTWARE_NAME;
  app_version: string;
}

export interface ReportPaymentFigure {
  method: string;
  amount_cents: number;
  count?: number;
}

/** Chiffres agrégés d'une période (X calculé à la volée, Z lu dans `pos_closings`). */
export interface ReportFigures {
  txn_count: number;
  sales_count?: number;
  refunds_count?: number;
  first_ticket_number: number | null;
  last_ticket_number: number | null;
  total_ht_cents: number;
  total_vat_cents: number;
  total_ttc_cents: number;
  /** Somme (négative) des remboursements TTC. */
  refunds_ttc_cents: number;
  vat_breakdown: VatBreakdownEntry[];
  /** Montants remis par moyen de paiement (espèces : montant tendu, avant rendu). */
  payments: ReportPaymentFigure[];
  /** Rendu monnaie total (connu pour X et en formation). */
  change_cents?: number;
  /** Tiroir : X et Z1 uniquement. */
  cash?: {
    opening_float_cents: number;
    expected_cash_cents: number;
    counted_cash_cents?: number | null;
    variance_cents?: number | null;
  };
  /** Grand total perpétuel (Z) ou projeté (X : dernier Z1 + période en cours). */
  grand_total_perpetual_cents?: number | null;
}

export interface ReportContext {
  kind: ReportKind;
  register_code: string;
  header: TicketHeader;
  period_start: string;
  /** Fin exclusive ; `null` pour une lecture X (période en cours). */
  period_end: string | null;
  printed_at: string;
  app_version: string;
  /** Numéro de clôture (Z) ou de lecture (X, numéro d'événement JET). */
  number?: number | null;
  session_number?: number | null;
  operator?: string | null;
  /** Empreinte chaînée de la clôture (Z). */
  hash?: string | null;
  training?: boolean;
  duplicate?: boolean;
}

const money = (cents: number): string => formatEurCents(cents);

/** `jj/mm/aaaa hh:mm` en heure de Paris. */
export function formatParisDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(date)
    .replace(',', '');
}

/** Libellé de période lisible : `septembre 2026` (Z2), `2026` (Z3), bornes sinon. */
export function formatReportPeriod(
  kind: ReportKind,
  periodStart: string,
  periodEnd: string | null,
): string {
  const start = new Date(periodStart);
  if (kind === 'Z2' && !Number.isNaN(start.getTime())) {
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris',
      month: 'long',
      year: 'numeric',
    }).format(start);
  }
  if (kind === 'Z3' && !Number.isNaN(start.getTime())) {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', year: 'numeric' }).format(
      start,
    );
  }
  const from = formatParisDateTime(periodStart);
  return periodEnd ? `${from} → ${formatParisDateTime(periodEnd)}` : `depuis ${from}`;
}

function formatRate(rate: string): string {
  return `${Number(rate).toFixed(2).replace('.', ',')} %`;
}

function paymentLabel(method: string): string {
  return isPaymentMethod(method) ? PAYMENT_METHOD_LABELS[method] : method;
}

/** Normalise `payments_breakdown` (objet `{method: cents}` ou tableau `[{method, amount_cents}]`). */
export function normalizePaymentFigures(raw: unknown): ReportPaymentFigure[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => {
        const count = r['count'];
        return {
          method: String(r['method'] ?? r['key'] ?? '?'),
          amount_cents: Number(r['amount_cents'] ?? r['total_cents'] ?? r['amount'] ?? 0),
          ...(count !== undefined && count !== null ? { count: Number(count) } : {}),
        };
      });
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([method, v]) => ({
      method,
      amount_cents:
        typeof v === 'number'
          ? v
          : Number((v as { amount_cents?: unknown } | null)?.amount_cents ?? 0),
    }));
  }
  return [];
}

/** Met en page un rapport X / Z1 / Z2 / Z3 (sections identiques à l'écran et sur papier). */
export function buildReport(figures: ReportFigures, ctx: ReportContext): ReportPayload {
  const sections: ReportSection[] = [];
  const isX = ctx.kind === 'X';

  const ident: ReportRow[] = [];
  if (ctx.number != null)
    ident.push({ label: isX ? 'Lecture n°' : 'Clôture n°', value: String(ctx.number) });
  ident.push({ label: 'Caisse', value: ctx.register_code });
  if (ctx.session_number != null)
    ident.push({ label: 'Session', value: `n°${ctx.session_number}` });
  ident.push({
    label: 'Période',
    value: formatReportPeriod(ctx.kind, ctx.period_start, ctx.period_end),
  });
  ident.push({ label: 'Édité le', value: formatParisDateTime(ctx.printed_at) });
  if (ctx.operator) ident.push({ label: 'Opérateur', value: ctx.operator });
  sections.push({ rows: ident });

  const activity: ReportRow[] = [{ label: 'Tickets', value: String(figures.txn_count) }];
  if (figures.first_ticket_number != null || figures.last_ticket_number != null) {
    activity.push({
      label: 'Numéros',
      value: `${figures.first_ticket_number ?? '-'} → ${figures.last_ticket_number ?? '-'}`,
    });
  }
  if (figures.sales_count != null)
    activity.push({ label: 'dont ventes', value: String(figures.sales_count) });
  if (figures.refunds_count != null) {
    activity.push({ label: 'dont remboursements', value: String(figures.refunds_count) });
  }
  sections.push({ title: 'Activité', rows: activity });

  const salesTtc = figures.total_ttc_cents - figures.refunds_ttc_cents;
  sections.push({
    title: "Chiffre d'affaires",
    rows: [
      { label: 'Ventes TTC', value: money(salesTtc) },
      { label: 'Remboursements TTC', value: money(figures.refunds_ttc_cents) },
      { label: 'Total HT', value: money(figures.total_ht_cents) },
      { label: 'Total TVA', value: money(figures.total_vat_cents) },
      { label: 'TOTAL TTC NET', value: money(figures.total_ttc_cents), bold: true },
    ],
  });

  if (figures.vat_breakdown.length > 0) {
    const rows: ReportRow[] = [];
    for (const v of figures.vat_breakdown) {
      rows.push({ label: `${formatRate(v.rate)} base HT`, value: money(v.base_ht_cents) });
      rows.push({ label: `${formatRate(v.rate)} TVA`, value: money(v.vat_cents) });
      rows.push({ label: `${formatRate(v.rate)} TTC`, value: money(v.ttc_cents) });
    }
    sections.push({ title: 'TVA par taux', rows });
  }

  const payments: ReportRow[] = figures.payments
    .filter((p) => p.amount_cents !== 0 || (p.count ?? 0) > 0)
    .sort((a, b) => a.method.localeCompare(b.method))
    .map((p) => ({
      label: `${paymentLabel(p.method)}${p.count != null ? ` (${p.count})` : ''}`,
      value: money(p.amount_cents),
    }));
  if (figures.change_cents != null && figures.change_cents !== 0) {
    payments.push({ label: 'Rendu monnaie', value: money(-figures.change_cents) });
  }
  if (payments.length === 0) payments.push({ label: 'Aucun règlement' });
  sections.push({ title: 'Règlements', rows: payments });

  if (figures.cash) {
    const c = figures.cash;
    const rows: ReportRow[] = [
      { label: 'Fond de caisse', value: money(c.opening_float_cents) },
      { label: 'Espèces attendues', value: money(c.expected_cash_cents), bold: true },
    ];
    if (c.counted_cash_cents != null)
      rows.push({ label: 'Espèces comptées', value: money(c.counted_cash_cents) });
    if (c.variance_cents != null)
      rows.push({ label: 'Écart', value: money(c.variance_cents), bold: true });
    sections.push({ title: 'Tiroir espèces', rows });
  }

  if (figures.grand_total_perpetual_cents != null) {
    sections.push({
      rows: [
        {
          label: isX ? 'Grand total perpétuel (projeté)' : 'Grand total perpétuel',
          value: money(figures.grand_total_perpetual_cents),
          bold: !isX,
        },
      ],
    });
  }

  const footer: string[] = [];
  if (isX) {
    footer.push('Lecture intermédiaire sans remise à zéro.');
    footer.push('Document non fiscal : seul le Z fait foi.');
  } else if (ctx.hash) {
    footer.push(`Empreinte ${ctx.hash.slice(0, 16)}`);
  }
  if (ctx.training) footer.push('MODE FORMATION - AUCUNE VENTE ENREGISTRÉE');

  return {
    version: REPORT_PAYLOAD_VERSION,
    kind: ctx.kind,
    title: REPORT_TITLES[ctx.kind],
    ...(isX ? { subtitle: 'Document non fiscal' } : {}),
    register_code: ctx.register_code,
    header: ctx.header,
    printed_at: ctx.printed_at,
    sections,
    footer,
    ...(ctx.training ? { training: true } : {}),
    ...(ctx.duplicate ? { duplicate: true } : {}),
    software: SOFTWARE_NAME,
    app_version: ctx.app_version,
  };
}

/**
 * Agrège des tickets en chiffres de rapport (mode formation : aucune donnée serveur). Même
 * logique que l'agrégat SQL d'une clôture journalière (sommes des tickets, TVA par taux).
 */
export function summarizeTickets(
  tickets: ReadonlyArray<{
    kind: 'sale' | 'refund';
    ticket_number: number | null;
    total_ht_cents: number;
    total_vat_cents: number;
    total_ttc_cents: number;
    change_cents: number;
    vat_breakdown: VatBreakdownEntry[];
    payments: ReadonlyArray<{ method: string; amount_cents: number }>;
  }>,
): ReportFigures {
  const vat = new Map<string, VatBreakdownEntry>();
  const pay = new Map<string, ReportPaymentFigure>();
  const numbers = tickets
    .map((t) => t.ticket_number)
    .filter((n): n is number => typeof n === 'number');
  const figures: ReportFigures = {
    txn_count: tickets.length,
    sales_count: tickets.filter((t) => t.kind === 'sale').length,
    refunds_count: tickets.filter((t) => t.kind === 'refund').length,
    first_ticket_number: numbers.length ? Math.min(...numbers) : null,
    last_ticket_number: numbers.length ? Math.max(...numbers) : null,
    total_ht_cents: 0,
    total_vat_cents: 0,
    total_ttc_cents: 0,
    refunds_ttc_cents: 0,
    vat_breakdown: [],
    payments: [],
    change_cents: 0,
  };
  for (const t of tickets) {
    figures.total_ht_cents += t.total_ht_cents;
    figures.total_vat_cents += t.total_vat_cents;
    figures.total_ttc_cents += t.total_ttc_cents;
    if (t.kind === 'refund') figures.refunds_ttc_cents += t.total_ttc_cents;
    figures.change_cents = (figures.change_cents ?? 0) + t.change_cents;
    for (const v of t.vat_breakdown) {
      const acc = vat.get(v.rate) ?? { rate: v.rate, base_ht_cents: 0, vat_cents: 0, ttc_cents: 0 };
      acc.base_ht_cents += v.base_ht_cents;
      acc.vat_cents += v.vat_cents;
      acc.ttc_cents += v.ttc_cents;
      vat.set(v.rate, acc);
    }
    for (const p of t.payments) {
      const acc = pay.get(p.method) ?? { method: p.method, amount_cents: 0, count: 0 };
      acc.amount_cents += p.amount_cents;
      acc.count = (acc.count ?? 0) + 1;
      pay.set(p.method, acc);
    }
  }
  figures.vat_breakdown = [...vat.values()].sort((a, b) => Number(a.rate) - Number(b.rate));
  figures.payments = [...pay.values()];
  return figures;
}
