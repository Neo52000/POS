import { describe, expect, it, vi } from 'vitest';
import {
  applyEdit,
  isVkTarget,
  preferredLayout,
  pressKey,
  restoreNativeKeyboard,
  suppressNativeKeyboard,
} from './virtualKeyboard';

describe('applyEdit', () => {
  it('insère au curseur et remplace la sélection', () => {
    expect(applyEdit({ value: 'abc', start: 1, end: 1 }, { type: 'insert', text: 'X' })).toEqual({
      value: 'aXbc',
      caret: 2,
    });
    expect(applyEdit({ value: 'abcd', start: 1, end: 3 }, { type: 'insert', text: 'é' })).toEqual({
      value: 'aéd',
      caret: 2,
    });
  });

  it('respecte maxLength', () => {
    expect(
      applyEdit({ value: '123', start: 3, end: 3 }, { type: 'insert', text: '45' }, 4),
    ).toEqual({ value: '1234', caret: 4 });
  });

  it('retour arrière, effacement, bornes', () => {
    expect(applyEdit({ value: 'abc', start: 3, end: 3 }, { type: 'backspace' })).toEqual({
      value: 'ab',
      caret: 2,
    });
    expect(applyEdit({ value: 'abc', start: 0, end: 0 }, { type: 'backspace' })).toEqual({
      value: 'abc',
      caret: 0,
    });
    expect(applyEdit({ value: 'abc', start: 0, end: 2 }, { type: 'backspace' })).toEqual({
      value: 'c',
      caret: 0,
    });
    expect(applyEdit({ value: 'abc', start: 9, end: 9 }, { type: 'clear' })).toEqual({
      value: '',
      caret: 0,
    });
  });
});

describe('champ ciblé', () => {
  it('écrit via un vrai événement input et place le curseur', () => {
    const input = document.createElement('input');
    document.body.append(input);
    const onInput = vi.fn();
    input.addEventListener('input', onInput);
    input.value = 'ca';
    input.setSelectionRange(2, 2);
    pressKey(input, { type: 'insert', text: 'fé' });
    expect(input.value).toBe('café');
    expect(input.selectionStart).toBe(4);
    pressKey(input, { type: 'backspace' });
    expect(input.value).toBe('caf');
    expect(onInput).toHaveBeenCalledTimes(2);
    input.remove();
  });

  it('Entrée : keydown puis soumission implicite du formulaire', () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    form.append(input);
    document.body.append(form);
    const onKey = vi.fn();
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    input.addEventListener('keydown', (e) => onKey(e.key));
    form.addEventListener('submit', onSubmit);
    pressKey(input, { type: 'enter' });
    expect(onKey).toHaveBeenCalledWith('Enter');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // keydown annulé (champ qui gère lui-même Entrée) : pas de soumission.
    input.addEventListener('keydown', (e) => e.preventDefault());
    pressKey(input, { type: 'enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    form.remove();
  });

  it('éligibilité, opt-out data-no-vk et disposition', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <input id="t" />
      <input id="d" inputmode="decimal" />
      <input id="c" type="checkbox" />
      <input id="ro" readonly />
      <div data-no-vk><input id="n" /></div>`;
    document.body.append(wrap);
    const q = (id: string) => wrap.querySelector<HTMLInputElement>(`#${id}`);
    expect(isVkTarget(q('t'))).toBe(true);
    expect(isVkTarget(q('c'))).toBe(false);
    expect(isVkTarget(q('ro'))).toBe(false);
    expect(isVkTarget(q('n'))).toBe(false);
    const d = q('d')!;
    suppressNativeKeyboard(d);
    expect(d.getAttribute('inputmode')).toBe('none');
    expect(preferredLayout(d)).toBe('numeric');
    expect(preferredLayout(q('t')!)).toBe('alpha');
    restoreNativeKeyboard(d);
    expect(d.getAttribute('inputmode')).toBe('decimal');
    wrap.remove();
  });
});
