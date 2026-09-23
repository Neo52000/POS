/**
 * Tags du protocole Caisse-AP (Concert V3 over IP) tels qu'utilisés par le pont.
 *
 * Les libellés marqués « à confirmer » proviennent de la documentation publique partielle du
 * protocole et n'ont pas été vérifiés sur un TPE réel (voir docs/TPE-CAISSE-AP.md).
 */
import { CAISSE_AP_AF_CODES } from '@pos/core';

export {
  CAISSE_AP_ACTIONS,
  CAISSE_AP_AE_CODES,
  CAISSE_AP_AF_CODES,
  buildPaymentRequest,
  buildPaymentRequestFields,
  decodeFields,
  encodeFields,
  parsePaymentResponse,
} from '@pos/core';
export type {
  CaisseApAction,
  CaisseApFields,
  CaisseApPaymentResponse,
  CaisseApStatus,
} from '@pos/core';

/** Tags émis par la caisse (demande). */
export const TAG = {
  /** Version du protocole (`0300`). */
  CZ: 'CZ',
  /** Identifiant du protocole (`012` = Caisse-AP). */
  CJ: 'CJ',
  /** Numéro de caisse (2 chiffres). */
  CA: 'CA',
  /** Montant en centimes, sans padding (le préfixe de longueur suffit). */
  CB: 'CB',
  /** Type d'action : `0` débit, `1` crédit, `2` annulation. */
  CD: 'CD',
  /** Devise ISO 4217 numérique (`978` = EUR). */
  CE: 'CE',
  /** Statut de la réponse : `10` accepté, `01` refusé, `11` pris en compte. */
  AE: 'AE',
  /** Motif d'erreur (si `AE=01`). */
  AF: 'AF',
} as const;

export type KnownTag = (typeof TAG)[keyof typeof TAG];

/** Libellés FR des tags (les plus courants). */
export const TAG_LABELS: Readonly<Record<string, string>> = {
  CZ: 'Version du protocole',
  CJ: 'Identifiant du protocole',
  CA: 'Numéro de caisse',
  CB: 'Montant (centimes)',
  CD: "Type d'action",
  CE: 'Devise (ISO 4217)',
  AE: 'Statut de la transaction',
  AF: "Motif d'erreur",
  // Tags optionnels rencontrés selon les versions AP — à confirmer sur le TPE cible.
  CC: 'Indicateur de lecture / mode de saisie (à confirmer)',
  BF: 'Mode de règlement (à confirmer)',
  AA: 'Réservé (à confirmer)',
  AB: 'Numéro de TPE (à confirmer)',
  AC: 'Type de carte (à confirmer)',
  AI: "Numéro d'autorisation (à confirmer)",
  CG: 'Complément de transaction (à confirmer)',
};

/** Libellés FR des codes `AE`. */
export const AE_LABELS: Readonly<Record<string, string>> = {
  '10': 'Transaction acceptée',
  '01': 'Transaction refusée',
  '11': 'Demande prise en compte (attente de la réponse finale)',
};

/** Libellés FR des actions (`CD`). */
export const ACTION_LABELS: Readonly<Record<string, string>> = {
  '0': 'Débit',
  '1': 'Crédit (remboursement)',
  '2': 'Annulation',
};

/** Libellé lisible d'un tag (fallback : le tag lui-même). */
export function tagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? tag;
}

/** Libellé lisible d'un code `AE`/`AF` (fallback : code brut). */
export function describeResponse(ae: string | null, af: string | null): string {
  const parts: string[] = [];
  if (ae !== null) parts.push(`AE=${ae} (${AE_LABELS[ae] ?? 'inconnu'})`);
  if (af !== null) parts.push(`AF=${af} (${CAISSE_AP_AF_CODES[af] ?? 'inconnu'})`);
  return parts.length > 0 ? parts.join(', ') : 'aucun statut';
}
