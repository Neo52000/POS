import { useQuery } from '@tanstack/react-query';
import { edge } from '@/lib/edge';
import { useDebouncedValue } from './useDebouncedValue';

/** Personnes de passage par nom ou téléphone (2 caractères minimum). */
export function usePassageSearch(q: string) {
  const debounced = useDebouncedValue(q.trim(), 200);
  const enabled = debounced.length >= 2;
  return useQuery({
    queryKey: ['passage', 'search', debounced],
    queryFn: () => edge.passageSearch(debounced, 15),
    enabled,
    staleTime: 10_000,
  });
}
