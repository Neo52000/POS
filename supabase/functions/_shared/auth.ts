import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { ApiError } from './http.ts';
import { serviceClient, serviceRoleKey, userClient } from './supabase.ts';

export interface AuthContext {
  /** 'service' = appel interne (cron, autre fonction) ; 'user' = vendeur/admin authentifié. */
  kind: 'service' | 'user';
  userId: string | null;
  /** Client à utiliser pour les RPC : service role dans les deux cas (les RPC vérifient is_pos() via le JWT utilisateur sinon). */
  db: SupabaseClient;
  /** Client porteur du JWT utilisateur (null pour un appel service). */
  userDb: SupabaseClient | null;
}

function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** Autorise uniquement le service role (crons). */
export function requireService(req: Request): AuthContext {
  const token = bearer(req);
  if (!token || token !== serviceRoleKey()) throw new ApiError('UNAUTHORIZED', 'service_role requis');
  return { kind: 'service', userId: null, db: serviceClient(), userDb: null };
}

/**
 * Autorise un vendeur (rôle `pos`), un admin, ou le service role.
 * Les RPC métier sont ensuite appelées avec le client utilisateur pour que `is_pos()` soit
 * évalué avec son JWT (auth.uid()).
 */
export async function requirePos(req: Request): Promise<AuthContext> {
  const token = bearer(req);
  if (!token) throw new ApiError('UNAUTHORIZED', 'JWT manquant');
  if (token === serviceRoleKey()) {
    return { kind: 'service', userId: null, db: serviceClient(), userDb: null };
  }
  const udb = userClient(token);
  const { data, error } = await udb.auth.getUser(token);
  if (error || !data.user) throw new ApiError('UNAUTHORIZED', 'JWT invalide');
  const { data: ok, error: roleErr } = await udb.rpc('is_pos');
  if (roleErr) throw new ApiError('DB_ERROR', roleErr.message);
  if (ok !== true) throw new ApiError('FORBIDDEN_ROLE', 'Rôle pos ou admin requis');
  return { kind: 'user', userId: data.user.id, db: serviceClient(), userDb: udb };
}

/**
 * Autorise un administrateur de caisse (`is_pos_admin()`, évalué avec le JWT utilisateur) ou le
 * service role (crons, appels internes). Vendeur simple → 403 FORBIDDEN_ROLE.
 */
export async function requirePosAdmin(req: Request): Promise<AuthContext> {
  const auth = await requirePos(req);
  if (auth.kind === 'service' || !auth.userDb) return auth;
  const { data: ok, error } = await auth.userDb.rpc('is_pos_admin');
  if (error) throw new ApiError('DB_ERROR', error.message);
  if (ok !== true) throw new ApiError('FORBIDDEN_ROLE', 'Rôle admin requis');
  return auth;
}
