import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useSessionStore } from '@/stores/sessionStore';
import type { PosRegister, PosSession } from '@/types/pos';

export interface SessionLoad {
  register: PosRegister | null;
  registers: PosRegister[];
  session: PosSession | null;
}

async function loadSession(preferredRegisterId: string | null): Promise<SessionLoad> {
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
