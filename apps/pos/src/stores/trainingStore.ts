import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { TicketPayload } from '@pos/core';
import type { ParkedCart } from '@/stores/parkedStore';

/** Session fictive des ventes de formation (aucune session de caisse n'est requise). */
export const TRAINING_SESSION_ID = '00000000-0000-4000-8000-000000000000';

/**
 * Mode formation (SPEC §13.3) : prise en main de la caisse sans aucun enregistrement fiscal.
 * Les ventes ne quittent jamais le poste (ni serveur, ni JET, ni stock, ni TPE réel) ; les tickets
 * sont conservés localement pour la lecture X de formation, puis effacés à la sortie du mode.
 */
interface TrainingState {
  active: boolean;
  startedAt: string | null;
  startedBy: string | null;
  /** Dernier numéro attribué (`FORM-0001`…), remis à zéro à chaque entrée. */
  seq: number;
  tickets: TicketPayload[];
  /** Tickets en attente réels mis de côté pendant la formation, restaurés à la sortie. */
  stashedParked: ParkedCart[];
  begin: (by: string | null, stashedParked: ParkedCart[]) => void;
  end: () => ParkedCart[];
  nextCode: () => string;
  addTicket: (ticket: TicketPayload) => void;
}

export const useTrainingStore = create<TrainingState>()(
  persist(
    (set, get) => ({
      active: false,
      startedAt: null,
      startedBy: null,
      seq: 0,
      tickets: [],
      stashedParked: [],
      begin: (by, stashedParked) =>
        set({
          active: true,
          startedAt: new Date().toISOString(),
          startedBy: by,
          seq: 0,
          tickets: [],
          stashedParked,
        }),
      end: () => {
        const stashed = get().stashedParked;
        set({
          active: false,
          startedAt: null,
          startedBy: null,
          seq: 0,
          tickets: [],
          stashedParked: [],
        });
        return stashed;
      },
      nextCode: () => {
        const seq = get().seq + 1;
        set({ seq });
        return `FORM-${String(seq).padStart(4, '0')}`;
      },
      addTicket: (ticket) => set((s) => ({ tickets: [...s.tickets, ticket] })),
    }),
    { name: 'pos.training.v1' },
  ),
);

/** Lecture synchrone hors composant (encaissement, TPE, journal). */
export function isTrainingActive(): boolean {
  return useTrainingStore.getState().active;
}
