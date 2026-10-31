// =============================================================================
// Résolution de la configuration Fiskaly par caisse — module PUR (aucune API Deno).
// Testé par Vitest (`scripts/fiskaly-config.test.ts`).
//
// Règles NF525 (lot 1, 0.4.0) :
//   - caisse `live` : client réel obligatoire. Jamais de repli silencieux sur le mock :
//     FISKALY_MODE ≠ live, clés absentes, FISKALY_BASE_URL absente ou URL de test
//     → FiskalyNotConfiguredError (FISKALY_NOT_CONFIGURED). Le ticket reste
//     `pending_signature` et sera rejoué par pos-sign-pending.
//   - caisse `test` : mock autorisé (développement) ; en mode live, FISKALY_BASE_URL
//     est obligatoire et une URL LIVE est refusée.
//   - aucune URL par défaut.
// =============================================================================

export type FiskalyEnvName = 'test' | 'live';

export interface FiskalyEnvVars {
  mode?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
  baseUrl?: string | null;
}

export type FiskalyResolvedConfig =
  | { kind: 'mock'; env: FiskalyEnvName }
  | { kind: 'live'; env: FiskalyEnvName; baseUrl: string; apiKey: string; apiSecret: string };

export const FISKALY_NOT_CONFIGURED = 'FISKALY_NOT_CONFIGURED';

export class FiskalyNotConfiguredError extends Error {
  readonly code = FISKALY_NOT_CONFIGURED;
  constructor(readonly reason: string) {
    super(`${FISKALY_NOT_CONFIGURED}: ${reason}`);
    this.name = 'FiskalyNotConfiguredError';
  }
}

export function isFiskalyNotConfigured(e: unknown): e is FiskalyNotConfiguredError {
  return (
    e instanceof FiskalyNotConfiguredError ||
    (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === FISKALY_NOT_CONFIGURED)
  );
}

/**
 * Environnement d'une URL Fiskaly d'après son hôte : `live.api.fiskaly.com` → live,
 * `test.api.fiskaly.com` → test, autre → unknown (refusé pour une caisse live).
 */
export function classifyFiskalyUrl(url: string): FiskalyEnvName | 'unknown' {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
  const labels = host.split('.');
  if (labels.includes('live')) return 'live';
  if (labels.includes('test')) return 'test';
  return 'unknown';
}

function clean(v: string | null | undefined): string {
  return (v ?? '').trim();
}

/** Configuration à utiliser pour une caisse donnée (lève FiskalyNotConfiguredError). */
export function resolveFiskalyConfig(
  vars: FiskalyEnvVars,
  registerEnv: string | null | undefined,
): FiskalyResolvedConfig {
  const env: FiskalyEnvName = registerEnv === 'live' ? 'live' : 'test';
  const mode = clean(vars.mode) || 'mock';
  const apiKey = clean(vars.apiKey);
  const apiSecret = clean(vars.apiSecret);
  const baseUrl = clean(vars.baseUrl).replace(/\/+$/, '');
  const urlEnv = baseUrl ? classifyFiskalyUrl(baseUrl) : null;

  if (env === 'live') {
    if (mode !== 'live') throw new FiskalyNotConfiguredError(`caisse live et FISKALY_MODE=${mode}`);
    if (!apiKey || !apiSecret) {
      throw new FiskalyNotConfiguredError('caisse live sans FISKALY_API_KEY / FISKALY_API_SECRET');
    }
    if (!baseUrl) throw new FiskalyNotConfiguredError('caisse live sans FISKALY_BASE_URL');
    if (urlEnv !== 'live') {
      throw new FiskalyNotConfiguredError(`caisse live et FISKALY_BASE_URL non LIVE (${baseUrl})`);
    }
    return { kind: 'live', env, baseUrl, apiKey, apiSecret };
  }

  // Caisse de test : le mock reste autorisé (développement, recette).
  if (mode !== 'live' || !apiKey || !apiSecret) return { kind: 'mock', env };
  if (!baseUrl) throw new FiskalyNotConfiguredError('FISKALY_MODE=live sans FISKALY_BASE_URL');
  if (urlEnv === 'live') {
    throw new FiskalyNotConfiguredError(`caisse de test et FISKALY_BASE_URL LIVE (${baseUrl})`);
  }
  return { kind: 'live', env, baseUrl, apiKey, apiSecret };
}
