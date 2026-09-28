import { Keyboard, Monitor, Moon, MousePointerClick, Sun, TabletSmartphone } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';
import type { ThemePreference } from '@/stores/settingsStore';

const THEMES: Array<{ value: ThemePreference; label: string; icon: typeof Sun }> = [
  { value: 'dark', label: 'Sombre', icon: Moon },
  { value: 'light', label: 'Clair', icon: Sun },
  { value: 'system', label: 'Système', icon: Monitor },
];

function Toggle({
  checked,
  onChange,
  label,
  description,
  icon: Icon,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
  icon: typeof Sun;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-touch w-full items-center gap-3 rounded-xl border border-border bg-bg px-4 py-2 text-left disabled:opacity-40"
      data-testid={testId}
    >
      <Icon className="h-5 w-5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        <span className="block text-sm text-muted">{description}</span>
      </span>
      <span
        className={cn(
          'relative h-8 w-14 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-border',
        )}
      >
        <span
          className={cn(
            'absolute top-1 h-6 w-6 rounded-full bg-surface shadow transition-all',
            checked ? 'left-7' : 'left-1',
          )}
        />
      </span>
    </button>
  );
}

/** Thème clair / sombre et mode tactile du poste (réglages locaux, effet immédiat). */
export function AppearanceSection() {
  const theme = useSettingsStore((s) => s.theme);
  const touchMode = useSettingsStore((s) => s.touchMode);
  const virtualKeyboard = useSettingsStore((s) => s.virtualKeyboard);
  const hideCursor = useSettingsStore((s) => s.hideCursor);
  const update = useSettingsStore((s) => s.update);

  return (
    <section
      className="flex flex-col gap-4 rounded-3xl border border-border bg-surface p-6"
      data-testid="appearance-section"
    >
      <h2 className="text-xl font-semibold">Affichage et écran tactile</h2>
      <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Thème">
        {THEMES.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={theme === value}
            onClick={() => update({ theme: value })}
            className={cn(
              'flex min-h-touch flex-col items-center justify-center gap-1 rounded-xl border px-3 py-2 text-sm font-medium',
              theme === value
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-bg text-muted hover:text-text',
            )}
            data-testid={`theme-${value}`}
          >
            <Icon className="h-5 w-5" /> {label}
          </button>
        ))}
      </div>
      <Toggle
        checked={touchMode}
        onChange={(v) => update({ touchMode: v })}
        label="Mode tactile (terminal de caisse)"
        description="Aucun zoom ni sélection, retour à l’appui, bouton plein écran, clavier système masqué."
        icon={TabletSmartphone}
        testId="touch-mode"
      />
      <Toggle
        checked={virtualKeyboard}
        onChange={(v) => update({ virtualKeyboard: v })}
        label="Clavier virtuel AZERTY"
        description="S’ouvre sur les champs texte ; pavé numérique pour les montants."
        icon={Keyboard}
        disabled={!touchMode}
        testId="virtual-keyboard-toggle"
      />
      <Toggle
        checked={hideCursor}
        onChange={(v) => update({ hideCursor: v })}
        label="Masquer le curseur"
        description="Écran tactile seul, sans souris."
        icon={MousePointerClick}
        disabled={!touchMode}
        testId="hide-cursor"
      />
    </section>
  );
}
