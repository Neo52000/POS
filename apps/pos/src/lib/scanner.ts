/**
 * Détection d'une douchette HID (émulation clavier) : rafale de caractères espacés de
 * moins de `maxIntervalMs`, terminée par `Enter`. Une frappe humaine (intervalle plus long)
 * remet le tampon à zéro et n'est jamais interceptée.
 */

export interface ScannerOptions {
  /** Intervalle maximal entre deux touches d'une rafale (défaut 40 ms). */
  maxIntervalMs?: number;
  /** Longueur minimale d'un code (défaut 4). */
  minLength?: number;
  /** Longueur maximale (défaut 64). */
  maxLength?: number;
  /** Cible des écouteurs (défaut `window`). */
  target?: EventTarget;
  /** Horloge injectable (tests). */
  now?: () => number;
  /** Si `true` (défaut), seuls les EAN-8/13 valides sont acceptés ; sinon tout code ≥ minLength. */
  eanOnly?: boolean;
  /** Rafale de douchette terminée par Enter mais code refusé (checksum, format) : signalée. */
  onReject?: (code: string) => void;
}

/**
 * Retire du champ actif le 1er caractère d'une rafale, déjà écrit avant qu'on sache qu'il
 * s'agissait d'une douchette. Passe par le setter natif + événement `input` (compatible React).
 */
function retractFirstChar(target: EventTarget | null, ch: string): void {
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
  const { value } = target;
  if (!value.endsWith(ch) || target.selectionStart !== value.length) return;
  const proto =
    target instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) return;
  setter.call(target, value.slice(0, -1));
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Checksum EAN-8 / EAN-13 (GTIN, pondération 3/1 depuis la droite). */
export function isValidEan(code: string): boolean {
  if (!/^\d{8}$|^\d{13}$/.test(code)) return false;
  let sum = 0;
  for (let i = 0; i < code.length - 1; i++) {
    const digit = code.charCodeAt(code.length - 2 - i) - 48;
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === code.charCodeAt(code.length - 1) - 48;
}

/** Normalise un code scanné : supprime les espaces ; UPC-A (12) → EAN-13 (préfixe 0). */
export function normalizeScannedCode(raw: string): string {
  const code = raw.trim();
  if (/^\d{12}$/.test(code)) return `0${code}`;
  return code;
}

export function attachScanner(
  onScan: (code: string) => void,
  options: ScannerOptions = {},
): () => void {
  const maxInterval = options.maxIntervalMs ?? 40;
  const minLength = options.minLength ?? 4;
  const maxLength = options.maxLength ?? 64;
  const target = options.target ?? window;
  const now = options.now ?? (() => performance.now());
  const eanOnly = options.eanOnly ?? true;

  let buffer = '';
  let lastAt = 0;
  let burst = false;
  /** Élément où le 1er caractère du tampon a été tapé. */
  let firstTarget: EventTarget | null = null;

  const reset = (): void => {
    buffer = '';
    burst = false;
    firstTarget = null;
  };

  const handler = (event: Event): void => {
    const e = event as KeyboardEvent;
    if (e.defaultPrevented && e.key !== 'Enter') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = now();
    const delta = t - lastAt;
    lastAt = t;

    if (e.key === 'Enter') {
      const code = normalizeScannedCode(buffer);
      const fast = burst && delta <= maxInterval * 2;
      const acceptable = eanOnly ? isValidEan(code) : code.length >= minLength;
      if (fast && buffer.length >= minLength && acceptable) {
        e.preventDefault();
        e.stopPropagation();
        reset();
        onScan(code);
        return;
      }
      if (fast && buffer.length >= minLength) {
        // Rafale de douchette refusée : les caractères ont été bloqués, on le signale.
        e.preventDefault();
        e.stopPropagation();
        reset();
        options.onReject?.(code);
        return;
      }
      reset();
      return;
    }

    if (e.key.length !== 1) {
      // Touche de contrôle (Tab, Shift…) : ignorée, ne casse pas la rafale.
      return;
    }

    if (buffer.length > 0 && delta <= maxInterval) {
      if (!burst) retractFirstChar(firstTarget, buffer);
      burst = true;
      buffer += e.key;
      if (buffer.length > maxLength) reset();
      // À partir du 2e caractère d'une rafale, on empêche l'écriture dans le champ actif.
      else e.preventDefault();
      return;
    }

    // Frappe isolée ou trop lente : nouveau tampon, non intercepté.
    buffer = e.key;
    burst = false;
    firstTarget = e.target;
  };

  target.addEventListener('keydown', handler, true);
  return () => target.removeEventListener('keydown', handler, true);
}
