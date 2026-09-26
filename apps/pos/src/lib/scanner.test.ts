import { describe, expect, it, vi } from 'vitest';
import { attachScanner, isValidEan, normalizeScannedCode } from './scanner';

describe('isValidEan', () => {
  it('valide les EAN-13 et EAN-8 corrects', () => {
    expect(isValidEan('3086123101227')).toBe(true);
    expect(isValidEan('9782070408504')).toBe(true);
    expect(isValidEan('4014519000105')).toBe(true);
    expect(isValidEan('96385074')).toBe(true);
  });
  it('rejette une clé fausse ou une longueur inattendue', () => {
    expect(isValidEan('3086123101228')).toBe(false);
    expect(isValidEan('96385075')).toBe(false);
    expect(isValidEan('12345')).toBe(false);
    expect(isValidEan('30861231012a7')).toBe(false);
  });
  it('normalise un UPC-A en EAN-13', () => {
    expect(normalizeScannedCode('036000291452')).toBe('0036000291452');
    expect(isValidEan(normalizeScannedCode('036000291452'))).toBe(true);
  });
});

function typeSequence(
  target: EventTarget,
  chars: string,
  clock: { t: number },
  stepMs: number,
  enter = true,
): KeyboardEvent[] {
  const events: KeyboardEvent[] = [];
  for (const ch of chars) {
    clock.t += stepMs;
    const ev = new KeyboardEvent('keydown', { key: ch, cancelable: true, bubbles: true });
    target.dispatchEvent(ev);
    events.push(ev);
  }
  if (enter) {
    clock.t += stepMs;
    const ev = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
    target.dispatchEvent(ev);
    events.push(ev);
  }
  return events;
}

describe('attachScanner', () => {
  it('détecte une rafale de douchette (< 40 ms) terminée par Enter', () => {
    const target = new EventTarget();
    const clock = { t: 1000 };
    const onScan = vi.fn();
    const detach = attachScanner(onScan, { target, now: () => clock.t });
    const events = typeSequence(target, '3086123101227', clock, 10);
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onScan).toHaveBeenCalledWith('3086123101227');
    // Enter intercepté, et les caractères à partir du 2e aussi.
    expect(events[events.length - 1]?.defaultPrevented).toBe(true);
    expect(events[0]?.defaultPrevented).toBe(false);
    expect(events[1]?.defaultPrevented).toBe(true);
    detach();
  });

  it('ignore une frappe humaine (intervalle > 40 ms)', () => {
    const target = new EventTarget();
    const clock = { t: 1000 };
    const onScan = vi.fn();
    const detach = attachScanner(onScan, { target, now: () => clock.t });
    const events = typeSequence(target, '3086123101227', clock, 120);
    expect(onScan).not.toHaveBeenCalled();
    expect(events.every((e) => !e.defaultPrevented)).toBe(true);
    detach();
  });

  it('rejette une rafale dont la clé EAN est fausse', () => {
    const target = new EventTarget();
    const clock = { t: 1000 };
    const onScan = vi.fn();
    const detach = attachScanner(onScan, { target, now: () => clock.t });
    typeSequence(target, '3086123101228', clock, 5);
    expect(onScan).not.toHaveBeenCalled();
    detach();
  });

  it('accepte un code non EAN si eanOnly=false', () => {
    const target = new EventTarget();
    const clock = { t: 1000 };
    const onScan = vi.fn();
    const detach = attachScanner(onScan, { target, now: () => clock.t, eanOnly: false });
    typeSequence(target, 'ABC-12345', clock, 5);
    expect(onScan).toHaveBeenCalledWith('ABC-12345');
    detach();
  });

  it('se détache proprement', () => {
    const target = new EventTarget();
    const clock = { t: 1000 };
    const onScan = vi.fn();
    const detach = attachScanner(onScan, { target, now: () => clock.t });
    detach();
    typeSequence(target, '3086123101227', clock, 5);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('signale une rafale refusée via onReject (sans écrire dans le champ)', () => {
    const target = new EventTarget();
    const clock = { t: 1000 };
    const onScan = vi.fn();
    const onReject = vi.fn();
    const detach = attachScanner(onScan, { target, now: () => clock.t, onReject });
    const events = typeSequence(target, '3086123101228', clock, 5);
    expect(onScan).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith('3086123101228');
    expect(events[events.length - 1]?.defaultPrevented).toBe(true);
    // Frappe humaine + Entrée : jamais signalée comme rejet.
    typeSequence(target, '12345', clock, 200);
    expect(onReject).toHaveBeenCalledTimes(1);
    detach();
  });

  it('retire du champ actif le 1er caractère d’une rafale', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.value = 'cah';
    const clock = { t: 1000 };
    const onScan = vi.fn();
    const onInput = vi.fn();
    input.addEventListener('input', onInput);
    const detach = attachScanner(onScan, { target: window, now: () => clock.t });
    const code = '3086123101227';
    for (const [i, ch] of [...code].entries()) {
      clock.t += 5;
      const ev = new KeyboardEvent('keydown', { key: ch, cancelable: true, bubbles: true });
      input.dispatchEvent(ev);
      // Le navigateur n'insère que les touches non bloquées (seule la 1re ici).
      if (!ev.defaultPrevented) {
        input.value += ch;
        input.setSelectionRange(input.value.length, input.value.length);
      }
      if (i === 0) expect(input.value).toBe('cah3');
    }
    clock.t += 5;
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true }),
    );
    expect(onScan).toHaveBeenCalledWith(code);
    expect(input.value).toBe('cah');
    expect(onInput).toHaveBeenCalledTimes(1);
    detach();
    input.remove();
  });
});
