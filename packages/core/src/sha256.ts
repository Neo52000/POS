/**
 * Accès isolé à SHA-256.
 *
 * - `sha256Hex` (sync) s'appuie sur `node:crypto` (`createHash`). Le module est chargé via
 *   `process.getBuiltinModule` (Node ≥ 20.16 / 22.3) afin qu'aucun bundler navigateur (Vite)
 *   ne voie d'import statique de `node:crypto`.
 * - `sha256HexAsync` s'appuie sur WebCrypto (`crypto.subtle`, navigateur et Node) et retombe
 *   sur la version sync si WebCrypto est indisponible.
 */

interface NodeHashLike {
  update(data: string, encoding: 'utf8'): NodeHashLike;
  digest(encoding: 'hex'): string;
}

interface NodeCryptoLike {
  createHash(algorithm: string): NodeHashLike;
}

interface SubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

interface ProcessLike {
  getBuiltinModule?: (id: string) => unknown;
}

let nodeCryptoCache: NodeCryptoLike | null | undefined;

function loadNodeCrypto(): NodeCryptoLike | null {
  if (nodeCryptoCache !== undefined) return nodeCryptoCache;
  nodeCryptoCache = null;
  const proc = (globalThis as { process?: ProcessLike }).process;
  const getBuiltinModule = proc?.getBuiltinModule;
  if (typeof getBuiltinModule === 'function') {
    try {
      const mod = getBuiltinModule.call(proc, 'node:crypto') as Partial<NodeCryptoLike> | undefined;
      if (mod && typeof mod.createHash === 'function') {
        nodeCryptoCache = mod as NodeCryptoLike;
      }
    } catch {
      nodeCryptoCache = null;
    }
  }
  return nodeCryptoCache;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return out;
}

/** `true` si le SHA-256 synchrone (`node:crypto`) est disponible dans ce runtime. */
export function isSha256SyncAvailable(): boolean {
  return loadNodeCrypto() !== null;
}

/**
 * SHA-256 hexadécimal (minuscules) d'une chaîne UTF-8 — version synchrone (Node uniquement).
 * @throws Error `SHA256_SYNC_UNAVAILABLE` hors Node (utiliser `sha256HexAsync`).
 */
export function sha256Hex(input: string): string {
  const nodeCrypto = loadNodeCrypto();
  if (!nodeCrypto) {
    throw new Error(
      'SHA256_SYNC_UNAVAILABLE: node:crypto is not available in this runtime, use sha256HexAsync()',
    );
  }
  return nodeCrypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** SHA-256 hexadécimal (minuscules) d'une chaîne UTF-8 — version asynchrone (WebCrypto). */
export async function sha256HexAsync(input: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    const bytes = new TextEncoder().encode(input);
    const digest = await subtle.digest('SHA-256', bytes);
    return bytesToHex(new Uint8Array(digest));
  }
  return sha256Hex(input);
}
