import { canonicalJson } from './archive.js';
import { sha256HexAsync } from './sha256.js';
import type { CheckoutPayload } from './types.js';

/**
 * Chaînage local de la file hors ligne (0.4.0, lot 5). Chaque élément mis en file porte le SHA-256
 * de l'élément précédent (`offline_chain_prev`, `''` pour le premier) et le sien
 * (`offline_chain_hash`) :
 *
 *   offline_chain_hash = SHA-256("offline-chain/v1|" + prev + "|" + canonicalJson(payload sans les
 *                        deux champs de chaînage))
 *
 * Les deux valeurs partent dans le payload de l'événement JET de la vente (serveur), jamais dans
 * le hash ticket v1. Une suppression au milieu de la file laisse un `offline_chain_prev` sans
 * élément correspondant (`pos_offline_chain_breaks`) ; une suppression en fin de file est
 * détectée par la numérotation `OFF-…` déclarée à `offline_exit`.
 */
export const OFFLINE_CHAIN_FORMAT = 'offline-chain/v1';

type Chained = Pick<CheckoutPayload, 'offline_chain_prev' | 'offline_chain_hash'>;

/** Chaîne hachée d'un élément (sans ses propres champs de chaînage). */
export function offlineChainCanonical(prev: string, payload: CheckoutPayload): string {
  const {
    offline_chain_prev: _prev,
    offline_chain_hash: _hash,
    ...rest
  } = payload as CheckoutPayload & Chained;
  return `${OFFLINE_CHAIN_FORMAT}|${prev}|${canonicalJson(rest)}`;
}

export async function offlineChainHash(prev: string, payload: CheckoutPayload): Promise<string> {
  return sha256HexAsync(offlineChainCanonical(prev, payload));
}

/** Rattache un élément à la tête de chaîne `prev` (renvoie une copie). */
export async function chainOfflinePayload(
  prev: string,
  payload: CheckoutPayload,
): Promise<CheckoutPayload> {
  const hash = await offlineChainHash(prev, payload);
  return { ...payload, offline_chain_prev: prev, offline_chain_hash: hash };
}

export type OfflineChainVerification =
  | { ok: true; checked: number; head: string }
  | { ok: false; index: number; reason: 'PREV_MISMATCH' | 'HASH_MISMATCH' | 'NOT_CHAINED' };

/**
 * Vérifie une file dans son ordre local (`local_seq`) : chaque élément pointe sur le précédent et
 * son empreinte est recalculée. `start` = tête attendue avant le premier élément (`''` par défaut).
 */
export async function verifyOfflineChain(
  payloads: readonly CheckoutPayload[],
  start = '',
): Promise<OfflineChainVerification> {
  let head = start;
  for (let i = 0; i < payloads.length; i += 1) {
    const p = payloads[i] as CheckoutPayload & Chained;
    if (p.offline_chain_hash === undefined || p.offline_chain_prev === undefined) {
      return { ok: false, index: i, reason: 'NOT_CHAINED' };
    }
    if (p.offline_chain_prev !== head) return { ok: false, index: i, reason: 'PREV_MISMATCH' };
    if ((await offlineChainHash(head, p)) !== p.offline_chain_hash) {
      return { ok: false, index: i, reason: 'HASH_MISMATCH' };
    }
    head = p.offline_chain_hash;
  }
  return { ok: true, checked: payloads.length, head };
}
