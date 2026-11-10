import { useQuery } from '@tanstack/react-query';
import { serviceProducts } from '@/lib/catalog';

/** Prestations de service (accès direct) : rafraîchies toutes les 5 min, secours hors ligne. */
export function useServiceProducts() {
  return useQuery({
    queryKey: ['products', 'services'],
    queryFn: serviceProducts,
    staleTime: 5 * 60_000,
  });
}
