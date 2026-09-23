import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { webcrypto } from 'node:crypto';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom n'expose pas `crypto.subtle` : on utilise WebCrypto de Node.
if (!globalThis.crypto || !('subtle' in globalThis.crypto) || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

// Radix (Dialog/Sheet) utilise ces API absentes de jsdom.
if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
  if (!('ResizeObserver' in window)) {
    class RO {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(window, 'ResizeObserver', { value: RO, configurable: true });
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => undefined;
  }
}

afterEach(() => {
  cleanup();
});
