import { ApiError } from '@/lib/apiError';

/**
 * Interrupteur « réseau coupé » des mocks e2e : `window.__posMockOffline = true` (prioritaire)
 * ou `localStorage['pos.mock.offline'] = '1'` (pratique depuis Playwright). Quand il est actif,
 * mockEdge, mockSupabase (rpc, from), mockCatalog et la sonde de connectivité échouent en NETWORK.
 */
export const MOCK_OFFLINE_KEY = 'pos.mock.offline';

interface MockNetworkGlobal {
  __posMockOffline?: boolean;
}

export function isMockOffline(): boolean {
  const g = globalThis as MockNetworkGlobal;
  if (typeof g.__posMockOffline === 'boolean') return g.__posMockOffline;
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MOCK_OFFLINE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMockOffline(offline: boolean): void {
  (globalThis as MockNetworkGlobal).__posMockOffline = offline;
  try {
    if (offline) localStorage.setItem(MOCK_OFFLINE_KEY, '1');
    else localStorage.removeItem(MOCK_OFFLINE_KEY);
  } catch {
    // stockage indisponible
  }
}

/** Lève `ApiError('NETWORK')` si le réseau simulé est coupé. */
export function assertMockOnline(): void {
  if (isMockOffline())
    throw new ApiError('NETWORK', 'TypeError: Failed to fetch (mock hors ligne)');
}
