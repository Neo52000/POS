import { useMemo } from 'react';
import type { TicketPayload } from '@pos/core';
import { renderTicketText } from '@/lib/ticket';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';

export interface ReceiptPreviewProps {
  ticket: TicketPayload;
  className?: string;
}

/** Aperçu HTML monospace du `TicketPayload` (SPEC §6) — identique au rendu texte du pont. */
export function ReceiptPreview({ ticket, className }: ReceiptPreviewProps) {
  // Largeur réelle de l'imprimante (Star mPOP 58 mm : 32 colonnes), 42 par défaut.
  const printerWidth = useUiStore((s) => s.printerWidth);
  const width = Math.min(64, Math.max(24, printerWidth ?? 42));
  const lines = useMemo(() => renderTicketText(ticket, width), [ticket, width]);
  return (
    <pre
      data-testid="receipt-preview"
      className={cn(
        'selectable overflow-x-auto rounded-xl border border-border bg-white px-4 py-5 font-mono text-[13px] leading-snug text-black shadow-inner',
        className,
      )}
    >
      {lines.join('\n')}
    </pre>
  );
}
