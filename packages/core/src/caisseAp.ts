/**
 * Codec Caisse-AP (SPEC §7) : trames `tag(2) + len(3, zéro-paddée) + value`.
 */

export type CaisseApAction = 'debit' | 'credit' | 'cancel';
export type CaisseApStatus = 'approved' | 'declined' | 'pending' | 'unknown';

/** Valeur du champ `CD` par action (à ajuster depuis la spec AP sans toucher au reste). */
export const CAISSE_AP_ACTIONS: Readonly<Record<CaisseApAction, string>> = {
  debit: '0',
  credit: '1',
  cancel: '2',
};

/** Codes `AE` (statut de la réponse) connus. */
export const CAISSE_AP_AE_CODES: Readonly<Record<string, Exclude<CaisseApStatus, 'unknown'>>> = {
  '10': 'approved',
  '01': 'declined',
  '11': 'pending',
};

/** Codes `AF` (motif d'erreur) connus. */
export const CAISSE_AP_AF_CODES: Readonly<Record<string, string>> = {
  '09': 'Erreur de format',
  '10': 'Erreur de sélection',
  '11': 'Abandon',
  '12': 'Action inconnue',
  '13': 'Devise non supportée',
};

export interface CaisseApFields {
  fields: Map<string, string>;
  /** Tags dans l'ordre d'apparition (doublons inclus). */
  order: string[];
  /** `true` si la trame s'est arrêtée au milieu d'un champ (le champ partiel est ignoré). */
  truncated: boolean;
}

export interface CaisseApPaymentRequest {
  posNumber?: string;
  amountCents: number;
  action: CaisseApAction;
  currency?: string;
  protocolVersion?: string;
  protocolId?: string;
}

export interface CaisseApPaymentResponse {
  status: CaisseApStatus;
  ae: string | null;
  af: string | null;
  raw: Record<string, string>;
}

export class CaisseApEncodeError extends Error {
  override readonly name = 'CaisseApEncodeError';
  constructor(
    message: string,
    readonly tag: string,
  ) {
    super(message);
  }
}

const ASCII_PRINTABLE_RE = /^[\x20-\x7e]*$/;

/** Encode une liste de champs `[tag, value]` en trame. */
export function encodeFields(fields: ReadonlyArray<readonly [tag: string, value: string]>): string {
  let frame = '';
  for (const [tag, value] of fields) {
    if (typeof tag !== 'string' || tag.length !== 2) {
      throw new CaisseApEncodeError(`Tag must be exactly 2 characters, got "${String(tag)}"`, tag);
    }
    if (!ASCII_PRINTABLE_RE.test(tag)) {
      throw new CaisseApEncodeError(`Tag must be ASCII, got "${tag}"`, tag);
    }
    if (typeof value !== 'string') {
      throw new CaisseApEncodeError(`Value of ${tag} must be a string`, tag);
    }
    if (value.length > 999) {
      throw new CaisseApEncodeError(
        `Value of ${tag} exceeds 999 characters (${value.length})`,
        tag,
      );
    }
    if (!ASCII_PRINTABLE_RE.test(value)) {
      throw new CaisseApEncodeError(`Value of ${tag} must be printable ASCII`, tag);
    }
    frame += tag + String(value.length).padStart(3, '0') + value;
  }
  return frame;
}

const LENGTH_RE = /^\d{3}$/;

/** Décode une trame ; tolérant : s'arrête proprement (`truncated: true`) si la trame est incomplète. */
export function decodeFields(frame: string): CaisseApFields {
  const fields = new Map<string, string>();
  const order: string[] = [];
  let truncated = false;
  let cursor = 0;
  while (cursor < frame.length) {
    if (frame.length - cursor < 5) {
      truncated = true;
      break;
    }
    const tag = frame.slice(cursor, cursor + 2);
    const lengthText = frame.slice(cursor + 2, cursor + 5);
    if (!LENGTH_RE.test(lengthText)) {
      truncated = true;
      break;
    }
    const length = Number(lengthText);
    const value = frame.slice(cursor + 5, cursor + 5 + length);
    if (value.length < length) {
      truncated = true;
      break;
    }
    fields.set(tag, value);
    order.push(tag);
    cursor += 5 + length;
  }
  return { fields, order, truncated };
}

/** Champs `CZ, CJ, CA, CB, CD, CE` d'une demande de paiement, dans l'ordre. */
export function buildPaymentRequestFields(
  request: CaisseApPaymentRequest,
): Array<[tag: string, value: string]> {
  const {
    posNumber = '01',
    amountCents,
    action,
    currency = '978',
    protocolVersion = '0300',
    protocolId = '012',
  } = request;
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new RangeError(`amountCents must be a non-negative integer, got ${String(amountCents)}`);
  }
  const actionCode = CAISSE_AP_ACTIONS[action];
  if (actionCode === undefined) {
    throw new RangeError(`Unknown Caisse-AP action: ${String(action)}`);
  }
  return [
    ['CZ', protocolVersion],
    ['CJ', protocolId],
    ['CA', posNumber],
    ['CB', String(amountCents)],
    ['CD', actionCode],
    ['CE', currency],
  ];
}

/** Trame de demande de paiement (SPEC §7). */
export function buildPaymentRequest(request: CaisseApPaymentRequest): string {
  return encodeFields(buildPaymentRequestFields(request));
}

/** Interprète une réponse TPE (trame brute ou champs décodés). */
export function parsePaymentResponse(input: CaisseApFields | string): CaisseApPaymentResponse {
  const decoded = typeof input === 'string' ? decodeFields(input) : input;
  const ae = decoded.fields.get('AE') ?? null;
  const af = decoded.fields.get('AF') ?? null;
  const status: CaisseApStatus = (ae !== null && CAISSE_AP_AE_CODES[ae]) || 'unknown';
  return { status, ae, af, raw: Object.fromEntries(decoded.fields) };
}
