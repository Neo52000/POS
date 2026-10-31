import { useQuery } from '@tanstack/react-query';
import { edge } from '@/lib/edge';

/** Commandes à encaisser du client pro, ou de la personne de passage si `passageContactId`. */
export function useCustomerOrders(accountId: string | null, passageContactId?: string | null) {
  return useQuery({
    queryKey: ['customers', 'orders', accountId, passageContactId ?? null],
    queryFn: () => edge.customerOrders(accountId as string, passageContactId ?? null),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}
