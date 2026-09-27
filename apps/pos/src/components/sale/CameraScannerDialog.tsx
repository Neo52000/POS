import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { isValidEan, normalizeScannedCode } from '@/lib/scanner';

export interface CameraScannerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScan: (code: string) => void;
}

type Decoder = (video: HTMLVideoElement) => Promise<string | null>;

async function makeDecoder(): Promise<Decoder> {
  if (typeof BarcodeDetector !== 'undefined') {
    const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
    return async (video) => {
      const codes = await detector.detect(video);
      return codes[0]?.rawValue ?? null;
    };
  }
  // Fallback : zxing-wasm (chargé à la demande).
  const { readBarcodes } = await import('zxing-wasm/reader');
  const canvas = document.createElement('canvas');
  return async (video) => {
    if (!video.videoWidth) return null;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const results = await readBarcodes(image, {
      formats: ['EAN-13', 'EAN-8', 'UPC-A'],
      tryHarder: true,
    });
    return results.find((r) => r.isValid)?.text ?? null;
  };
}

/** Scan par caméra : `BarcodeDetector` natif si disponible, sinon `zxing-wasm`. */
export function CameraScannerDialog({ open, onOpenChange, onScan }: CameraScannerDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<string>('');
  // Callbacks par ref : un nouveau rendu du parent ne redémarre pas la caméra.
  const onScanRef = useRef(onScan);
  const onOpenChangeRef = useRef(onOpenChange);
  onScanRef.current = onScan;
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let cancelled = false;
    setError(null);

    const start = async (): Promise<void> => {
      try {
        if (!navigator.mediaDevices?.getUserMedia)
          throw new Error('Caméra non disponible sur cet appareil');
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        const video = videoRef.current;
        if (!video || cancelled) {
          // Dialogue fermé pendant l'autorisation : le nettoyage est déjà passé.
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        const decode = await makeDecoder();
        setEngine(typeof BarcodeDetector !== 'undefined' ? 'BarcodeDetector' : 'zxing-wasm');
        let busy = false;
        const loop = async (): Promise<void> => {
          if (cancelled) return;
          if (!busy && video.readyState >= 2) {
            busy = true;
            try {
              const raw = await decode(video);
              if (raw) {
                const code = normalizeScannedCode(raw);
                if (isValidEan(code)) {
                  onScanRef.current(code);
                  onOpenChangeRef.current(false);
                  return;
                }
              }
            } catch {
              // image non décodable : on continue
            } finally {
              busy = false;
            }
          }
          raf = requestAnimationFrame(() => void loop());
        };
        raf = requestAnimationFrame(() => void loop());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Impossible d’accéder à la caméra');
      }
    };
    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Scanner avec la caméra</DialogTitle>
          <DialogDescription>
            Présentez le code-barres devant la caméra. {engine && `Moteur : ${engine}`}
          </DialogDescription>
        </DialogHeader>
        <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-x-[15%] top-1/2 h-0.5 -translate-y-1/2 bg-danger/80" />
        </div>
        {error && <p className="text-danger">{error}</p>}
        <div className="flex justify-end">
          <Button variant="secondary" size="touch" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
