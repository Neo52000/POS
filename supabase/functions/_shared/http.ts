import { corsHeaders } from './cors.ts';

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN_ROLE'
  | 'VALIDATION'
  | 'SESSION_NOT_OPEN'
  | 'SESSION_ALREADY_OPEN'
  | 'TOTALS_MISMATCH'
  | 'PAYMENTS_MISMATCH'
  | 'REFUND_EXCEEDS_SOLD'
  | 'REFUND_TARGET_NOT_FOUND'
  | 'QUOTE_NOT_FOUND'
  | 'NOT_FOUND'
  | 'DB_ERROR'
  | 'FISKALY_ERROR'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN_ROLE: 403,
  VALIDATION: 400,
  SESSION_NOT_OPEN: 409,
  SESSION_ALREADY_OPEN: 409,
  TOTALS_MISMATCH: 422,
  PAYMENTS_MISMATCH: 422,
  REFUND_EXCEEDS_SOLD: 422,
  REFUND_TARGET_NOT_FOUND: 404,
  QUOTE_NOT_FOUND: 404,
  NOT_FOUND: 404,
  DB_ERROR: 500,
  FISKALY_ERROR: 502,
  INTERNAL: 500,
};

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json(STATUS_BY_CODE[err.code], {
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
  }
  // Erreurs plpgsql : MESSAGE = code métier (voir SPEC §5), DETAIL = json.
  const pg = err as { message?: string; details?: string; code?: string };
  if (pg && typeof pg.message === 'string' && pg.message in STATUS_BY_CODE) {
    const code = pg.message as ErrorCode;
    let details: unknown = pg.details ?? null;
    if (typeof details === 'string') {
      try {
        details = JSON.parse(details);
      } catch {
        // détail non JSON : conservé tel quel
      }
    }
    return json(STATUS_BY_CODE[code], { error: { code, message: code, details } });
  }
  console.error('[edge] unhandled error', err);
  return json(500, {
    error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Erreur interne' },
  });
}

export function handleOptions(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  return null;
}

export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new ApiError('VALIDATION', 'Corps JSON invalide');
  }
}
