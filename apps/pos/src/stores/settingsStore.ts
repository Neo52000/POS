import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { env } from '@/lib/env';
import type { PosProduct } from '@/types/pos';

export const MAX_FAVORITES = 12;

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
