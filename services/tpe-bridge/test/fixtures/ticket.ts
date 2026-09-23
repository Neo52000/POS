import type { TicketPayload } from '@pos/core';

/** TicketPayload de référence (SPEC §6) : vente mixte CB + espèces avec rendu, client B2B. */
export function referenceTicket(overrides: Partial<TicketPayload> = {}): TicketPayload {
  return {
    version: 1,
    register_code: 'C01',
    ticket_number: 123,
    ticket_code: 'T-2026-000123',
    duplicate: false,
    kind: 'sale',
    business_at: '2026-09-23T14:05:07.123Z',
    cashier_name: 'Élie',
    header: {
      company_name: 'Ma Papeterie',
      address_lines: ['10 rue Toupot de Béveaux', '52000 Chaumont'],
      siret: '123 456 789 00012',
      vat_number: 'FR12345678901',
      phone: '03 25 00 00 00',
    },
    customer: {
      display_name: 'Mairie de Chaumont',
      company_name: 'Commune de Chaumont',
      siret: '215 201 218 00019',
    },
    lines: [
      {
        label: 'Cahier 96 pages grands carreaux Clairefontaine œuvre',
        qty: 2,
        unit_price_ttc_cents: 1250,
        discount_percent: 0,
        line_ttc_cents: 2500,
        vat_rate: '20.00',
      },
      {
        label: 'Stylo plume Lamy Safari',
        qty: 1,
        unit_price_ttc_cents: 2990,
        discount_percent: 10,
        line_ttc_cents: 2691,
        vat_rate: '20.00',
        price_tier_title: 'Pro',
        public_price_ttc_cents: 3200,
      },
      {
        label: 'Livre « Le Petit Prince »',
        qty: 1,
        unit_price_ttc_cents: 790,
        discount_percent: 0,
        line_ttc_cents: 790,
        vat_rate: '5.50',
      },
    ],
    vat_breakdown: [
      { rate: '5.50', base_ht_cents: 749, vat_cents: 41, ttc_cents: 790 },
      { rate: '20.00', base_ht_cents: 4326, vat_cents: 865, ttc_cents: 5191 },
    ],
    total_ht_cents: 5075,
    total_vat_cents: 906,
    total_ttc_cents: 5981,
    payments: [
      { method: 'cb', label: 'Carte bancaire', amount_cents: 5000 },
      { method: 'cash', label: 'Espèces', amount_cents: 1000 },
    ],
    change_cents: 19,
    footer: { lines: ['Merci de votre visite !', 'Échange sous 15 jours avec ticket'] },
    compliance: {
      hash_short: '1a2b3c4d',
      signature_status: 'signed',
      fiskaly_signature_short: 'ABCDEF0123456789',
      software: 'Ma Papeterie POS',
      version: '0.1.0',
    },
    invoice_requested: true,
    ...overrides,
  };
}
