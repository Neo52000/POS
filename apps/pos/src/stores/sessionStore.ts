import { create } from 'zustand';
import type { PosRegister, PosSession } from '@/types/pos';

export interface PosUser {
  id: string;
  email: string;
}

const REGISTER_KEY = 'pos.register_id';

function readRegisterId(): string | null {
  try {
    return localStorage.getItem(REGISTER_KEY);
  } catch {
    return null;
  }
}

interface SessionState {
  /** `loading` tant que l'état d'auth Supabase n'est pas connu. */
  authStatus: 'loading' | 'signed_out' | 'signed_in';
  user: PosUser | null;
  register: PosRegister | null;
  session: PosSession | null;
  /** Caisse mémorisée sur ce poste (localStorage). */
  registerId: string | null;
  locked: boolean;
  setUser: (user: PosUser | null) => void;
  setRegister: (register: PosRegister | null) => void;
  setSession: (session: PosSession | null) => void;
  lock: () => void;
  unlock: () => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>()((set) => ({
  authStatus: 'loading',
  user: null,
  register: null,
  session: null,
  registerId: readRegisterId(),
  locked: false,
  setUser: (user) => set({ user, authStatus: user ? 'signed_in' : 'signed_out' }),
  setRegister: (register) => {
    try {
      if (register) localStorage.setItem(REGISTER_KEY, register.id);
    } catch {
      // stockage indisponible
    }
    set({ register, registerId: register?.id ?? null });
  },
  setSession: (session) => set({ session: session && session.status === 'open' ? session : null }),
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
  reset: () => set({ user: null, authStatus: 'signed_out', session: null, locked: false }),
}));

/** Sélecteur : session ouverte ? */
export const selectSessionOpen = (s: SessionState): boolean => s.session?.status === 'open';
