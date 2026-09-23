import type { PosSession, TransactionFull } from '@/types/pos';

/** État partagé des mocks (persisté en localStorage pour survivre aux rechargements). */
export interface MockState {
  user: { id: string; email: string } | null;
  session: PosSession | null;
  sessionCounter: number;
  ticketCounter: number;
  transactions: TransactionFull[];
  events: Array<{ type: string; payload: unknown; at: string }>;
}

const KEY = 'pos.mock.state.v1';

function initial(): MockState {
  return {
    user: null,
    session: null,
    sessionCounter: 0,
    ticketCounter: 0,
    transactions: [],
    events: [],
  };
}

let state: MockState | null = null;

export function mockState(): MockState {
  if (state) return state;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    state = raw ? { ...initial(), ...(JSON.parse(raw) as Partial<MockState>) } : initial();
  } catch {
    state = initial();
  }
  return state;
}

export function mockSave(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(mockState()));
  } catch {
    // stockage indisponible
  }
}

export function mockReset(): void {
  state = initial();
  mockSave();
}
