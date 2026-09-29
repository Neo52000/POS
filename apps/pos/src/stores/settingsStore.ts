import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { env } from '@/lib/env';
import type { PosProduct } from '@/types/pos';

export const MAX_FAVORITES = 12;

/** `system` : suit le réglage clair / sombre du poste (`prefers-color-scheme`). */
export type ThemePreference = 'system' | 'light' | 'dark';

/** Réglages locaux du poste (pont TPE) — jamais de secret Supabase ici. */
export interface LocalSettings {
  bridgeUrl: string;
  bridgeToken: string;
  /** Verrouillage automatique après N minutes d'inactivité (0 = désactivé). */
  autoLockMinutes: number;
  /** Remise ligne maximale (%) sans droits administrateur. */
  maxDiscountPercent: number;
  /**
   * Touches rapides de la page de vente (instantané pour l'affichage ; le produit est relu au
   * catalogue au moment de l'ajout, jamais vendu au prix mémorisé).
   */
  favorites: PosProduct[];
  /** Thème d'affichage (SPEC §13.4). */
  theme: ThemePreference;
  /** Mode tactile « terminal de caisse » (SPEC §13.5). */
  touchMode: boolean;
  /** Clavier virtuel à l'écran pour les champs texte (mode tactile). */
  virtualKeyboard: boolean;
  /** Masque le curseur de la souris (écran tactile seul, mode tactile). */
  hideCursor: boolean;
}

interface SettingsState extends LocalSettings {
  update: (patch: Partial<LocalSettings>) => void;
  toggleFavorite: (product: PosProduct) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      bridgeUrl: env.bridgeUrlDefault,
      bridgeToken: '',
      autoLockMinutes: 5,
      maxDiscountPercent: 30,
      favorites: [],
      theme: 'dark',
      touchMode: false,
      virtualKeyboard: true,
      hideCursor: false,
      update: (patch) => set(patch),
      toggleFavorite: (product) =>
        set((s) =>
          s.favorites.some((f) => f.id === product.id)
            ? { favorites: s.favorites.filter((f) => f.id !== product.id) }
            : s.favorites.length >= MAX_FAVORITES
              ? s
              : { favorites: [...s.favorites, product] },
        ),
    }),
    { name: 'pos.settings.v1' },
  ),
);
