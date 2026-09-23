import { useQuery } from '@tanstack/react-query';
import { edge } from '@/lib/edge';
import { useDebouncedValue } from './useDebouncedValue';

export function useCustomerSearch(q: string) {
  const debounced = useDebouncedValue(q.trim(), 200);
  const enabled = debounced.length >= 2;
  return useQuery({
    queryKey: ['customers', 'search', debounced],
    queryFn: () => edge.customerSearch(debounced, 15),
    enabled,
    staleTime: 30_000,
  });
}
