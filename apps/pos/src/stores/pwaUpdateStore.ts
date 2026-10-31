import { create } from 'zustand';

// Séparé de lib/pwaUpdate.ts (module virtuel du plugin PWA, absent des tests).
interface PwaUpdateState {
  /** Nouvelle version téléchargée, en attente d'activation (bandeau affiché). */
  available: boolean;
  /** Active la nouvelle version et recharge la page (panier et brouillon d'encaissement persistés). */
  apply: () => void;
}

export const usePwaUpdateStore = create<PwaUpdateState>(() => ({
  available: false,
  apply: () => window.location.reload(),
}));
