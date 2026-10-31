import { LiveFiskalyClient } from './client.ts';
import { resolveFiskalyConfig } from './config.ts';
import { MockFiskalyClient } from './mock.ts';
import type { FiskalyClient } from './types.ts';

export * from './types.ts';
export * from './config.ts';
export { LiveFiskalyClient, MockFiskalyClient };

/** Caisse vue par la fabrique (seul `fiskaly_env` compte). */
export interface FiskalyRegisterEnv {
  fiskaly_env?: string | null;
}

const cache = new Map<string, FiskalyClient>();

/**
 * Client Fiskaly pour une caisse (lot 1, 0.4.0) :
 *  - caisse `live` → client réel obligatoire ; sinon `FiskalyNotConfiguredError`
 *    (FISKALY_NOT_CONFIGURED), jamais de repli silencieux sur le mock ;
 *  - caisse `test` → mock sauf FISKALY_MODE=live avec clés et FISKALY_BASE_URL non LIVE.
 * Aucune URL par défaut : FISKALY_BASE_URL est obligatoire en mode live.
 */
export function getFiskalyClient(register: FiskalyRegisterEnv | null | undefined): FiskalyClient {
  const cfg = resolveFiskalyConfig(
    {
      mode: Deno.env.get('FISKALY_MODE'),
      apiKey: Deno.env.get('FISKALY_API_KEY'),
      apiSecret: Deno.env.get('FISKALY_API_SECRET'),
      baseUrl: Deno.env.get('FISKALY_BASE_URL'),
    },
    register?.fiskaly_env,
  );
  const key = cfg.kind === 'live' ? `live|${cfg.baseUrl}` : 'mock';
  const hit = cache.get(key);
  if (hit) return hit;
  const client: FiskalyClient =
    cfg.kind === 'live'
      ? new LiveFiskalyClient(cfg.baseUrl, cfg.apiKey, cfg.apiSecret)
      : new MockFiskalyClient();
  cache.set(key, client);
  return client;
}
