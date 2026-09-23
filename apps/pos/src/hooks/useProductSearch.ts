import { useQuery } from '@tanstack/react-query';
import { searchProducts } from '@/lib/catalog';
import { useDebouncedValue } from './useDebouncedValue';

export const PRODUCT_SEARCH_MIN = 2;
export const PRODUCT_SEARCH_LIMIT = 40;

/** Recherche produits (projet catalogue) : debounce 150 ms, ≥ 2 caractères, staleTime 30 s. */
export function useProductSearch(q: string) {
  const debounced = useDebouncedValue(q.trim(), 150);
  const enabled = debounced.length >= PRODUCT_SEARCH_MIN;
  const query = useQuery({
    queryKey: ['products', 'search', debounced],
    queryFn: () => searchProducts(debounced, PRODUCT_SEARCH_LIMIT),
    enabled,
    staleTime: 30_000,
    placeholderData: (prev) => (enabled ? prev : undefined),
  });
  return { ...query, enabled, debouncedQuery: debounced };
}
