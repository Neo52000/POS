import { describe, expect, it } from 'vitest';
import type { FiskalyNotConfiguredError } from '../../supabase/functions/_shared/fiskaly/config.ts';
import {
  FISKALY_NOT_CONFIGURED,
  classifyFiskalyUrl,
  isFiskalyNotConfigured,
  resolveFiskalyConfig,
} from '../../supabase/functions/_shared/fiskaly/config.ts';

const LIVE_URL = 'https://live.api.fiskaly.com';
const TEST_URL = 'https://test.api.fiskaly.com';
const KEYS = { apiKey: 'k', apiSecret: 's' };

function notConfigured(fn: () => unknown): FiskalyNotConfiguredError {
  try {
    fn();
  } catch (e) {
    expect(isFiskalyNotConfigured(e)).toBe(true);
    return e as FiskalyNotConfiguredError;
  }
  throw new Error('FISKALY_NOT_CONFIGURED attendu');
}

describe('classifyFiskalyUrl', () => {
  it('reconnaît LIVE, TEST et refuse le reste', () => {
    expect(classifyFiskalyUrl(LIVE_URL)).toBe('live');
    expect(classifyFiskalyUrl(`${TEST_URL}/`)).toBe('test');
    expect(classifyFiskalyUrl('https://api.example.com')).toBe('unknown');
    expect(classifyFiskalyUrl('pas une url')).toBe('unknown');
  });
});

describe('resolveFiskalyConfig — caisse live (jamais de mock)', () => {
  it('clés absentes : FISKALY_NOT_CONFIGURED, pas de repli mock', () => {
    const e = notConfigured(() =>
      resolveFiskalyConfig({ mode: 'live', baseUrl: LIVE_URL }, 'live'),
    );
    expect(e.code).toBe(FISKALY_NOT_CONFIGURED);
  });

  it('FISKALY_MODE absent ou mock : FISKALY_NOT_CONFIGURED', () => {
    notConfigured(() => resolveFiskalyConfig({}, 'live'));
    notConfigured(() => resolveFiskalyConfig({ mode: 'mock', ...KEYS, baseUrl: LIVE_URL }, 'live'));
  });

  it('FISKALY_BASE_URL obligatoire (aucune URL par défaut)', () => {
    notConfigured(() => resolveFiskalyConfig({ mode: 'live', ...KEYS }, 'live'));
  });

  it('URL de test ou inconnue refusée pour une caisse live', () => {
    notConfigured(() => resolveFiskalyConfig({ mode: 'live', ...KEYS, baseUrl: TEST_URL }, 'live'));
    notConfigured(() =>
      resolveFiskalyConfig({ mode: 'live', ...KEYS, baseUrl: 'https://fiskaly.example' }, 'live'),
    );
  });

  it('configuration complète : client réel', () => {
    expect(
      resolveFiskalyConfig({ mode: 'live', ...KEYS, baseUrl: `${LIVE_URL}/` }, 'live'),
    ).toEqual({ kind: 'live', env: 'live', baseUrl: LIVE_URL, apiKey: 'k', apiSecret: 's' });
  });
});

describe('resolveFiskalyConfig — caisse de test', () => {
  it('mock autorisé sans configuration (développement)', () => {
    expect(resolveFiskalyConfig({}, 'test')).toEqual({ kind: 'mock', env: 'test' });
    expect(resolveFiskalyConfig({ mode: 'live' }, null)).toEqual({ kind: 'mock', env: 'test' });
  });

  it('mode live : URL obligatoire, URL LIVE refusée', () => {
    notConfigured(() => resolveFiskalyConfig({ mode: 'live', ...KEYS }, 'test'));
    notConfigured(() => resolveFiskalyConfig({ mode: 'live', ...KEYS, baseUrl: LIVE_URL }, 'test'));
    expect(
      resolveFiskalyConfig({ mode: 'live', ...KEYS, baseUrl: TEST_URL }, 'test'),
    ).toMatchObject({ kind: 'live', env: 'test', baseUrl: TEST_URL });
  });
});
