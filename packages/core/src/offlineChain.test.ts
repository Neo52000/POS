import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  OFFLINE_CHAIN_FORMAT,
  chainOfflinePayload,
  offlineChainHash,
  verifyOfflineChain,
} from './offlineChain.js';
import type { CheckoutPayload } from './types.js';

function sale(n: number): CheckoutPayload {
  return {
    client_txn_id: `3f2504e0-4f89-4d3c-9a6b-0f1e2d3c4b5${n}`,
    register_id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    session_id: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
    kind: 'sale',
    business_at: `2026-10-31T10:0${n}:00.000Z`,
    offline_queued: true,
    provisional_ref: `OFF-CHAUMONT-01-20261031-00${n}`,
    invoice_requested: false,
    lines: [
      {
        line_no: 1,
        label: 'Cahier',
        qty: 1,
        unit_price_ttc_cents: 100 * n,
        vat_rate: '20.00',
        discount_percent: 0,
        eco_tax_cents: 0,
      },
    ],
    payments: [{ method: 'cash', amount_cents: 100 * n }],
    change_cents: 0,
    totals: { total_ht_cents: 0, total_vat_cents: 0, total_ttc_cents: 100 * n },
    app_version: '0.4.0',
  };
}

async function chain(payloads: CheckoutPayload[]): Promise<CheckoutPayload[]> {
  const out: CheckoutPayload[] = [];
  let head = '';
  for (const p of payloads) {
    const c = await chainOfflinePayload(head, p);
    out.push(c);
    head = c.offline_chain_hash ?? '';
  }
  return out;
}

describe('chaînage local de la file hors ligne', () => {
  it('formule : SHA-256("offline-chain/v1|prev|JSON canonique sans champs de chaînage")', async () => {
    const p = sale(1);
    // JSON canonique écrit à la main (clés triées, sans espaces) : contrôle indépendant.
    const json =
      '{"app_version":"0.4.0","business_at":"2026-10-31T10:01:00.000Z","change_cents":0,' +
      '"client_txn_id":"3f2504e0-4f89-4d3c-9a6b-0f1e2d3c4b51","invoice_requested":false,' +
      '"kind":"sale","lines":[{"discount_percent":0,"eco_tax_cents":0,"label":"Cahier",' +
      '"line_no":1,"qty":1,"unit_price_ttc_cents":100,"vat_rate":"20.00"}],' +
      '"offline_queued":true,"payments":[{"amount_cents":100,"method":"cash"}],' +
      '"provisional_ref":"OFF-CHAUMONT-01-20261031-001",' +
      '"register_id":"9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",' +
      '"session_id":"c56a4180-65aa-42ec-a945-5fd21dec0538",' +
      '"totals":{"total_ht_cents":0,"total_ttc_cents":100,"total_vat_cents":0}}';
    const expected = createHash('sha256')
      .update(`${OFFLINE_CHAIN_FORMAT}||${json}`, 'utf8')
      .digest('hex');
    expect(await offlineChainHash('', p)).toBe(expected);
    // Les champs de chaînage déjà présents ne participent pas à l'empreinte.
    expect(
      await offlineChainHash('', { ...p, offline_chain_prev: 'x', offline_chain_hash: 'y' }),
    ).toBe(expected);
  });

  it('chaque élément porte le SHA-256 du précédent ; la file se vérifie', async () => {
    const items = await chain([sale(1), sale(2), sale(3)]);
    expect(items[0]?.offline_chain_prev).toBe('');
    expect(items[1]?.offline_chain_prev).toBe(items[0]?.offline_chain_hash);
    expect(items[2]?.offline_chain_prev).toBe(items[1]?.offline_chain_hash);
    expect(await verifyOfflineChain(items)).toEqual({
      ok: true,
      checked: 3,
      head: items[2]?.offline_chain_hash,
    });
  });

  it('suppression au milieu : rupture PREV_MISMATCH', async () => {
    const items = await chain([sale(1), sale(2), sale(3)]);
    expect(await verifyOfflineChain([items[0]!, items[2]!])).toEqual({
      ok: false,
      index: 1,
      reason: 'PREV_MISMATCH',
    });
  });

  it('modification d’un élément : rupture HASH_MISMATCH', async () => {
    const items = await chain([sale(1), sale(2)]);
    const tampered = { ...items[1]!, totals: { ...items[1]!.totals, total_ttc_cents: 1 } };
    expect(await verifyOfflineChain([items[0]!, tampered])).toEqual({
      ok: false,
      index: 1,
      reason: 'HASH_MISMATCH',
    });
  });

  it('élément non chaîné : NOT_CHAINED', async () => {
    expect(await verifyOfflineChain([sale(1)])).toEqual({
      ok: false,
      index: 0,
      reason: 'NOT_CHAINED',
    });
  });
});
