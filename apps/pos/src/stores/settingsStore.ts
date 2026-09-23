import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { env } from '@/lib/env';

/** Réglages locaux du poste (pont TPE) — jamais de secret Supabase ici. */
export interface LocalSettings {
  bridgeUrl: string;
  bridgeToken: string;
  /** Verrouillage automatique après N minutes d'inactivité (0 = désactivé). */
  autoLockMinutes: number;
}

interface SettingsState extends LocalSettings {
  update: (patch: Partial<LocalSettings>) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      bridgeUrl: env.bridgeUrlDefault,
      bridgeToken: '',
      autoLockMinutes: 5,
      update: (patch) => set(patch),
    }),
    { name: 'pos.settings.v1' },
  ),
);
