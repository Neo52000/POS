import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildInvoiceHtml,
  invoiceDuplicateLabel,
  invoicePartyFor,
  passageNameOf,
} from './invoice.js';
import type { InvoiceTicket } from './invoice.js';

const ticket: InvoiceTicket = {
  register_code: 'C1',
  ticket_code: 'T-2026-000042',
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
      discount_percent: 0,
      line_ttc_cents: 120,
      vat_rate: '20.00',
    },
  ],
  vat_breakdown: [{ rate: '20.00', base_ht_cents: 100, vat_cents: 20, ttc_cents: 120 }],
  total_ht_cents: 100,
  total_vat_cents: 20,
  total_ttc_cents: 120,
  payments: [{ label: 'Espèces', amount_cents: 120 }],
  compliance: {},
};

describe('invoice', () => {
  it('passageNameOf : retire le préfixe « Passage — »', () => {
    expect(passageNameOf({ customer: { display_name: 'Passage — Jean Dupont' } })).toBe(
      'Jean Dupont',
    );
    expect(passageNameOf({ customer: { display_name: 'Mairie' } })).toBeNull();
    expect(passageNameOf({})).toBeNull();
  });

  it('invoicePartyFor : en-tête prioritaire, puis nom de passage, puis fiche pro', () => {
    expect(
      invoicePartyFor(
        ticket,
        { name: 'ACME', address: '1 rue X', postal_code: '52000', city: 'Chaumont' },
        'Jean',
      ),
    ).toEqual({ name: 'ACME', address_lines: ['1 rue X', '52000 Chaumont'] });
    expect(invoicePartyFor(ticket, null, 'Jean')).toEqual({ name: 'Jean', address_lines: [] });
    expect(invoicePartyFor(ticket, null, null)).toBeNull();
    expect(
      invoicePartyFor(
        { customer: { display_name: 'M', company_name: 'Mairie', siret: '9' } },
        null,
        null,
      ),
    ).toEqual({ name: 'Mairie', address_lines: [], siret: '9' });
  });

  it('buildInvoiceHtml : contenu, échappement HTML, avoir, duplicata', () => {
    const html = buildInvoiceHtml(ticket, { name: 'ACME <SARL>', address_lines: ['1 rue X'] });
    expect(html).toContain('FACTURE n° T-2026-000042');
    expect(html).toContain('ACME &lt;SARL&gt;');
    expect(html).toContain('Copies &lt;N/B&gt; &amp; co');
    expect(html).not.toContain('<N/B>');
    expect(html).toContain('Facture acquittée');
    expect(buildInvoiceHtml(ticket, null)).toContain('Client comptoir');
    expect(buildInvoiceHtml({ ...ticket, kind: 'refund' }, null)).toContain('AVOIR n°');
    expect(buildInvoiceHtml({ ...ticket, duplicate: true, duplicate_number: 2 }, null)).toContain(
      'DUPLICATA n°2',
    );
    expect(invoiceDuplicateLabel({ duplicate: false })).toBeNull();
  });

  it('la copie Edge (supabase/functions/_shared/invoiceHtml.ts) est identique', () => {
    const core = readFileSync(new URL('./invoice.ts', import.meta.url), 'utf8');
    const edge = readFileSync(
      new URL('../../../supabase/functions/_shared/invoiceHtml.ts', import.meta.url),
      'utf8',
    );
    expect(edge).toBe(core);
  });
});
