import { create } from 'zustand';
import type { TicketPayload } from '@pos/core';

export type BridgeStatus = 'unknown' | 'ok' | 'ko';
export type ToastVariant = 'default' | 'success' | 'warning' | 'danger';

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  durationMs: number;
}

export interface ToastInput {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
}

interface UiState {
  online: boolean;
  bridgeStatus: BridgeStatus;
  bridgeVersion: string | null;
  tpeReachable: boolean | null;
  printerReachable: boolean | null;
  bridgeSimulate: boolean;
  toasts: ToastItem[];
  /** Ticket affiché plein écran quand l'impression via le pont échoue. */
  receiptFallback: TicketPayload | null;
  setOnline: (online: boolean) => void;
  setBridgeHealth: (
    h: {
      ok: boolean;
      version?: string;
      tpe?: boolean;
      printer?: boolean;
      simulate?: boolean;
    } | null,
  ) => void;
  toast: (t: ToastInput) => number;
  dismissToast: (id: number) => void;
  showReceiptFallback: (ticket: TicketPayload | null) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiState>()((set) => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  bridgeStatus: 'unknown',
  bridgeVersion: null,
  tpeReachable: null,
  printerReachable: null,
  bridgeSimulate: false,
  toasts: [],
  receiptFallback: null,
  setOnline: (online) => set({ online }),
  setBridgeHealth: (h) =>
    set(
      h
        ? {
            bridgeStatus: h.ok ? 'ok' : 'ko',
            bridgeVersion: h.version ?? null,
            tpeReachable: h.tpe ?? null,
            printerReachable: h.printer ?? null,
            bridgeSimulate: h.simulate === true,
          }
        : { bridgeStatus: 'ko', tpeReachable: false, printerReachable: false },
    ),
  toast: (t) => {
    const id = ++toastSeq;
    set((s) => ({
      toasts: [
        ...s.toasts.slice(-4),
        {
          id,
          title: t.title,
          description: t.description,
          variant: t.variant ?? 'default',
          durationMs: t.durationMs ?? 4000,
        },
      ],
    }));
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  showReceiptFallback: (ticket) => set({ receiptFallback: ticket }),
}));

/** Raccourci hors composant. */
export const toast = (t: ToastInput): number => useUiStore.getState().toast(t);
