import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ThemePreference } from '@/stores/settingsStore';

const DARK_QUERY = '(prefers-color-scheme: dark)';
/** Couleurs de la barre du navigateur / PWA installée (≡ `--c-surface`). */
const THEME_COLOR = { dark: '#111118', light: '#ffffff' } as const;

export function resolveTheme(pref: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY).matches : true;
}

/**
 * Applique le thème et le mode tactile sur `<html>` (`data-theme`, `data-touch`, `data-cursor`).
 * Monté une seule fois à la racine : couvre aussi la connexion, le verrouillage et l'écran client.
 */
export function useAppearance(): void {
  const theme = useSettingsStore((s) => s.theme);
  const touchMode = useSettingsStore((s) => s.touchMode);
  const hideCursor = useSettingsStore((s) => s.hideCursor);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const resolved = resolveTheme(theme, systemDark);
    root.dataset['theme'] = resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', THEME_COLOR[resolved]);
  }, [theme, systemDark]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset['touch'] = touchMode ? 'on' : 'off';
    root.dataset['cursor'] = touchMode && hideCursor ? 'hidden' : 'visible';
    if (!touchMode) return;
    // Pas de menu contextuel (appui long) hors champs de saisie et zones sélectionnables.
    const onContextMenu = (e: MouseEvent): void => {
      const target = e.target as Element | null;
      if (target?.closest('input, textarea, .selectable')) return;
      e.preventDefault();
    };
    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, [touchMode, hideCursor]);
}
