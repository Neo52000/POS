import { useQuery } from '@tanstack/react-query';
import { rpc } from '@/lib/supabase';
import type { TransactionFull } from '@/types/pos';

export async function fetchTransactionFull(id: string): Promise<TransactionFull> {
  const data = await rpc<TransactionFull | null>('pos_transaction_full', { p_transaction_id: id });
  if (!data) throw new Error('NOT_FOUND');
  return data;
}

export function useTransactionFull(id: string | null) {
  return useQuery({
    queryKey: ['transactions', 'full', id],
    queryFn: () => fetchTransactionFull(id as string),
    enabled: !!id,
    staleTime: 60_000,
  });
}
