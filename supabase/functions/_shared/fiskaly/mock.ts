import type {
  FiskalyClient,
  FiskalyClosingRef,
  FiskalyRegister,
  FiskalySignature,
  TransactionForSigning,
} from './types.ts';

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Implémentation déterministe hors ligne : signature = SHA-256("mock|hash|ticket_number").
 * Permet de développer et tester toute la chaîne sans compte Fiskaly.
 * FISKALY_MOCK_FAIL=1 force un échec (test du circuit pending_signature / cron).
 */
export class MockFiskalyClient implements FiskalyClient {
  readonly mode = 'mock' as const;

  auth(): Promise<void> {
    return Promise.resolve();
  }

  commissionSystem(register: FiskalyRegister): Promise<string> {
    return Promise.resolve(register.fiskaly_system_id ?? `mock-system-${register.code}`);
  }

  async createTransactionRecord(
    systemId: string,
    tx: TransactionForSigning,
  ): Promise<FiskalySignature> {
    if (Deno.env.get('FISKALY_MOCK_FAIL') === '1') {
      throw new Error('FISKALY_MOCK_FAIL=1 : échec simulé');
    }
    const signature = await sha256Hex(`mock|${systemId}|${tx.hash}|${tx.ticket_number}`);
    return {
      record_id: `mock-${tx.id}`,
      signature,
      signed_at: new Date().toISOString(),
      raw: { mock: true, system_id: systemId, ticket_code: tx.ticket_code },
    };
  }

  getRecord(_systemId: string, recordId: string): Promise<unknown> {
    return Promise.resolve({ mock: true, record_id: recordId });
  }

  listClosings(_systemId: string, _from: string, _to: string): Promise<FiskalyClosingRef[]> {
    return Promise.resolve([]);
  }
}
