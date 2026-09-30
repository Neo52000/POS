import { useQuery } from '@tanstack/react-query';
import { edge } from '@/lib/edge';

export function useCustomerOrders(accountId: string | null) {
  return useQuery({
    queryKey: ['customers', 'orders', accountId],
    queryFn: () => edge.customerOrders(accountId as string),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}
