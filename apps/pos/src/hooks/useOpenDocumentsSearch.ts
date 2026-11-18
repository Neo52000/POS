import { useQuery } from '@tanstack/react-query';
import { edge } from '@/lib/edge';
import { useDebouncedValue } from './useDebouncedValue';

/**
 * Clients / personnes de passage ayant des commandes ou BL à encaisser. `q` vide = tous ;
 * un seul caractère n'interroge pas le serveur (2 minimum).
 */
export function useOpenDocumentsSearch(q: string, enabled: boolean) {
  const debounced = useDebouncedValue(q.trim(), 250);
  return useQuery({
    queryKey: ['customers', 'open-documents-search', debounced],
    queryFn: () => edge.openDocumentsSearch(debounced, 20),
    enabled: enabled && (debounced.length === 0 || debounced.length >= 2),
    staleTime: 15_000,
  });
}
