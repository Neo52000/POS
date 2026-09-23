import { LiveFiskalyClient } from './client.ts';
import { MockFiskalyClient } from './mock.ts';
import type { FiskalyClient } from './types.ts';

export * from './types.ts';
export { LiveFiskalyClient, MockFiskalyClient };

let cached: FiskalyClient | null = null;

/**
 * Fabrique le client selon l'environnement :
 * FISKALY_MODE=live + FISKALY_API_KEY/SECRET (+ FISKALY_BASE_URL) → client réel, sinon mock.
 */
export function getFiskalyClient(): FiskalyClient {
  if (cached) return cached;
  const mode = Deno.env.get('FISKALY_MODE') ?? 'mock';
  const key = Deno.env.get('FISKALY_API_KEY');
  const secret = Deno.env.get('FISKALY_API_SECRET');
  if (mode === 'live' && key && secret) {
    const base = Deno.env.get('FISKALY_BASE_URL') ?? 'https://test.api.fiskaly.com';
    cached = new LiveFiskalyClient(base, key, secret);
  } else {
    if (mode === 'live') console.warn('[fiskaly] FISKALY_MODE=live sans clés : bascule en mock');
    cached = new MockFiskalyClient();
  }
  return cached;
}
