import { useCallback } from 'react';
import type { TicketPayload } from '@pos/core';
import { bridge } from '@/lib/bridge';
import { logEvent } from '@/lib/events';
import { useUiStore } from '@/stores/uiStore';

export type PrintOutcome = 'printed' | 'fallback';

/** Impression via le pont ; si le pont est KO, affichage plein écran du ticket (fallback). */
export function usePrinter() {
  const showReceiptFallback = useUiStore((s) => s.showReceiptFallback);
  const toast = useUiStore((s) => s.toast);

  const print = useCallback(
    async (ticket: TicketPayload): Promise<PrintOutcome> => {
      try {
        const r = await bridge.print(ticket);
        if (r.ok) return 'printed';
        throw new Error('Impression refusée par le pont');
      } catch (e) {
        toast({
          title: 'Imprimante indisponible',
          description: e instanceof Error ? e.message : 'Ticket affiché à l’écran',
          variant: 'warning',
        });
        showReceiptFallback(ticket);
        return 'fallback';
      }
    },
    [showReceiptFallback, toast],
  );

  const openDrawer = useCallback(
    async (reason: string, log = true): Promise<boolean> => {
      try {
        const r = await bridge.openDrawer(reason);
        if (log) void logEvent('drawer_opened', { reason });
        return r.ok;
      } catch (e) {
        toast({
          title: 'Tiroir non ouvert',
          description: e instanceof Error ? e.message : 'Pont TPE injoignable',
          variant: 'warning',
        });
        return false;
      }
    },
    [toast],
  );

  return { print, openDrawer };
}
