/** Schémas zod des corps de requête (SPEC §6, §8). */
import { z } from 'zod';
import type { TicketPayload } from '@pos/core';

export const PaymentBodySchema = z
  .object({
    txn_id: z.string().min(1).max(128),
    amount_cents: z.number().int().min(0).max(99_999_999),
    kind: z.enum(['debit', 'credit']),
  })
  .strict();
export type PaymentBody = z.infer<typeof PaymentBodySchema>;

export const PaymentCancelBodySchema = z.object({ txn_id: z.string().min(1).max(128) }).strict();

export const PrintRawBodySchema = z
  .object({
    base64: z
      .string()
      .min(1)
      .max(4 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'base64 invalide'),
  })
  .strict();

export const DrawerOpenBodySchema = z.object({ reason: z.string().min(1).max(200) }).strict();

const cents = z.number().int();
const nonEmpty = z.string().min(1);

export const TicketPayloadSchema = z.object({
  version: z.literal(1),
  register_code: nonEmpty,
  ticket_number: z.number().int().nullable(),
  ticket_code: nonEmpty,
  duplicate: z.boolean(),
  kind: z.enum(['sale', 'refund']),
  refund_of_ticket_code: z.string().optional(),
  business_at: nonEmpty,
  cashier_name: z.string(),
  header: z.object({
    company_name: nonEmpty,
    address_lines: z.array(z.string()),
    siret: z.string(),
    vat_number: z.string(),
    phone: z.string().optional(),
  }),
  customer: z
    .object({
      display_name: nonEmpty,
      company_name: z.string().optional(),
      siret: z.string().optional(),
      vat_number: z.string().optional(),
    })
    .optional(),
  lines: z
    .array(
      z.object({
        label: z.string(),
        qty: z.number(),
        unit_price_ttc_cents: cents,
        discount_percent: z.number().min(0).max(100),
        line_ttc_cents: cents,
        vat_rate: z.string().regex(/^\d+\.\d{2}$/),
        price_tier_title: z.string().optional(),
        public_price_ttc_cents: cents.optional(),
      }),
    )
    .min(1),
  vat_breakdown: z.array(
    z.object({ rate: z.string(), base_ht_cents: cents, vat_cents: cents, ttc_cents: cents }),
  ),
  total_ht_cents: cents,
  total_vat_cents: cents,
  total_ttc_cents: cents,
  payments: z
    .array(
      z.object({
        method: z.enum(['cb', 'cash', 'cheque', 'gift_ucia', 'transfer']),
        label: z.string(),
        amount_cents: cents,
        reference: z.string().optional(),
      }),
    )
    .min(1),
  change_cents: cents.min(0),
  footer: z.object({ lines: z.array(z.string()) }),
  compliance: z.object({
    hash_short: z.string().regex(/^[0-9a-f]{8}$/i),
    signature_status: z.enum(['signed', 'pending_signature', 'failed', 'mock']),
    fiskaly_signature_short: z.string().optional(),
    software: z.literal('Ma Papeterie POS'),
    version: z.string(),
    provisional: z.boolean().optional(),
  }),
  quote_number: z.string().optional(),
  invoice_requested: z.boolean(),
});

/** Garantit l'alignement du schéma sur le type `TicketPayload` de `@pos/core`. */
export const parseTicketPayload = (input: unknown): TicketPayload =>
  TicketPayloadSchema.parse(input) satisfies TicketPayload;
