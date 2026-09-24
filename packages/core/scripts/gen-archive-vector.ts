/**
 * Génère `src/__fixtures__/archive-vector.json` : entrée `pos_archive_data` réaliste (chaîne de
 * tickets valide, JET et clôtures chaînés) + sorties attendues de `buildArchiveFiles`.
 * Usage : `pnpm --filter @pos/core gen:archive-vector` (tsx). Sortie déterministe.
 * Le vecteur verrouille le format `pos-archive/v1` : ne le régénérer que pour une v2.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildArchiveFiles, computeCart, computeTransactionHash, sha256Hex } from '../src/index.ts';
import type { ArchiveData, ArchiveRecord, CartLineInput } from '../src/index.ts';

const REGISTER = {
  id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  code: 'CHAUMONT-01',
  label: 'Caisse comptoir Chaumont',
};
const SESSION_ID = 'c56a4180-65aa-42ec-a945-5fd21dec0538';

interface Seed {
  ticket_number: number;
  client_txn_id: string;
  business_at: string;
  kind: 'sale' | 'refund';
  lines: CartLineInput[];
  payments: Array<{ method: string; amount_cents: number; reference?: string | null }>;
}

const seeds: Seed[] = [
  {
    ticket_number: 41,
    client_txn_id: '3f2504e0-4f89-4d3c-9a6b-0f1e2d3c4b5a',
    business_at: '2026-08-01T07:30:00.000Z',
    kind: 'sale',
    lines: [
      {
        line_no: 1,
        product_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        ean: '3000000000017',
        label: 'Cahier 96p',
        qty: 2,
        unit_price_ttc_cents: 350,
        vat_rate: 20,
      },
      {
        line_no: 2,
        label: 'Livre « Été »',
        qty: 1,
        unit_price_ttc_cents: 1290,
        vat_rate: 5.5,
        discount_percent: 10,
      },
    ],
    payments: [{ method: 'cash', amount_cents: 2000 }],
  },
  {
    ticket_number: 42,
    client_txn_id: '16fd2706-8baf-433b-82eb-8c7fada847da',
    business_at: '2026-08-14T15:05:07.123Z',
    kind: 'sale',
    lines: [{ line_no: 1, label: 'Stylo plume', qty: 1, unit_price_ttc_cents: 2490, vat_rate: 20 }],
    payments: [
      { method: 'cb', amount_cents: 1490 },
      { method: 'gift_ucia', amount_cents: 1000, reference: 'UCIA-0042' },
    ],
  },
  {
    ticket_number: 43,
    client_txn_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    business_at: '2026-08-31T21:59:57.250Z',
    kind: 'refund',
    lines: [
      { line_no: 1, label: 'Stylo plume', qty: -1, unit_price_ttc_cents: 2490, vat_rate: 20 },
    ],
    payments: [{ method: 'cb', amount_cents: -2490 }],
  },
];

const PREV_TICKET_HASH = sha256Hex('ticket 40');
let prevHash = PREV_TICKET_HASH;
const transactions: ArchiveRecord[] = seeds.map((s, i) => {
  const cart = computeCart(s.lines);
  const lines = cart.lines.map((l) => ({
    line_no: l.line_no,
    product_id: l.product_id ?? null,
    ean: l.ean ?? null,
    sku: null,
    label: l.label,
    qty: l.qty,
    unit_price_ttc_cents: l.unit_price_ttc_cents,
    unit_price_ht_cents: l.unit_price_ht_cents,
    vat_rate: Number(l.vat_rate),
    discount_percent: l.discount_percent,
    discount_reason: null,
    line_ttc_cents: l.line_ttc_cents,
    line_ht_cents: l.line_ht_cents,
    line_vat_cents: l.line_vat_cents,
    eco_tax_cents: 0,
  }));
  const hash = computeTransactionHash({
    ticket_number: s.ticket_number,
    register_code: REGISTER.code,
    client_txn_id: s.client_txn_id,
    business_at: s.business_at,
    kind: s.kind,
    total_ht_cents: cart.total_ht_cents,
    total_vat_cents: cart.total_vat_cents,
    total_ttc_cents: cart.total_ttc_cents,
    vat_breakdown: cart.vat_breakdown,
    customer_account_id: null,
    lines,
    payments: s.payments,
    prev_hash: prevHash,
  });
  const row: ArchiveRecord = {
    id: `00000000-0000-4000-8000-0000000000${40 + i}`,
    client_txn_id: s.client_txn_id,
    register_id: REGISTER.id,
    session_id: SESSION_ID,
    ticket_number: s.ticket_number,
    kind: s.kind,
    business_at: s.business_at.replace('Z', '+00:00'),
    received_at: new Date(Date.parse(s.business_at) + 1500).toISOString().replace('Z', '+00:00'),
    total_ht_cents: cart.total_ht_cents,
    total_vat_cents: cart.total_vat_cents,
    total_ttc_cents: cart.total_ttc_cents,
    vat_breakdown: cart.vat_breakdown,
    customer_account_id: null,
    prev_hash: prevHash,
    hash,
    signature_status: 'signed',
    lines,
    payments: s.payments.map((p) => ({
      ...p,
      reference: p.reference ?? null,
      manual_fallback: false,
    })),
  };
  prevHash = hash;
  return row;
});

function chained(prefix: string, items: ArchiveRecord[], first: string): ArchiveRecord[] {
  let prev = first;
  return items.map((it) => {
    const hash = sha256Hex(`${prefix}|${JSON.stringify(it)}|${prev}`);
    const row = { ...it, prev_hash: prev, hash };
    prev = hash;
    return row;
  });
}

const events = chained(
  'event',
  [
    {
      id: 1001,
      register_id: REGISTER.id,
      event_type: 'session_open',
      payload: { opening_float_cents: 15000 },
      created_at: '2026-08-01T07:00:00.000+00:00',
      event_number: 500,
    },
    {
      id: 1002,
      register_id: REGISTER.id,
      event_type: 'drawer_opened',
      payload: { reason: 'Rendu' },
      created_at: '2026-08-14T15:06:00.000+00:00',
      event_number: 501,
    },
    {
      id: 1003,
      register_id: REGISTER.id,
      event_type: 'offline_reattached',
      payload: { provisional_ref: 'OFF-CHAUMONT-01-20260831-001' },
      created_at: '2026-08-31T21:00:00.000+00:00',
      event_number: 502,
    },
  ],
  sha256Hex('event 1000'),
);
const closings = chained(
  'closing',
  [
    {
      closing_number: 90,
      register_id: REGISTER.id,
      period_type: 'daily',
      period_start: '2026-07-31T22:00:00+00:00',
      period_end: '2026-08-01T22:00:00+00:00',
      total_ttc_cents: 2511,
      grand_total_perpetual_cents: 1234567,
      created_at: '2026-08-01T17:00:00+00:00',
    },
    {
      closing_number: 91,
      register_id: REGISTER.id,
      period_type: 'daily',
      period_start: '2026-08-13T22:00:00+00:00',
      period_end: '2026-08-14T22:00:00+00:00',
      total_ttc_cents: 2490,
      grand_total_perpetual_cents: 1237057,
      created_at: '2026-08-14T17:00:00+00:00',
    },
  ],
  sha256Hex('closing 89'),
);

const lastEvent = events[events.length - 1] as ArchiveRecord;
const lastClosing = closings[closings.length - 1] as ArchiveRecord;
const data: ArchiveData = {
  register: REGISTER,
  period_start: '2026-07-31T22:00:00+00:00',
  period_end: '2026-08-31T22:00:00+00:00',
  transactions,
  events,
  closings,
  chain_heads: {
    anchor_ticket_number: 40,
    anchor_ticket_hash: PREV_TICKET_HASH,
    last_ticket_number: 43,
    last_ticket_hash: prevHash,
    last_event_id: lastEvent['id'] as number,
    last_event_hash: lastEvent['hash'] as string,
    last_closing_number: lastClosing['closing_number'] as number,
    last_closing_hash: lastClosing['hash'] as string,
  },
  previous_archive: {
    id: '7c1f4c2e-9a7b-4d3e-8f21-0b5c6d7e8f90',
    period_start: '2026-06-30T22:00:00+00:00',
    hash: sha256Hex('archive 2026-07'),
    manifest_sha256: sha256Hex('manifest 2026-07'),
    last_ticket_number: 40,
    last_event_id: 1000,
    last_closing_number: 89,
  },
  software: { name: 'Ma Papeterie POS', version: '0.1.0' },
};

const GENERATED_AT = '2026-09-01T04:00:00.000Z';
const built = await buildArchiveFiles(data, { generatedAt: GENERATED_AT });
const expected = {
  manifest_sha256: built.manifestSha256,
  files: Object.fromEntries(built.manifest.files.map((f) => [f.name, f.sha256])),
};

const out = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/__fixtures__/archive-vector.json',
);
writeFileSync(out, `${JSON.stringify({ generated_at: GENERATED_AT, data, expected }, null, 2)}\n`);
console.log(`archive-vector.json : manifest_sha256 ${built.manifestSha256}`);
