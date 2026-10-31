import { useQuery } from '@tanstack/react-query';
import { edge } from '@/lib/edge';

/**
 * Commandes et BL à encaisser du client pro, ou de la personne de passage si `passageContactId`.
 */
export function useCustomerDocuments(accountId: string | null, passageContactId?: string | null) {
  return useQuery({
    queryKey: ['customers', 'documents', accountId, passageContactId ?? null],
    queryFn: () => edge.customerDocuments(accountId as string, passageContactId ?? null),
    enabled: !!accountId,
    staleTime: 30_000,
  });
}
