import type { PosArchive, PosSession, StockAdjustLineResult, TransactionFull } from '@/types/pos';

/** État partagé des mocks (persisté en localStorage pour survivre aux rechargements). */
export interface MockState {
  user: { id: string; email: string } | null;
  session: PosSession | null;
  sessionCounter: number;
  ticketCounter: number;
  transactions: TransactionFull[];
  events: Array<{ type: string; payload: unknown; at: string; client_at?: string | null }>;
  /** Archives NF525 simulées (lot 5). */
  archives: PosArchive[];
  /** Stock boutique modifié par l'inventaire (product_id → stock). */
  stock: Record<string, number>;
  /** Résultats par clé d'idempotence de `pos-stock-adjust`. */
  stockKeys: Record<string, StockAdjustLineResult>;
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
    archives: [],
    stock: {},
    stockKeys: {},
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
