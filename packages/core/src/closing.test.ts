import { describe, expect, it } from 'vitest';

import vectors from './__fixtures__/closing-vectors.json';
import { closingCanonical, closingHash, verifyClosingsChain } from './closing.js';
import type { ChainedClosing } from './closing.js';

const chain = vectors as unknown as (ChainedClosing & { name: string; canonical: string })[];

describe('hash de clôture v1 / v2 (vecteurs figés closing-vectors.json)', () => {
  it.each(chain.map((v) => [v.name, v] as const))('%s', async (_name, v) => {
    expect(closingCanonical(v)).toBe(v.canonical);
    expect(await closingHash(v)).toBe(v.hash);
  });

  it('chaîne v1 → v2 → v2 vérifiée', async () => {
    expect(await verifyClosingsChain(chain)).toEqual({ ok: true, checked: 3 });
  });

  it('v1 conservé : une clôture v1 ne se vérifie pas avec la formule v2', async () => {
    const v1 = chain[0]!;
    expect(await closingHash({ ...v1, hash_version: 2 })).not.toBe(v1.hash);
  });

  it('falsification : total modifié → HASH_MISMATCH', async () => {
    const tampered = chain.map((c, i) => (i === 1 ? { ...c, total_ttc_cents: 1 } : c));
    expect(await verifyClosingsChain(tampered)).toMatchObject({
      ok: false,
      closing_number: 2,
      reason: 'HASH_MISMATCH',
    });
  });

  it('JET falsifié (événement réécrit, chaîne recalculée) → JET_HEAD_MISMATCH', async () => {
    const withHeads = chain.map((c) => ({
      ...c,
      jet_head_event_id: c.hash_version === 2 ? 42 : null,
    }));
    const intact = (id: number) => (id === 42 ? (chain[1]!.jet_head_hash ?? undefined) : undefined);
    expect(await verifyClosingsChain(withHeads, { eventHash: intact })).toEqual({
      ok: true,
      checked: 3,
    });
    const forged = () => 'f'.repeat(64);
    expect(await verifyClosingsChain(withHeads, { eventHash: forged })).toMatchObject({
      ok: false,
      closing_number: 2,
      reason: 'JET_HEAD_MISMATCH',
    });
  });

  it('version inconnue refusée', async () => {
    expect(() => closingCanonical({ ...chain[0]!, hash_version: 3 })).toThrow(RangeError);
  });
});
