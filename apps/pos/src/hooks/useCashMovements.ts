import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import type { PosCashMovement } from '@/types/pos';

export const CASH_MOVEMENTS_KEY = 'cash-movements';

/** Mouvements d'espèces d'une session (`pos_cash_movements`, lecture RLS), du plus ancien au plus récent. */
export function useSessionCashMovements(sessionId: string | null | undefined) {
  return useQuery({
    queryKey: [CASH_MOVEMENTS_KEY, sessionId],
    enabled: !!sessionId,
    queryFn: async (): Promise<PosCashMovement[]> => {
      const { data, error } = await supabase
        .from('pos_cash_movements')
        .select('*')
        .eq('session_id', sessionId ?? '')
        .order('created_at', { ascending: true });
      if (error) throw new Error(error.message);
      return ((data ?? []) as PosCashMovement[]).map((m) => ({
        ...m,
        amount_cents: Number(m.amount_cents),
      }));
    },
  });
}
