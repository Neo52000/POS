import { canonicalIsoDate } from './hashChain.js';
import { sha256HexAsync } from './sha256.js';

/**
 * Hash des clôtures (Z1 / Z2 / Z3), miroir de SQL `pos_closing_canonical` / `pos_closing_hash`.
 *
 * - v1 (jusqu'à 0.3.0) : `v1|closing|numéro|type|début|fin|nb tickets|total TTC|GTP|prev_hash`
 * - v2 (0.4.0)         : `v2|closing|numéro|type|début|fin|nb tickets|total TTC|GTP|tête JET|
 *                         hash dernière archive|prev_hash` (têtes `''` si absentes)
 *
 * Dates en ISO 8601 UTC à la milliseconde (`canonicalIsoDate` ≡ `pos_canonical_ts`). Les deux
 * versions restent vérifiables. Vecteurs : `__fixtures__/closing-vectors.json` (rejoués en SQL par
 * `scripts/sql-tests/pos/18_closings_v2.sql`).
 */
export type ClosingHashVersion = 1 | 2;

export interface ClosingHashInput {
  hash_version?: ClosingHashVersion | number | null;
  closing_number: number;
  period_type: 'daily' | 'monthly' | 'annual' | string;
  period_start: string;
  period_end: string;
  txn_count: number;
  total_ttc_cents: number;
  grand_total_perpetual_cents: number;
  jet_head_hash?: string | null;
  archive_head_hash?: string | null;
  prev_hash?: string | null;
}

export interface ChainedClosing extends ClosingHashInput {
  hash: string;
}

export function closingCanonical(c: ClosingHashInput): string {
  const version = Number(c.hash_version ?? 1);
  const head = [
    `closing`,
    String(c.closing_number),
    c.period_type,
    canonicalIsoDate(c.period_start),
    canonicalIsoDate(c.period_end),
    String(c.txn_count),
    String(c.total_ttc_cents),
    String(c.grand_total_perpetual_cents),
  ].join('|');
  if (version === 1) return `v1|${head}|${c.prev_hash ?? ''}`;
  if (version === 2) {
    return `v2|${head}|${c.jet_head_hash ?? ''}|${c.archive_head_hash ?? ''}|${c.prev_hash ?? ''}`;
  }
  throw new RangeError(`hash_version de clôture inconnue : ${String(c.hash_version)}`);
}

export function closingHash(c: ClosingHashInput): Promise<string> {
  return sha256HexAsync(closingCanonical(c));
}

export type ClosingChainBreakReason =
  | 'CLOSING_GAP'
  | 'PREV_HASH_MISMATCH'
  | 'HASH_MISMATCH'
  | 'UNKNOWN_HASH_VERSION'
  | 'JET_HEAD_MISMATCH'
  | 'ARCHIVE_HEAD_MISMATCH';

export type ClosingChainVerification =
  | { ok: true; checked: number }
  | { ok: false; checked: number; closing_number: number; reason: ClosingChainBreakReason };

export interface ClosingHeadsLookup {
  /** Hash actuel de l'événement JET `id` (undefined si introuvable). */
  eventHash?: (id: number) => string | undefined;
  /** Hash actuel de l'archive `id` (undefined si introuvable). */
  archiveHash?: (id: string) => string | undefined;
}

/**
 * Vérification indépendante de la chaîne des clôtures d'une caisse (numérotation continue,
 * `prev_hash`, hash v1/v2 recalculé ; v2 : têtes encore égales au hash de l'élément référencé,
 * si les fonctions de lecture sont fournies).
 */
export async function verifyClosingsChain(
  closings: readonly (ChainedClosing & {
    jet_head_event_id?: number | string | null;
    archive_head_id?: string | null;
  })[],
  heads: ClosingHeadsLookup = {},
): Promise<ClosingChainVerification> {
  const sorted = [...closings].sort((a, b) => Number(a.closing_number) - Number(b.closing_number));
  let prev = '';
  let checked = 0;
  for (const c of sorted) {
    const fail = (reason: ClosingChainBreakReason): ClosingChainVerification => ({
      ok: false,
      checked,
      closing_number: Number(c.closing_number),
      reason,
    });
    if (Number(c.closing_number) !== checked + 1) return fail('CLOSING_GAP');
    if ((c.prev_hash ?? '') !== prev) return fail('PREV_HASH_MISMATCH');
    const version = Number(c.hash_version ?? 1);
    if (version !== 1 && version !== 2) return fail('UNKNOWN_HASH_VERSION');
    if ((await closingHash(c)) !== c.hash) return fail('HASH_MISMATCH');
    if (version === 2) {
      if (heads.eventHash && (c.jet_head_event_id != null || c.jet_head_hash != null)) {
        const h =
          c.jet_head_event_id == null ? undefined : heads.eventHash(Number(c.jet_head_event_id));
        if (h !== (c.jet_head_hash ?? undefined)) return fail('JET_HEAD_MISMATCH');
      }
      if (heads.archiveHash && (c.archive_head_id != null || c.archive_head_hash != null)) {
        const h = c.archive_head_id == null ? undefined : heads.archiveHash(c.archive_head_id);
        if (h !== (c.archive_head_hash ?? undefined)) return fail('ARCHIVE_HEAD_MISMATCH');
      }
    }
    prev = c.hash;
    checked += 1;
  }
  return { ok: true, checked };
}
