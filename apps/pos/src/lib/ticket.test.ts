import { describe, expect, it } from 'vitest';
import { computeCart } from '@pos/core';
import type { CheckoutPayload, TicketPayload } from '@pos/core';
import { buildProvisionalTicket, renderTicketText, ticketCode } from './ticket';

const ticket: TicketPayload = {
  version: 1,
  register_code: 'TEST-01',
  ticket_number: 12,
  ticket_code: 'T-2026-000012',
  duplicate: true,
  kind: 'sale',
  business_at: '2026-09-23T10:00:00.000Z',
  cashier_name: 'Élie',
  header: {
    company_name: 'Reine & Fils SAS',
    address_lines: ['10 rue Toupot de Béveaux', '52000 Chaumont'],
    siret: '123',
    vat_number: 'FR1',
  },
  lines: [
    {
      label: 'Stylo bille BIC Cristal bleu',
      qty: 2,
      unit_price_ttc_cents: 120,
      discount_percent: 10,
      line_ttc_cents: 216,
      vat_rate: '20.00',
    },
    {
      label: 'Cahier',
      qty: 1,
      unit_price_ttc_cents: 200,
      discount_percent: 0,
      line_ttc_cents: 200,
      vat_rate: '20.00',
      public_price_ttc_cents: 245,
    },
  ],
  vat_breakdown: [{ rate: '20.00', base_ht_cents: 347, vat_cents: 69, ttc_cents: 416 }],
  total_ht_cents: 347,
  total_vat_cents: 69,
  total_ttc_cents: 416,
  payments: [{ method: 'cash', label: 'Espèces', amount_cents: 500 }],
  change_cents: 84,
  footer: { lines: ['Merci !'] },
  compliance: {
    hash_short: 'abcd1234',
    signature_status: 'signed',
    software: 'Ma Papeterie POS',
    version: '0.1.0',
  },
  invoice_requested: false,
};

describe('ticket', () => {
  it('construit le code ticket', () => {
    expect(ticketCode('2026-09-23T10:00:00.000Z', 12)).toBe('T-2026-000012');
  });

  it('rend un ticket monospace de 42 colonnes', () => {
    const lines = renderTicketText(ticket);
    expect(lines.every((l) => l.length <= 42)).toBe(true);
    const text = lines.join('\n');
    expect(text).toContain('*** DUPLICATA ***');
    expect(text).toContain('Ticket T-2026-000012');
    expect(text).toContain('-10 %');
    expect(text).toContain('Prix public 2,45 € (tarif pro)');
    expect(text).toContain('TOTAL TTC');
    expect(text).toContain('Rendu');
    expect(text).toContain('#abcd1234');
  });
});

describe('ticket provisoire (hors ligne)', () => {
  const lines: CheckoutPayload['lines'] = [
    {
      line_no: 2,
      label: 'Livre « Le Petit Prince »',
      qty: 1,
      unit_price_ttc_cents: 790,
      vat_rate: 5.5,
      discount_percent: 0,
    },
    {
      line_no: 1,
      label: 'Stylo bille BIC Cristal bleu',
      qty: 3,
      unit_price_ttc_cents: 120,
      vat_rate: 20,
      discount_percent: 12.5,
      public_price_ttc_cents: 120,
    },
    {
      line_no: 3,
      label: 'Impression / photocopie',
      qty: 7,
      unit_price_ttc_cents: 20,
      vat_rate: '20.00',
      discount_percent: 0,
      price_tier_title: 'A4 noir & blanc',
    },
  ];
  const totals = computeCart(lines);
  const payload: CheckoutPayload = {
    client_txn_id: '00000000-0000-4000-8000-000000000001',
    register_id: '11111111-1111-4111-8111-111111111111',
    session_id: '55555555-5555-4555-8555-000000000001',
    kind: 'sale',
    business_at: '2026-09-24T09:15:00.000Z',
    offline_queued: true,
    provisional_ref: 'OFF-TEST-01-20260924-001',
    invoice_requested: true,
    lines,
    payments: [
      { method: 'cash', amount_cents: 2000 },
      { method: 'cheque', amount_cents: 0, reference: 'CHQ 1' },
    ],
    change_cents: 2000 - totals.total_ttc_cents,
    totals: {
      total_ht_cents: totals.total_ht_cents,
      total_vat_cents: totals.total_vat_cents,
      total_ttc_cents: totals.total_ttc_cents,
    },
    app_version: 'test',
  };

  it('a les mêmes totaux que computeCart et est marqué provisoire', () => {
    const t = buildProvisionalTicket(payload, {
      register_code: 'TEST-01',
      cashier_name: 'vendeur',
      settings: { legal: { company_name: 'Reine & Fils SAS', address_lines: ['Chaumont'] } },
      customer: { display_name: 'Mairie de Chaumont', siret: '215 201 218 00018' },
      quote_number: 'DV-2026-0042',
    });
    expect(t.total_ttc_cents).toBe(totals.total_ttc_cents);
    expect(t.total_ht_cents).toBe(totals.total_ht_cents);
    expect(t.total_vat_cents).toBe(totals.total_vat_cents);
    expect(t.vat_breakdown).toEqual(totals.vat_breakdown);
    expect(t.lines.map((l) => l.line_ttc_cents)).toEqual(
      [...totals.lines].sort((a, b) => a.line_no - b.line_no).map((l) => l.line_ttc_cents),
    );
    expect(t.lines[0]?.label).toBe('Stylo bille BIC Cristal bleu');
    expect(t.lines[2]?.price_tier_title).toBe('A4 noir & blanc');
    expect(t).toMatchObject({
      ticket_number: null,
      ticket_code: 'OFF-TEST-01-20260924-001',
      business_at: '2026-09-24T09:15:00.000Z',
      register_code: 'TEST-01',
      change_cents: payload.change_cents,
      quote_number: 'DV-2026-0042',
      invoice_requested: true,
      customer: { display_name: 'Mairie de Chaumont' },
      compliance: { provisional: true, signature_status: 'pending_signature' },
    });
    expect(t.payments.map((p) => p.label)).toEqual(['Espèces', 'Chèque']);

    const text = renderTicketText(t);
    expect(text.every((l) => l.length <= 42)).toBe(true);
    const joined = text.join('\n');
    expect(joined).toContain('*** TICKET PROVISOIRE ***');
    expect(joined).toContain('Ticket OFF-TEST-01-20260924-001');
    expect(joined).toContain('signature en attente');
  });
});
