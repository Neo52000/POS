import { useQuery } from '@tanstack/react-query';
import { PAYMENT_METHOD_LABELS, isPaymentMethod } from '@pos/core';
import { formatEurCents } from '@/lib/format';
import { businessDate } from '@/lib/format';
import { rpc, supabase } from '@/lib/supabase';
import { useSessionStore } from '@/stores/sessionStore';
import type { PosClosing, PosPayment, PosTransaction } from '@/types/pos';

export const TODAY_TICKETS_KEY = ['transactions', 'today'] as const;

/** Règlement d'un ticket (moyen + montant), pour la liste du jour. */
export type TicketPayment = Pick<PosPayment, 'transaction_id' | 'method' | 'amount_cents'>;

/** Ticket du jour avec ses règlements (vide si la lecture des paiements échoue). */
export type TodayTicket = PosTransaction & { payments: TicketPayment[] };

/** Règlements groupés par ticket. */
export function groupPayments(rows: readonly TicketPayment[]): Map<string, TicketPayment[]> {
  const out = new Map<string, TicketPayment[]>();
  for (const p of rows) {
    const list = out.get(p.transaction_id) ?? [];
    list.push(p);
    out.set(p.transaction_id, list);
  }
  return out;
}

/**
 * Moyens de règlement d'un ticket : « CB », ou « CB 50,00 € · Espèces 37,18 € » si plusieurs.
 * Montants absolus (un remboursement est enregistré en négatif).
 */
export function paymentSummary(payments: readonly TicketPayment[]): string {
  const label = (m: string): string => (isPaymentMethod(m) ? PAYMENT_METHOD_LABELS[m] : m);
  if (payments.length === 0) return '';
  if (payments.length === 1) return label(payments[0]!.method);
  return payments
    .map((p) => `${label(p.method)} ${formatEurCents(Math.abs(Number(p.amount_cents)))}`)
    .join(' · ');
}

/** Tickets du jour (fuseau Europe/Paris) de la caisse courante. */
export function useTodayTickets() {
  return useDayTickets(businessDate());
}

/** Jour clôturé : date métier + Z journalier correspondant. */
export interface ClosedDay {
  date: string;
  closing_number: number;
  total_ttc_cents: number;
  txn_count: number;
}

type DailyClosingRow = Pick<
  PosClosing,
  'closing_number' | 'period_start' | 'total_ttc_cents' | 'txn_count'
>;

/**
 * Jours clôturés (Z journaliers) du plus récent au plus ancien, hors `today`.
 * Un jour à plusieurs Z (réouverture) est agrégé : dernier n° de Z, totaux cumulés.
 */
export function closedDays(rows: readonly DailyClosingRow[], today: string): ClosedDay[] {
  const byDate = new Map<string, ClosedDay>();
  for (const r of rows) {
    const date = businessDate(r.period_start);
    if (!date || date === today) continue;
    const prev = byDate.get(date);
    byDate.set(date, {
      date,
      closing_number: Math.max(prev?.closing_number ?? 0, Number(r.closing_number)),
      total_ttc_cents: (prev?.total_ttc_cents ?? 0) + Number(r.total_ttc_cents),
      txn_count: (prev?.txn_count ?? 0) + Number(r.txn_count),
    });
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** Jours clôturés de la caisse courante (90 derniers Z journaliers). */
export function useClosedDays() {
  const registerId = useSessionStore((s) => s.register?.id ?? null);
  const today = businessDate();
  return useQuery({
    queryKey: ['closings', registerId, 'daily-days', today],
    enabled: !!registerId,
    staleTime: 60_000,
    queryFn: async (): Promise<ClosedDay[]> => {
      const { data, error } = await supabase
        .from('pos_closings')
        .select('closing_number, period_start, total_ttc_cents, txn_count')
        .eq('register_id', registerId ?? '')
        .eq('period_type', 'daily')
        .order('closing_number', { ascending: false })
        .limit(90);
      if (error) throw new Error(error.message);
      return closedDays((data ?? []) as DailyClosingRow[], today);
    },
  });
}

/** Tickets d'une date métier (`YYYY-MM-DD`, Europe/Paris) de la caisse courante. */
export function useDayTickets(date: string) {
  const registerId = useSessionStore((s) => s.register?.id ?? null);
  return useQuery({
    queryKey: [...TODAY_TICKETS_KEY, registerId, date],
    queryFn: async () => {
      const rows = await rpc<PosTransaction[] | null>('pos_today_transactions', {
        p_register_id: registerId,
        p_date: date,
      });
      const tickets = (rows ?? [])
        .slice()
        .sort((a, b) => (b.ticket_number ?? 0) - (a.ticket_number ?? 0));
      // Moyens de règlement (pos_payments, lecture autorisée à la caisse) : une erreur n'empêche
      // pas d'afficher les tickets, la colonne reste vide.
      let byTicket = new Map<string, TicketPayment[]>();
      if (tickets.length > 0) {
        const { data, error } = await supabase
          .from('pos_payments')
          .select('transaction_id, method, amount_cents')
          .in(
            'transaction_id',
            tickets.map((t) => t.id),
          );
        if (!error) byTicket = groupPayments((data ?? []) as TicketPayment[]);
      }
      return tickets.map<TodayTicket>((t) => ({ ...t, payments: byTicket.get(t.id) ?? [] }));
    },
    enabled: !!registerId,
    staleTime: 5_000,
  });
}
