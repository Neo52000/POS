import { QueryClient } from '@tanstack/react-query';

/**
 * `networkMode: 'always'` : la caisse gère elle-même le hors ligne (catalogue local, file de
 * ventes). Sans cela, TanStack Query suspendrait requêtes et mutations dès que le navigateur
 * signale `offline`, et les replis locaux ne s'exécuteraient jamais.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
      networkMode: 'always',
    },
    mutations: {
      networkMode: 'always',
    },
  },
});
