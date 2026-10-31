import { registerSW } from 'virtual:pwa-register';
import { usePwaUpdateStore } from '@/stores/pwaUpdateStore';

/** Intervalle de recherche d'une nouvelle version (caisse ouverte des heures en plein écran). */
export const PWA_UPDATE_CHECK_MS = 15 * 60_000;

/**
 * Enregistre le service worker en mode « prompt » : une nouvelle version n'est jamais activée
 * d'office (pas de rechargement en pleine vente) ; la caisse affiche un bandeau et le vendeur
 * choisit le moment. Recherche de mise à jour à l'ouverture puis toutes les 15 minutes.
 */
export function initPwaUpdate(): void {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      usePwaUpdateStore.setState({ available: true, apply: () => void updateSW(true) });
    },
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      setInterval(() => {
        if (navigator.onLine) void registration.update().catch(() => undefined);
      }, PWA_UPDATE_CHECK_MS);
    },
  });
}
