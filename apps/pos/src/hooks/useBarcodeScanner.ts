import { useEffect, useRef } from 'react';
import { attachScanner } from '@/lib/scanner';
import type { ScannerOptions } from '@/lib/scanner';

/** Écoute la douchette HID tant que le composant est monté (`enabled`). */
export function useBarcodeScanner(
  onScan: (code: string) => void,
  enabled = true,
  options?: ScannerOptions,
) {
  const cbRef = useRef(onScan);
  cbRef.current = onScan;
  useEffect(() => {
    if (!enabled) return;
    return attachScanner((code) => cbRef.current(code), options);
    // options est volontairement non suivi (objet littéral) : passer un objet stable si besoin.
  }, [enabled]);
}
