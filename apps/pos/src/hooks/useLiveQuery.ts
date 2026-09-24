import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';

/**
 * Abonnement à une requête Dexie réactive (`liveQuery`) : la valeur est recalculée à chaque
 * écriture concernée, y compris depuis un autre onglet.
 */
export function useLiveQuery<T>(
  querier: () => Promise<T>,
  deps: readonly unknown[],
  initial: T,
): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    const sub = liveQuery(querier).subscribe({
      next: (v) => setValue(v),
      error: (e: unknown) => console.warn('[liveQuery]', e),
    });
    return () => sub.unsubscribe();
  }, deps);
  return value;
}
