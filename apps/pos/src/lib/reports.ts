import {
  CLOSING_REPORT_KIND,
  buildReport,
  normalizePaymentFigures,
  summarizeTickets,
} from '@pos/core';
import type { ReportFigures, ReportPayload, TicketPayload } from '@pos/core';
import { env } from '@/lib/env';
import { headerFrom } from '@/lib/ticket';
import { cachedTicketSettings } from '@/lib/ticketSettings';
import type { PosClosing, PosSession, XReportResult } from '@/types/pos';

/** Version imprimée : celle de `pos_settings.software` (serveur), sinon celle de la PWA. */
function appVersion(): string {
  return cachedTicketSettings()?.software?.version ?? env.appVersion;
}

function operatorName(email: string | null | undefined): string | null {
  return email ? (email.split('@')[0] ?? null) : null;
}

/** Lecture X serveur (`pos_x_report`) → rapport imprimable. */
export function xReport(x: XReportResult, operatorEmail?: string | null): ReportPayload {
  return buildReport(
    { ...x.figures, payments: normalizePaymentFigures(x.figures.payments) },
    {
      kind: 'X',
      register_code: x.register_code,
      header: headerFrom(cachedTicketSettings()),
      period_start: x.session.opened_at,
      period_end: null,
      printed_at: x.generated_at,
      app_version: appVersion(),
      number: x.x_number,
      session_number: x.session.session_number,
      operator: operatorName(operatorEmail),
    },
  );
}

/** Clôture enregistrée (`pos_closings`) → rapport Z1 / Z2 / Z3 (duplicata si réimpression). */
export function closingReport(
  closing: PosClosing,
  opts: { registerCode: string; session?: PosSession | null; duplicate?: boolean },
): ReportPayload {
  const session = opts.session && opts.session.id === closing.session_id ? opts.session : null;
  const figures: ReportFigures = {
    txn_count: Number(closing.txn_count),
    first_ticket_number: closing.first_ticket_number,
    last_ticket_number: closing.last_ticket_number,
    total_ht_cents: Number(closing.total_ht_cents),
    total_vat_cents: Number(closing.total_vat_cents),
    total_ttc_cents: Number(closing.total_ttc_cents),
    refunds_ttc_cents: Number(closing.refunds_ttc_cents),
    vat_breakdown: closing.vat_breakdown ?? [],
    payments: normalizePaymentFigures(closing.payments_breakdown),
    grand_total_perpetual_cents: Number(closing.grand_total_perpetual_cents),
    ...(session && session.expected_cash_cents != null
      ? {
          cash: {
            opening_float_cents: session.opening_float_cents,
            expected_cash_cents: session.expected_cash_cents,
            counted_cash_cents: session.counted_cash_cents,
            variance_cents: session.variance_cents,
          },
        }
      : {}),
  };
  return buildReport(figures, {
    kind: CLOSING_REPORT_KIND[closing.period_type],
    register_code: opts.registerCode,
    header: headerFrom(cachedTicketSettings()),
    period_start: closing.period_start,
    period_end: closing.period_end,
    printed_at: opts.duplicate ? new Date().toISOString() : closing.created_at,
    app_version: appVersion(),
    number: closing.closing_number,
    session_number: session?.session_number ?? null,
    hash: closing.hash,
    duplicate: opts.duplicate === true,
  });
}

/** Lecture X du mode formation : tickets locaux uniquement, marquée « FORMATION ». */
export function trainingXReport(
  tickets: TicketPayload[],
  opts: { registerCode: string; startedAt: string | null; operatorEmail?: string | null },
): ReportPayload {
  const now = new Date().toISOString();
  return buildReport(summarizeTickets(tickets), {
    kind: 'X',
    register_code: opts.registerCode,
    header: headerFrom(cachedTicketSettings()),
    period_start: opts.startedAt ?? now,
    period_end: null,
    printed_at: now,
    app_version: appVersion(),
    operator: operatorName(opts.operatorEmail),
    training: true,
  });
}
