import { useQuery } from '@tanstack/react-query';
import { businessDate } from '@/lib/format';
import { rpc } from '@/lib/supabase';
import { useSessionStore } from '@/stores/sessionStore';
import type { PosTransaction } from '@/types/pos';

export const TODAY_TICKETS_KEY = ['transactions', 'today'] as const;

/** Tickets du jour (fuseau Europe/Paris) de la caisse courante. */
export function useTodayTickets() {
  const registerId = useSessionStore((s) => s.register?.id ?? null);
  const date = businessDate();
  return useQuery({
    queryKey: [...TODAY_TICKETS_KEY, registerId, date],
    queryFn: async () => {
      const rows = await rpc<PosTransaction[] | null>('pos_today_transactions', {
        p_register_id: registerId,
        p_date: date,
      });
      return (rows ?? []).slice().sort((a, b) => (b.ticket_number ?? 0) - (a.ticket_number ?? 0));
    },
    enabled: !!registerId,
    staleTime: 5_000,
  });
}
