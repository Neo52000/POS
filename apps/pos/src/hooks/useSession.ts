import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isNetworkFailure } from '@/lib/apiError';
import { isOffline } from '@/lib/connectivity';
import { supabase } from '@/lib/supabase';
import { useSessionStore } from '@/stores/sessionStore';
import type { PosRegister, PosSession } from '@/types/pos';

export interface SessionLoad {
  register: PosRegister | null;
  registers: PosRegister[];
  session: PosSession | null;
  /** Vrai si les données viennent du cache local (réseau indisponible). */
  fromCache?: boolean;
}

/** Dernière caisse + session ouverte connues (utilisées hors ligne). */
export const SESSION_CACHE_KEY = 'pos.session.cache.v1';

interface SessionCache {
  register: PosRegister;
  registers: PosRegister[];
  session: PosSession | null;
  cached_at: string;
}

export function readSessionCache(): SessionCache | null {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY);
    return raw ? (JSON.parse(raw) as SessionCache) : null;
  } catch {
    return null;
  }
}

function writeSessionCache(load: SessionLoad): void {
  try {
    if (!load.register) {
      localStorage.removeItem(SESSION_CACHE_KEY);
      return;
    }
    const cache: SessionCache = {
      register: load.register,
      registers: load.registers,
      session: load.session && load.session.status === 'open' ? load.session : null,
      cached_at: new Date().toISOString(),
    };
    localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // stockage indisponible
  }
}

/** Met à jour la session du cache (ouverture / clôture). */
export function updateCachedSession(session: PosSession | null): void {
  const cache = readSessionCache();
  if (!cache) return;
  try {
    localStorage.setItem(
      SESSION_CACHE_KEY,
      JSON.stringify({ ...cache, session: session?.status === 'open' ? session : null }),
    );
  } catch {
    // stockage indisponible
  }
}

/**
 * Réseau : lecture Supabase puis mise en cache. Échec réseau (ou caisse hors ligne) : dernière
 * caisse/session connues. Sans cache, l'erreur est propagée : on ne prétend jamais qu'une session
 * est ouverte.
 */
async function loadSession(preferredRegisterId: string | null): Promise<SessionLoad> {
  try {
    const load = await loadSessionRemote(preferredRegisterId);
    writeSessionCache(load);
    return load;
  } catch (e) {
    const cache = readSessionCache();
    if (
      cache &&
      (isOffline() || isNetworkFailure(e)) &&
      (!preferredRegisterId || cache.register.id === preferredRegisterId)
    ) {
      return {
        register: cache.register,
        registers: cache.registers,
        session: cache.session,
        fromCache: true,
      };
    }
    throw e;
  }
}

async function loadSessionRemote(preferredRegisterId: string | null): Promise<SessionLoad> {
  const { data: regs, error } = await supabase
    .from('pos_registers')
    .select('id, code, label, is_active')
    .eq('is_active', true)
    .order('code');
  if (error) throw new Error(error.message);
  const registers = (regs ?? []) as PosRegister[];
  const register = registers.find((r) => r.id === preferredRegisterId) ?? registers[0] ?? null;
  if (!register) return { register: null, registers, session: null };
  const { data: session, error: sErr } = await supabase
    .from('pos_sessions')
    .select('*')
    .eq('register_id', register.id)
    .eq('status', 'open')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (sErr) throw new Error(sErr.message);
  return { register, registers, session: (session as PosSession | null) ?? null };
}

/** Charge la caisse (mémorisée ou première active) et sa session ouverte ; synchronise le store. */
export function useSession() {
  const registerId = useSessionStore((s) => s.registerId);
  const user = useSessionStore((s) => s.user);
  const setRegister = useSessionStore((s) => s.setRegister);
  const setSession = useSessionStore((s) => s.setSession);

  const query = useQuery({
    queryKey: ['session', registerId, user?.id ?? null],
    queryFn: () => loadSession(registerId),
    enabled: !!user,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!query.data) return;
    setRegister(query.data.register);
    setSession(query.data.session);
  }, [query.data, setRegister, setSession]);

  return query;
}
