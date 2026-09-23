import { describe, expect, it } from 'vitest';

import { isSha256SyncAvailable, sha256Hex, sha256HexAsync } from './sha256.js';

describe('sha256', () => {
  it('is available synchronously under Node', () => {
    expect(isSha256SyncAvailable()).toBe(true);
  });

  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('async (WebCrypto) equals sync (node:crypto), including UTF-8', async () => {
    for (const s of ['', 'abc', 'Crème brûlée €', 'a|b\nc']) {
      expect(await sha256HexAsync(s)).toBe(sha256Hex(s));
    }
  });
});
