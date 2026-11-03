/**
 * Mouvements d'espèces hors vente (0.5.0) : remise en banque, retrait / prélèvement, apport.
 * Ni ticket, ni chiffre d'affaires, ni TVA : ils n'entrent que dans les espèces attendues du
 * tiroir (lecture X, clôture Z1). Montant toujours positif ; le sens découle du type.
 */
import { formatEurCents } from './money.js';
import { REPORT_PAYLOAD_VERSION, formatParisDateTime } from './report.js';
import type { ReportPayload, ReportRow } from './report.js';
import { SOFTWARE_NAME } from './ticket.js';
import type { TicketHeader } from './ticket.js';

export type CashMovementKind = 'bank_deposit' | 'withdrawal' | 'cash_in';

export const CASH_MOVEMENT_KINDS: readonly CashMovementKind[] = [
  'bank_deposit',
  'withdrawal',
  'cash_in',
];

export const CASH_MOVEMENT_LABELS: Readonly<Record<CashMovementKind, string>> = {
  bank_deposit: 'Remise en banque',
  withdrawal: 'Retrait / prélèvement',
  cash_in: "Apport d'espèces",
};

export function isCashMovementKind(v: unknown): v is CashMovementKind {
  return typeof v === 'string' && (CASH_MOVEMENT_KINDS as readonly string[]).includes(v);
}

/** Entrée (+1) ou sortie (−1) du tiroir. */
export function cashMovementSign(kind: CashMovementKind): 1 | -1 {
  return kind === 'cash_in' ? 1 : -1;
}

export interface CashMovementFigure {
  kind: CashMovementKind | string;
  amount_cents: number;
  reason: string;
  reference?: string | null;
  created_at: string;
}

export interface CashMovementTotals {
  in_cents: number;
  out_cents: number;
  /** Apports − sorties. */
  net_cents: number;
}

export function cashMovementTotals(movements: readonly CashMovementFigure[]): CashMovementTotals {
  let inCents = 0;
  let outCents = 0;
  for (const m of movements) {
    const amount = Math.abs(Number(m.amount_cents));
    if (m.kind === 'cash_in') inCents += amount;
    else outCents += amount;
  }
  return { in_cents: inCents, out_cents: outCents, net_cents: inCents - outCents };
}

export function cashMovementLabel(kind: string): string {
  return isCashMovementKind(kind) ? CASH_MOVEMENT_LABELS[kind] : kind;
}

/** Montant signé lisible : `−250,00 €` (sortie) ou `50,00 €` (entrée). */
export function signedMovementAmount(m: Pick<CashMovementFigure, 'kind' | 'amount_cents'>): string {
  const amount = Math.abs(Number(m.amount_cents));
  return formatEurCents(m.kind === 'cash_in' ? amount : -amount);
}

/** Lignes « Mouvements d'espèces » d'un rapport X / Z1 (une par mouvement + totaux). */
export function cashMovementRows(movements: readonly CashMovementFigure[]): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const m of movements) {
    rows.push({
      label: `${formatParisDateTime(m.created_at).slice(-5)} ${cashMovementLabel(m.kind)}`,
      value: signedMovementAmount(m),
    });
    const detail = [m.reason, m.reference ? `réf. ${m.reference}` : null]
      .filter(Boolean)
      .join(' · ');
    if (detail) rows.push({ label: `  ${detail}` });
  }
  const t = cashMovementTotals(movements);
  rows.push({ label: 'Total apports', value: formatEurCents(t.in_cents) });
  rows.push({ label: 'Total sorties', value: formatEurCents(-t.out_cents) });
  return rows;
}

export interface CashMovementVoucherContext {
  register_code: string;
  header: TicketHeader;
  session_number?: number | null;
  operator?: string | null;
  app_version: string;
  test_register?: boolean;
}

/**
 * Bon de mouvement d'espèces imprimé (à joindre au bordereau de remise en banque).
 * Transmis au pont au format `ReportPayload` (kind `X` : le pont 0.2.1 n'accepte que X/Z1/Z2/Z3
 * et ne se sert du type que pour son journal) ; titre propre, « Document non fiscal ».
 */
export function buildCashMovementVoucher(
  movement: CashMovementFigure,
  ctx: CashMovementVoucherContext,
): ReportPayload {
  const ident: ReportRow[] = [{ label: 'Caisse', value: ctx.register_code }];
  if (ctx.session_number != null)
    ident.push({ label: 'Session', value: `n°${ctx.session_number}` });
  ident.push({ label: 'Date', value: formatParisDateTime(movement.created_at) });
  if (ctx.operator) ident.push({ label: 'Opérateur', value: ctx.operator });

  const detail: ReportRow[] = [
    { label: 'Type', value: cashMovementLabel(movement.kind) },
    {
      label: 'Montant',
      value: formatEurCents(Math.abs(Number(movement.amount_cents))),
      bold: true,
    },
    { label: 'Sens', value: movement.kind === 'cash_in' ? 'Entrée tiroir' : 'Sortie tiroir' },
    { label: 'Motif', value: movement.reason },
  ];
  if (movement.reference) detail.push({ label: 'Référence', value: movement.reference });

  const footer = ['Document non fiscal : hors chiffre d’affaires.', 'Signature :'];
  if (ctx.test_register) footer.push("CAISSE D'ESSAI - HORS EXPLOITATION");

  return {
    version: REPORT_PAYLOAD_VERSION,
    kind: 'X',
    title: "MOUVEMENT D'ESPÈCES",
    subtitle: 'Document non fiscal',
    register_code: ctx.register_code,
    header: ctx.header,
    printed_at: movement.created_at,
    sections: [{ rows: ident }, { title: 'Mouvement', rows: detail }],
    footer,
    software: SOFTWARE_NAME,
    app_version: ctx.app_version,
  };
}
