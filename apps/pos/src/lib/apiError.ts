import type { CheckoutErrorCode } from '@pos/core';

export type ApiErrorCode =
  | CheckoutErrorCode
  | 'SESSION_ALREADY_OPEN'
  | 'NOT_FOUND'
  | 'INTERNAL'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'QUEUED_AFTER_CB'
  | 'REGISTER_NOT_FOUND'
  | 'BUSINESS_AT_OUT_OF_RANGE'
  | 'CHAIN_INCONSISTENT'
  | 'PRODUCT_NOT_FOUND'
  | 'OFFLINE_LIMIT_REACHED'
  | 'OFFLINE_FORBIDDEN';

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message?: string,
    public readonly details?: unknown,
    public readonly status?: number,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Vrai si l'erreur signifie que la requête n'a probablement pas atteint le serveur (ou pas de réponse). */
export function isNetworkError(e: unknown): boolean {
  return isApiError(e) && (e.code === 'NETWORK' || e.code === 'TIMEOUT');
}

/** Messages d'échec `fetch` (Chrome, Firefox, Safari, Node) remontés tels quels par supabase-js. */
const FETCH_FAILURE_RE =
  /failed to fetch|networkerror|load failed|fetch failed|network request failed/i;

/**
 * Vrai pour toute erreur « réseau » : `ApiError` NETWORK/TIMEOUT (Edge), `TypeError` de `fetch`,
 * ou erreur supabase-js dont le message est celui d'un `fetch` en échec.
 */
export function isNetworkFailure(e: unknown): boolean {
  if (isNetworkError(e)) return true;
  if (e instanceof TypeError) return true;
  const message =
    e instanceof Error
      ? e.message
      : e && typeof e === 'object' && 'message' in e
        ? String((e as { message?: unknown }).message ?? '')
        : '';
  return FETCH_FAILURE_RE.test(message);
}

export const ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  UNAUTHORIZED: 'Session expirée : reconnectez-vous.',
  FORBIDDEN_ROLE: "Ce compte n'a pas le rôle caisse (pos).",
  VALIDATION: 'Données de vente invalides.',
  SESSION_NOT_OPEN: "Aucune session de caisse ouverte : ouvrez la caisse avant d'encaisser.",
  SESSION_ALREADY_OPEN: 'Une session est déjà ouverte sur cette caisse.',
  TOTALS_MISMATCH: 'Écart de totaux entre la caisse et le serveur : recalculez le panier.',
  PAYMENTS_MISMATCH: 'La somme des paiements ne correspond pas au total.',
  REFUND_EXCEEDS_SOLD: 'Le remboursement dépasse les quantités vendues sur ce ticket.',
  REFUND_TARGET_NOT_FOUND: 'Ticket d’origine introuvable pour ce remboursement.',
  QUOTE_NOT_FOUND: 'Devis introuvable.',
  NOT_FOUND: 'Élément introuvable.',
  DB_ERROR: 'Erreur base de données : la vente n’a pas été enregistrée.',
  FISKALY_ERROR: 'Signature en attente (Fiskaly indisponible) : la vente est enregistrée.',
  INTERNAL: 'Erreur interne du serveur.',
  NETWORK: 'Serveur injoignable (réseau).',
  TIMEOUT: 'Le serveur ne répond pas (délai dépassé).',
  QUEUED_AFTER_CB:
    'Paiement CB accepté mais opération non enregistrée (réseau) : mise en file, rejouée automatiquement.',
  REGISTER_NOT_FOUND: 'Caisse introuvable ou inactive.',
  BUSINESS_AT_OUT_OF_RANGE:
    'Horodatage de la vente hors tolérance : vérifiez l’heure du poste (ou vente hors ligne trop ancienne).',
  CHAIN_INCONSISTENT: 'Chaînage des tickets incohérent : contactez l’administrateur.',
  PRODUCT_NOT_FOUND: 'Produit introuvable.',
  OFFLINE_LIMIT_REACHED:
    'Limite hors ligne atteinte : rétablissez la connexion et synchronisez avant de nouvelles ventes.',
  OFFLINE_FORBIDDEN: 'Opération impossible hors ligne.',
};

/** Message en clair pour l'UI (SPEC §5). */
export function describeApiError(err: unknown): string {
  if (isApiError(err)) {
    const base = ERROR_MESSAGES[err.code] ?? err.message;
    if (err.code === 'VALIDATION' && err.details)
      return `${base} ${detailsToText(err.details)}`.trim();
    return base;
  }
  if (err instanceof Error) {
    const code = err.message as ApiErrorCode;
    if (code in ERROR_MESSAGES) return ERROR_MESSAGES[code];
    return err.message;
  }
  return 'Erreur inconnue';
}

function detailsToText(details: unknown): string {
  if (typeof details === 'string') return details;
  if (Array.isArray(details)) return details.map(String).join(' ; ');
  if (details && typeof details === 'object') {
    const d = details as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    const parts: string[] = [];
    if (d.formErrors?.length) parts.push(...d.formErrors);
    if (d.fieldErrors) {
      for (const [k, v] of Object.entries(d.fieldErrors))
        parts.push(`${k} : ${(v ?? []).join(', ')}`);
    }
    if (parts.length) return parts.join(' ; ');
  }
  return '';
}
