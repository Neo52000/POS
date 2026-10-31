import { describe, expect, it } from 'vitest';
import { isSessionStale } from './sessionStale';

describe('isSessionStale (date métier Europe/Paris)', () => {
  it('session ouverte le jour même : non périmée', () => {
    expect(isSessionStale('2026-10-31T06:00:00.000Z', new Date('2026-10-31T21:00:00.000Z'))).toBe(
      false,
    );
  });

  it('session de la veille : périmée', () => {
    expect(isSessionStale('2026-10-30T15:00:00.000Z', new Date('2026-10-31T07:00:00.000Z'))).toBe(
      true,
    );
  });

  it('minuit à Paris (et non en UTC) fait foi', () => {
    // 23:30 UTC le 31/10 = 00:30 à Paris le 01/11 (heure d'hiver) : nouveau jour métier.
    expect(isSessionStale('2026-10-31T08:00:00.000Z', new Date('2026-10-31T23:30:00.000Z'))).toBe(
      true,
    );
    // 22:30 UTC le 31/10 = 23:30 à Paris : même jour.
    expect(isSessionStale('2026-10-31T08:00:00.000Z', new Date('2026-10-31T22:30:00.000Z'))).toBe(
      false,
    );
  });

  it('sans date d’ouverture : non périmée', () => {
    expect(isSessionStale(null)).toBe(false);
  });
});
