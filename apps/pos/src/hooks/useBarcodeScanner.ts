import { useEffect, useRef } from 'react';
import { attachScanner } from '@/lib/scanner';
import type { ScannerOptions } from '@/lib/scanner';

/** Écoute la douchette HID tant que le composant est monté (`enabled`). */
export function useBarcodeScanner(
  onScan: (code: string) => void,
  enabled = true,
  options?: Omit<ScannerOptions, 'onReject'>,
  onReject?: (code: string) => void,
) {
  const cbRef = useRef(onScan);
  const rejectRef = useRef(onReject);
  cbRef.current = onScan;
  rejectRef.current = onReject;
  useEffect(() => {
    if (!enabled) return;
    return attachScanner((code) => cbRef.current(code), {
      ...options,
      onReject: (code) => rejectRef.current?.(code),
    });
    // options est volontairement non suivi (objet littéral) : passer un objet stable si besoin.
  }, [enabled]);
}
