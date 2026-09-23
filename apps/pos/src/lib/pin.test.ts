import { beforeEach, describe, expect, it } from 'vitest';
import { clearPin, hasPin, isValidPinFormat, setPin, verifyPin } from './pin';

describe('pin', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('valide le format (4 à 8 chiffres)', () => {
    expect(isValidPinFormat('1234')).toBe(true);
    expect(isValidPinFormat('12345678')).toBe(true);
    expect(isValidPinFormat('123')).toBe(false);
    expect(isValidPinFormat('12a4')).toBe(false);
  });

  it('définit puis vérifie un PIN (PBKDF2, sel aléatoire)', async () => {
    expect(hasPin()).toBe(false);
    await setPin('4321');
    expect(hasPin()).toBe(true);
    const raw = localStorage.getItem('pos.pin.v1');
    expect(raw).not.toContain('4321');
    expect(await verifyPin('4321')).toBe(true);
    expect(await verifyPin('1234')).toBe(false);
    expect(await verifyPin('')).toBe(false);
  });

  it('produit un hash différent pour le même PIN (sel)', async () => {
    await setPin('0000');
    const a = localStorage.getItem('pos.pin.v1');
    await setPin('0000');
    const b = localStorage.getItem('pos.pin.v1');
    expect(a).not.toEqual(b);
    expect(await verifyPin('0000')).toBe(true);
  });

  it('refuse un PIN mal formé et supprime le PIN', async () => {
    await expect(setPin('12')).rejects.toThrow();
    await setPin('1234');
    clearPin();
    expect(hasPin()).toBe(false);
    expect(await verifyPin('1234')).toBe(false);
  });
});
