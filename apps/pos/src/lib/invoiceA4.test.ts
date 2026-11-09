import { describe, expect, it } from 'vitest';
import type { TicketPayload } from '@pos/core';
import { buildInvoiceHtml, invoicePartyFor } from './invoiceA4';

const ticket = {
  version: 1,
  register_code: 'C1',
  ticket_number: 42,
  ticket_code: 'T-2026-000042',
  duplicate: false,
  kind: 'sale',
  business_at: '2026-11-09T10:00:00Z',
  cashier_name: 'Élie',
  header: {
    company_name: 'Ma Papeterie',
    address_lines: ['10 rue Toupot de Béveaux', '52000 Chaumont'],
    siret: '123',
    vat_number: 'FR1',
  },
  lines: [
    {
      label: 'Copies <N/B> & co',
      qty: 10,
      unit_price_ttc_cents: 12,
      discount_percent: 0,
      line_ttc_cents: 120,
      vat_rate: '20.00',
    },
  ],
  vat_breakdown: [{ rate: '20.00', base_ht_cents: 100, vat_cents: 20, ttc_cents: 120 }],
  total_ht_cents: 100,
  total_vat_cents: 20,
  total_ttc_cents: 120,
  payments: [{ method: 'cash', label: 'Espèces', amount_cents: 120 }],
  change_cents: 0,
  footer: { lines: [] },
  compliance: {
    hash_short: 'abcd1234',
    signature_status: 'signed',
    software: 'Ma Papeterie POS',
    version: '0.5.0',
  },
  invoice_requested: true,
} as unknown as TicketPayload;

describe('invoicePartyFor', () => {
  it('en-tête de passage prioritaire, avec adresse', () => {
    const p = invoicePartyFor(
      ticket,
      { name: 'ACME', address: '1 rue X', postal_code: '52000', city: 'Chaumont', siret: '9' },
      'Jean',
    );
    expect(p).toEqual({
      name: 'ACME',
      address_lines: ['1 rue X', '52000 Chaumont'],
      siret: '9',
    });
  });
  it('passage sans en-tête : nom seul ; sans client : null', () => {
    expect(invoicePartyFor(ticket, null, 'Jean')).toEqual({ name: 'Jean', address_lines: [] });
    expect(invoicePartyFor(ticket, null, null)).toBeNull();
  });
});

describe('buildInvoiceHtml', () => {
  it('contient numéro, vendeur, acheteur et totaux, en échappant le HTML', () => {
    const html = buildInvoiceHtml(ticket, { name: 'ACME <SARL>', address_lines: ['1 rue X'] });
    expect(html).toContain('FACTURE n° T-2026-000042');
    expect(html).toContain('Ma Papeterie');
    expect(html).toContain('ACME &lt;SARL&gt;');
    expect(html).toContain('Copies &lt;N/B&gt; &amp; co');
    expect(html).toContain('@page { size: A4');
    expect(html).not.toContain('<N/B>');
  });
  it('sans client : « Client comptoir » ; avoir : titre AVOIR', () => {
    expect(buildInvoiceHtml(ticket, null)).toContain('Client comptoir');
    expect(buildInvoiceHtml({ ...ticket, kind: 'refund' } as TicketPayload, null)).toContain(
      'AVOIR n°',
    );
  });
});
