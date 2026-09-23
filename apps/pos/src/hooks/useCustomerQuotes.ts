import { useQuery } from '@tanstack/react-query';
import { edge } from '@/lib/edge';

export function useCustomerQuotes(accountId: string | null) {
  return useQuery({
    queryKey: ['customers', 'quotes', accountId],
    queryFn: () => edge.customerQuotes(accountId as string),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}
