/**
 * Génère `src/__fixtures__/hash-vectors.json` (SPEC §3).
 * Usage : `pnpm --filter @pos/core gen:vectors` (tsx). La sortie est déterministe.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCanonicalString,
  computeCart,
  computeTransactionHash,
  linesDigest,
  paymentsDigest,
  validatePayments,
} from '../src/index.ts';
import type { CanonicalTxnInput, CartLineInput, PaymentInput } from '../src/index.ts';

const REGISTER_CODE = 'CAISSE-01';
const CUSTOMER_B2B = '7c1f4c2e-9a7b-4d3e-8f21-0b5c6d7e8f90';

interface VectorSeed {
  name: string;
  description: string;
  ticket_number: number;
  client_txn_id: string;
  business_at: string;
  kind: 'sale' | 'refund';
  customer_account_id?: string | null;
  lines: CartLineInput[];
  payments: PaymentInput[];
  change_cents: number;
}

const seeds: VectorSeed[] = [
  {
    name: 'sale_single_line_20',
    description:
      'Vente 1 ligne à 20 %, 10,00 € TTC, espèces exactes, premier ticket (prev_hash vide).',
    ticket_number: 1,
    client_txn_id: '3f2504e0-4f89-4d3c-9a6b-0f1e2d3c4b5a',
    business_at: '2026-09-23T08:15:07.123Z',
    kind: 'sale',
    lines: [
      {
        line_no: 1,
        product_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        ean: '3000000000017',
        label: 'Cahier 96p',
        qty: 1,
        unit_price_ttc_cents: 1000,
        vat_rate: 20,
        discount_percent: 0,
      },
    ],
    payments: [{ method: 'cash', amount_cents: 1000 }],
    change_cents: 0,
  },
  {
    name: 'sale_multi_rate_discount',
    description: 'Vente multi-taux 20 % + 5,5 % avec remise 10 % sur la ligne à 20 %, CB.',
    ticket_number: 2,
    client_txn_id: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    business_at: '2026-09-23T09:02:44.000Z',
    kind: 'sale',
    lines: [
      {
        line_no: 1,
        product_id: null,
        ean: null,
        label: 'Crayons HB x3',
        qty: 3,
        unit_price_ttc_cents: 250,
        vat_rate: '5.5',
        discount_percent: 0,
      },
      {
        line_no: 2,
        product_id: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
        ean: '3000000000024',
        label: 'Agenda 2027',
        qty: 1,
        unit_price_ttc_cents: 2490,
        vat_rate: '20.00',
        discount_percent: 10,
      },
    ],
    payments: [{ method: 'cb', amount_cents: 2991 }],
    change_cents: 0,
  },
  {
    name: 'sale_b2b_two_payments_change',
    description: 'Vente client B2B, 2 paiements (CB + espèces avec rendu de monnaie).',
    ticket_number: 3,
    client_txn_id: 'c56a4180-65aa-42ec-a945-5fd21dec0538',
    business_at: '2026-09-23T10:30:00.500Z',
    kind: 'sale',
    customer_account_id: CUSTOMER_B2B,
    lines: [
      {
        line_no: 1,
        product_id: 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f',
        ean: '3000000000031',
        label: 'Ramette A4 80g',
        qty: 2,
        unit_price_ttc_cents: 4500,
        vat_rate: 20,
        discount_percent: 0,
      },
      {
        line_no: 2,
        product_id: 'd4e5f6a7-b8c9-4d0e-9f1a-3b4c5d6e7f80',
        ean: null,
        label: 'Bloc-notes',
        qty: 1,
        unit_price_ttc_cents: 320,
        vat_rate: 5.5,
        discount_percent: 0,
      },
    ],
    payments: [
      { method: 'cb', amount_cents: 5000 },
      { method: 'cash', amount_cents: 5000 },
    ],
    change_cents: 680,
  },
  {
    name: 'refund_single_line',
    description: 'Remboursement (kind=refund), quantité négative, espèces négatives.',
    ticket_number: 4,
    client_txn_id: '16fd2706-8baf-433b-82eb-8c7fada847da',
    business_at: '2026-09-23T11:11:11.111Z',
    kind: 'refund',
    lines: [
      {
        line_no: 1,
        product_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        ean: '3000000000017',
        label: 'Cahier 96p',
        qty: -1,
        unit_price_ttc_cents: 1000,
        vat_rate: 20,
        discount_percent: 0,
      },
    ],
    payments: [{ method: 'cash', amount_cents: -1000 }],
    change_cents: 0,
  },
  {
    name: 'sale_with_prev_hash',
    description: 'Vente chaînée : prev_hash = hash du vecteur précédent, chèque avec référence.',
    ticket_number: 5,
    client_txn_id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    business_at: '2026-09-23T12:00:00.000Z',
    kind: 'sale',
    lines: [
      {
        line_no: 1,
        product_id: null,
        ean: null,
        label: 'Stylo plume',
        qty: 1,
        unit_price_ttc_cents: 5990,
        vat_rate: 20,
        discount_percent: 0,
      },
    ],
    payments: [{ method: 'cheque', amount_cents: 5990, reference: 'CHQ-0001234' }],
    change_cents: 0,
  },
  {
    name: 'sale_decimal_qty',
    description: 'Vente quantité décimale 2.5 × 3,99 € (997,5 → 998 half-up), espèces avec rendu.',
    ticket_number: 6,
    client_txn_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    business_at: '2026-09-23T13:45:30.999Z',
    kind: 'sale',
    lines: [
      {
        line_no: 1,
        product_id: 'e5f6a7b8-c9d0-4e1f-8a2b-4c5d6e7f8091',
        ean: '3000000000048',
        label: 'Papier cadeau (m)',
        qty: 2.5,
        unit_price_ttc_cents: 399,
        vat_rate: '20',
        discount_percent: 0,
      },
    ],
    payments: [{ method: 'cash', amount_cents: 1000 }],
    change_cents: 2,
  },
];

interface Vector {
  name: string;
  description: string;
  input: CanonicalTxnInput;
  canonical_string: string;
  lines_digest: string;
  payments_digest: string;
  hash: string;
}

const vectors: Vector[] = [];
let prevHash = '';
for (const seed of seeds) {
  const cart = computeCart(seed.lines);
  const payments = validatePayments(cart.total_ttc_cents, seed.payments, seed.change_cents);
  if (!payments.ok) {
    throw new Error(`Vector ${seed.name}: ${payments.code} — ${payments.message}`);
  }
  const input: CanonicalTxnInput = {
    ticket_number: seed.ticket_number,
    register_code: REGISTER_CODE,
    client_txn_id: seed.client_txn_id,
    business_at: seed.business_at,
    kind: seed.kind,
    total_ht_cents: cart.total_ht_cents,
    total_vat_cents: cart.total_vat_cents,
    total_ttc_cents: cart.total_ttc_cents,
    vat_breakdown: cart.vat_breakdown,
    customer_account_id: seed.customer_account_id ?? null,
    lines: cart.lines.map((l) => ({
      line_no: l.line_no,
      product_id: l.product_id ?? null,
      ean: l.ean ?? null,
      label: l.label,
      qty: l.qty,
      unit_price_ttc_cents: l.unit_price_ttc_cents,
      vat_rate: l.vat_rate,
      discount_percent: l.discount_percent,
      line_ttc_cents: l.line_ttc_cents,
    })),
    payments: seed.payments.map((p) => ({
      method: p.method,
      amount_cents: p.amount_cents,
      reference: p.reference ?? null,
    })),
    prev_hash: prevHash,
  };
  const hash = computeTransactionHash(input);
  vectors.push({
    name: seed.name,
    description: seed.description,
    input,
    canonical_string: buildCanonicalString(input),
    lines_digest: linesDigest(input.lines),
    payments_digest: paymentsDigest(input.payments),
    hash,
  });
  prevHash = hash;
}

const output = {
  version: 1,
  spec: 'docs/SPEC.md §3 — hash canonique v1',
  generator: 'packages/core/scripts/gen-hash-vectors.ts',
  register_code: REGISTER_CODE,
  vectors,
};

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../src/__fixtures__/hash-vectors.json');
writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`Wrote ${vectors.length} vectors to ${target}`);
