import { useMemo } from 'react';
import type { TicketPayload } from '@pos/core';
import { renderTicketText } from '@/lib/ticket';
import { cn } from '@/lib/utils';

export interface ReceiptPreviewProps {
  ticket: TicketPayload;
  className?: string;
}

/** Aperçu HTML monospace du `TicketPayload` (SPEC §6) — identique au rendu texte du pont. */
export function ReceiptPreview({ ticket, className }: ReceiptPreviewProps) {
  const lines = useMemo(() => renderTicketText(ticket), [ticket]);
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
