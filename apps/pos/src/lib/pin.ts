/**
 * PIN local de reverrouillage (plan A13) : PBKDF2-SHA256 (WebCrypto), sel aléatoire,
 * stocké dans `localStorage`. Le PIN ne protège que l'UI (l'auth reste Supabase).
 */
const STORAGE_KEY = 'pos.pin.v1';
const ITERATIONS = 120_000;
const KEY_BYTES = 32;

interface StoredPin {
  v: 1;
  salt: string;
  hash: string;
  iterations: number;
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto indisponible (contexte non sécurisé ?)');
  return s;
}

async function derive(pin: string, salt: Uint8Array, iterations: number): Promise<string> {
  const material = await subtle().importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    KEY_BYTES * 8,
  );
  return toHex(bits);
}

function read(): StoredPin | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPin>;
    if (parsed.v !== 1 || typeof parsed.salt !== 'string' || typeof parsed.hash !== 'string')
      return null;
    return {
      v: 1,
      salt: parsed.salt,
      hash: parsed.hash,
      iterations: typeof parsed.iterations === 'number' ? parsed.iterations : ITERATIONS,
    };
  } catch {
    return null;
  }
}

export function isValidPinFormat(pin: string): boolean {
  return /^\d{4,8}$/.test(pin);
}

export function hasPin(): boolean {
  return read() !== null;
}

export function clearPin(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // stockage indisponible : rien à effacer
  }
}

export async function setPin(pin: string): Promise<void> {
  if (!isValidPinFormat(pin)) throw new Error('Le PIN doit comporter 4 à 8 chiffres');
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const hash = await derive(pin, salt, ITERATIONS);
  const stored: StoredPin = { v: 1, salt: toHex(salt), hash, iterations: ITERATIONS };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPin(pin: string): Promise<boolean> {
  const stored = read();
  if (!stored) return false;
  if (typeof pin !== 'string' || pin.length === 0) return false;
  const hash = await derive(pin, fromHex(stored.salt), stored.iterations);
  return constantTimeEqual(hash, stored.hash);
}
