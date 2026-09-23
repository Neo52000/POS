import { useQuery } from '@tanstack/react-query';
import { productByEan } from '@/lib/catalog';
import { queryClient } from '@/lib/queryClient';
import type { PosProduct } from '@/types/pos';

/** Version impérative (scan) : passe par le cache TanStack. */
export function lookupProductByEan(ean: string): Promise<PosProduct | null> {
  return queryClient.fetchQuery({
    queryKey: ['products', 'ean', ean],
    queryFn: () => productByEan(ean),
    staleTime: 60_000,
  });
}

export function useProductByEan(ean: string | null) {
  return useQuery({
    queryKey: ['products', 'ean', ean],
    queryFn: () => productByEan(ean as string),
    enabled: !!ean,
    staleTime: 60_000,
  });
}
