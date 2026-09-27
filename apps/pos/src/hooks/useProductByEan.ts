import { useQuery } from '@tanstack/react-query';
import { productByEan } from '@/lib/catalog';
import { queryClient } from '@/lib/queryClient';
import type { PosProduct } from '@/types/pos';

/** Un EAN inconnu n'est pas mis en cache : le produit peut être créé au catalogue entre-temps. */
const eanStaleTime = (q: { state: { data: PosProduct | null | undefined } }): number =>
  q.state.data ? 60_000 : 0;

/** Version impérative (scan) : passe par le cache TanStack. */
export function lookupProductByEan(ean: string): Promise<PosProduct | null> {
  return queryClient.fetchQuery({
    queryKey: ['products', 'ean', ean],
    queryFn: () => productByEan(ean),
    staleTime: eanStaleTime,
  });
}

export function useProductByEan(ean: string | null) {
  return useQuery({
    queryKey: ['products', 'ean', ean],
    queryFn: () => productByEan(ean as string),
    enabled: !!ean,
    staleTime: eanStaleTime,
  });
}
