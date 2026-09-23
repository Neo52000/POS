import { describe, expect, it } from 'vitest';
import type { TicketPayload } from '@pos/core';
import { renderTicketText, ticketCode } from './ticket';

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
