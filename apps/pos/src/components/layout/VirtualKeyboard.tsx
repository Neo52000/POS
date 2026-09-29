import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowBigUp, ChevronDown, CornerDownLeft, Delete } from 'lucide-react';
import {
  isTextField,
  isVkTarget,
  preferredLayout,
  pressKey,
  restoreNativeKeyboard,
  suppressNativeKeyboard,
} from '@/lib/virtualKeyboard';
import type { VkAction, VkTarget } from '@/lib/virtualKeyboard';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';

type Layer = 'alpha' | 'symbols' | 'numeric';

const ALPHA_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['a', 'z', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['q', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm'],
  ['w', 'x', 'c', 'v', 'b', 'n', 'é', 'è', 'à', 'ç'],
];

const SYMBOL_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['@', '.', ',', '-', '_', "'", '"', '/', ':', ';'],
  ['(', ')', '&', '+', '*', '=', '#', '%', '€', '?'],
  ['!', 'ê', 'ë', 'ï', 'î', 'ô', 'ù', 'û', 'œ', 'æ'],
];

const NUMERIC_ROWS = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  [',', '0', '-'],
];

function Key({
  label,
  onPress,
  className,
  wide,
  testId,
  active,
}: {
  label: React.ReactNode;
  onPress: () => void;
  className?: string;
  wide?: number;
  testId?: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      // pointerdown + preventDefault : le champ garde le focus (pas de clavier système, pas de
      // fermeture des dialogues), réaction immédiate comme une touche physique.
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      className={cn(
        'flex h-14 min-w-0 items-center justify-center rounded-xl border border-border bg-surface text-xl font-medium text-text shadow-sm active:bg-accent active:text-on-accent',
        active && 'bg-accent/20 text-accent',
        className,
      )}
      style={{ flex: wide ?? 1 }}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

/**
 * Clavier virtuel AZERTY (mode tactile) : s'ouvre sur tout champ texte ciblé, disposition
 * numérique pour les champs `inputMode="decimal|numeric"`. Désactivable par champ ou par zone
 * avec `data-no-vk` (champs déjà servis par un pavé numérique à l'écran).
 */
export function VirtualKeyboard() {
  const enabled = useSettingsStore((s) => s.touchMode && s.virtualKeyboard);
  const [target, setTarget] = useState<VkTarget | null>(null);
  const [layer, setLayer] = useState<Layer>('alpha');
  const [shift, setShift] = useState(false);
  const panel = useRef<HTMLDivElement | null>(null);

  // Cible courante lue par les écouteurs DOM (hors cycle de rendu).
  const targetRef = useRef<VkTarget | null>(null);
  targetRef.current = target;

  useEffect(() => {
    if (!enabled) return;
    /** Dernier champ touché par l'utilisateur : seul un appui ouvre le clavier. */
    let tapped: Element | null = null;
    const openOn = (el: VkTarget): void => {
      setTarget(el);
      setLayer(preferredLayout(el) === 'numeric' ? 'numeric' : 'alpha');
      setShift(false);
    };
    const onPointerDown = (e: PointerEvent): void => {
      const el = e.target as Element | null;
      // Avant le focus : aucun clavier système, y compris sur les champs à pavé intégré.
      if (isTextField(el)) suppressNativeKeyboard(el);
      tapped = isVkTarget(el) ? el : null;
      // Nouvel appui sur le champ déjà actif (clavier refermé) : réouverture.
      if (isVkTarget(el) && el === document.activeElement) openOn(el);
    };
    const onFocusIn = (e: FocusEvent): void => {
      const el = e.target as Element | null;
      if (isTextField(el)) suppressNativeKeyboard(el);
      if (!isVkTarget(el)) return;
      // Focus programmatique (retour au champ de recherche après un scan, autoFocus) : le
      // clavier ne s'ouvre pas tout seul ; il suit le focus s'il est déjà ouvert.
      if (el === tapped || targetRef.current) openOn(el);
      tapped = null;
    };
    const onFocusOut = (): void => {
      // Le focus passe d'un champ à l'autre : on attend le focusin suivant.
      setTimeout(() => {
        if (!isVkTarget(document.activeElement)) setTarget(null);
      }, 0);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    if (isTextField(document.activeElement)) suppressNativeKeyboard(document.activeElement);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      for (const el of document.querySelectorAll<VkTarget>('[data-vk-inputmode]')) {
        restoreNativeKeyboard(el);
      }
      setTarget(null);
    };
  }, [enabled]);

  const open = enabled && target !== null && target.isConnected;

  // Hauteur réservée : le contenu (pages, dialogues) remonte au-dessus du clavier.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (!open || !panel.current) {
      delete root.dataset['vkOpen'];
      root.style.removeProperty('--vk-h');
      return;
    }
    const el = panel.current;
    const apply = (): void => {
      root.style.setProperty('--vk-h', `${el.offsetHeight}px`);
    };
    apply();
    root.dataset['vkOpen'] = '';
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(apply) : null;
    ro?.observe(el);
    target?.scrollIntoView({ block: 'nearest' });
    return () => {
      ro?.disconnect();
      delete root.dataset['vkOpen'];
      root.style.removeProperty('--vk-h');
    };
  }, [open, target]);

  const press = useCallback(
    (action: VkAction) => {
      if (!target) return;
      pressKey(target, action);
      if (action.type === 'insert' && shift) setShift(false);
    },
    [target, shift],
  );

  if (!open) return null;

  const letter = (k: string): string => (shift ? k.toUpperCase() : k);
  const rows = layer === 'symbols' ? SYMBOL_ROWS : ALPHA_ROWS;

  return createPortal(
    <div
      ref={panel}
      data-vk
      data-testid="virtual-keyboard"
      role="group"
      aria-label="Clavier virtuel"
      // Au-dessus des dialogues Radix (qui neutralisent les clics hors contenu).
      className="pointer-events-auto fixed inset-x-0 bottom-0 z-[70] border-t border-border bg-bg/95 p-2 shadow-2xl backdrop-blur"
      style={{ pointerEvents: 'auto' }}
      onPointerDown={(e) => e.preventDefault()}
    >
      {layer === 'numeric' ? (
        <div className="mx-auto flex max-w-md flex-col gap-2">
          {NUMERIC_ROWS.map((row) => (
            <div key={row.join('')} className="flex gap-2">
              {row.map((k) => (
                <Key
                  key={k}
                  label={k}
                  onPress={() => press({ type: 'insert', text: k })}
                  testId={`vk-${k}`}
                />
              ))}
            </div>
          ))}
          <div className="flex gap-2">
            <Key label="ABC" onPress={() => setLayer('alpha')} className="text-base" />
            <Key
              label={<Delete className="h-6 w-6" />}
              onPress={() => press({ type: 'backspace' })}
              testId="vk-backspace"
            />
            <Key
              label="C"
              onPress={() => press({ type: 'clear' })}
              className="text-danger"
              testId="vk-clear"
            />
            <Key
              label={<CornerDownLeft className="h-6 w-6" />}
              onPress={() => press({ type: 'enter' })}
              className="bg-accent text-on-accent"
              testId="vk-enter"
            />
            <Key
              label={<ChevronDown className="h-6 w-6" />}
              onPress={() => setTarget(null)}
              testId="vk-close"
            />
          </div>
        </div>
      ) : (
        <div className="mx-auto flex max-w-5xl flex-col gap-2">
          {rows.map((row, i) => (
            <div key={row.join('')} className="flex gap-2">
              {i === 3 && layer === 'alpha' && (
                <Key
                  label={<ArrowBigUp className="h-6 w-6" />}
                  onPress={() => setShift((s) => !s)}
                  active={shift}
                  wide={1.5}
                  testId="vk-shift"
                />
              )}
              {row.map((k) => (
                <Key
                  key={k}
                  label={layer === 'alpha' ? letter(k) : k}
                  onPress={() => press({ type: 'insert', text: layer === 'alpha' ? letter(k) : k })}
                  testId={`vk-${k}`}
                />
              ))}
              {i === 0 && (
                <Key
                  label={<Delete className="h-6 w-6" />}
                  onPress={() => press({ type: 'backspace' })}
                  wide={1.5}
                  testId="vk-backspace"
                />
              )}
            </div>
          ))}
          <div className="flex gap-2">
            <Key
              label={layer === 'symbols' ? 'ABC' : '&?123'}
              onPress={() => setLayer((l) => (l === 'symbols' ? 'alpha' : 'symbols'))}
              wide={1.5}
              className="text-base"
              testId="vk-layer"
            />
            <Key label="123" onPress={() => setLayer('numeric')} className="text-base" />
            <Key label="@" onPress={() => press({ type: 'insert', text: '@' })} />
            <Key
              label="espace"
              onPress={() => press({ type: 'insert', text: ' ' })}
              wide={5}
              className="text-base text-muted"
              testId="vk-space"
            />
            <Key label="." onPress={() => press({ type: 'insert', text: '.' })} />
            <Key
              label={<CornerDownLeft className="h-6 w-6" />}
              onPress={() => press({ type: 'enter' })}
              wide={1.5}
              className="bg-accent text-on-accent"
              testId="vk-enter"
            />
            <Key
              label={<ChevronDown className="h-6 w-6" />}
              onPress={() => setTarget(null)}
              testId="vk-close"
            />
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
