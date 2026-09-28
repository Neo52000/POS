/**
 * Clavier virtuel du mode tactile (SPEC §13.5) : logique pure (édition du texte) et pilotage du
 * champ ciblé. Le champ reçoit un vrai événement `input` : les champs React contrôlés, les
 * filtres (`onChange`) et les validations restent ceux de la saisie clavier.
 */

export type VkAction =
  { type: 'insert'; text: string } | { type: 'backspace' } | { type: 'clear' } | { type: 'enter' };

export interface EditState {
  value: string;
  /** Position du curseur / début de sélection. */
  start: number;
  /** Fin de sélection (= `start` sans sélection). */
  end: number;
}

/** Applique une action au texte ; renvoie la nouvelle valeur et la position du curseur. */
export function applyEdit(
  state: EditState,
  action: VkAction,
  maxLength?: number,
): { value: string; caret: number } {
  const { value } = state;
  const start = Math.max(0, Math.min(state.start, value.length));
  const end = Math.max(start, Math.min(state.end, value.length));
  switch (action.type) {
    case 'insert': {
      let text = action.text;
      if (maxLength !== undefined && maxLength >= 0) {
        const room = maxLength - (value.length - (end - start));
        text = text.slice(0, Math.max(0, room));
      }
      return { value: value.slice(0, start) + text + value.slice(end), caret: start + text.length };
    }
    case 'backspace':
      if (end > start) return { value: value.slice(0, start) + value.slice(end), caret: start };
      if (start === 0) return { value, caret: 0 };
      return { value: value.slice(0, start - 1) + value.slice(end), caret: start - 1 };
    case 'clear':
      return { value: '', caret: 0 };
    case 'enter':
      return { value, caret: end };
  }
}

export type VkTarget = HTMLInputElement | HTMLTextAreaElement;

const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'password', 'tel', 'url', 'number']);

/** Champ de saisie texte actif (hors cases à cocher, boutons, champs désactivés). */
export function isTextField(el: Element | null): el is VkTarget {
  if (!el) return false;
  const isInput = el instanceof HTMLInputElement;
  if (!isInput && !(el instanceof HTMLTextAreaElement)) return false;
  if (el.disabled || el.readOnly) return false;
  return !isInput || TEXT_TYPES.has(el.type);
}

/**
 * Champ pilotable par le clavier virtuel. `data-no-vk` (sur le champ ou un parent) l'exclut :
 * champ déjà servi par un pavé numérique à l'écran.
 */
export function isVkTarget(el: Element | null): el is VkTarget {
  return isTextField(el) && !el.closest('[data-no-vk]');
}

/** Disposition adaptée : pavé numérique pour les montants, quantités et codes. */
export function preferredLayout(el: VkTarget): 'alpha' | 'numeric' {
  const mode = el.dataset['vkInputmode'] ?? el.getAttribute('inputmode') ?? '';
  if (mode === 'numeric' || mode === 'decimal' || mode === 'tel') return 'numeric';
  if (el instanceof HTMLInputElement && el.type === 'number') return 'numeric';
  return 'alpha';
}

/**
 * Supprime le clavier du système d'exploitation (Windows, Android, iPadOS) sur le champ : le
 * mode de saisie d'origine est conservé dans `data-vk-inputmode` pour choisir la disposition.
 */
export function suppressNativeKeyboard(el: VkTarget): void {
  if (el.dataset['vkInputmode'] === undefined) {
    el.dataset['vkInputmode'] = el.getAttribute('inputmode') ?? '';
  }
  el.setAttribute('inputmode', 'none');
}

/** Rétablit le mode de saisie d'origine (sortie du mode tactile). */
export function restoreNativeKeyboard(el: VkTarget): void {
  const original = el.dataset['vkInputmode'];
  if (original === undefined) return;
  if (original) el.setAttribute('inputmode', original);
  else el.removeAttribute('inputmode');
  delete el.dataset['vkInputmode'];
}

function selection(el: VkTarget): { start: number; end: number } {
  try {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (start !== null && end !== null) return { start, end };
  } catch {
    // type=email / number : pas d'API de sélection
  }
  return { start: el.value.length, end: el.value.length };
}

/** Écrit la valeur comme le ferait le clavier (setter natif + `input`, compatible React). */
function setNativeValue(el: VkTarget, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Exécute une touche sur le champ ciblé. */
export function pressKey(el: VkTarget, action: VkAction): void {
  if (action.type === 'enter') {
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const notPrevented = el.dispatchEvent(ev);
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    // Soumission implicite d'un formulaire (un Enter synthétique ne la déclenche pas).
    if (notPrevented && el instanceof HTMLInputElement && el.form) el.form.requestSubmit();
    return;
  }
  const { start, end } = selection(el);
  const maxLength = el.maxLength >= 0 ? el.maxLength : undefined;
  const next = applyEdit({ value: el.value, start, end }, action, maxLength);
  if (next.value !== el.value) setNativeValue(el, next.value);
  try {
    el.setSelectionRange(next.caret, next.caret);
  } catch {
    // type sans API de sélection
  }
}
