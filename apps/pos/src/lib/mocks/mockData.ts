import type {
  CustomerQuote,
  PosCustomer,
  PosProduct,
  PosRegister,
  PosSettingsMap,
  ResolvedPrice,
} from '@/types/pos';

export const MOCK_REGISTER: PosRegister = {
  id: '11111111-1111-4111-8111-111111111111',
  code: 'TEST-01',
  label: 'Caisse de test (mock)',
  is_active: true,
};

export const MOCK_USER = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'vendeur@ma-papeterie.fr',
};

export const MOCK_SETTINGS: PosSettingsMap = {
  legal: {
    company_name: 'Reine & Fils SAS',
    address_lines: ['10 rue Toupot de Béveaux', '52000 Chaumont'],
    siret: '123 456 789 00012',
    vat_number: 'FR12123456789',
    phone: '03 25 00 00 00',
  },
  ticket_footer: ['Merci de votre visite !', 'Échange sous 15 jours avec ticket'],
  software: { version: '0.1.0-mock' },
};

export const MOCK_PRODUCTS: PosProduct[] = [
  {
    id: 'a0000000-0000-4000-8000-000000000001',
    name: 'Stylo bille BIC Cristal bleu',
    brand: 'BIC',
    ean: '3086123101227',
    image_url: null,
    price_ttc_cents: 120,
    price_ht_cents: 100,
    vat_rate: 20,
    eco_tax_cents: 0,
    stock_boutique: 42,
    pos_price_tiers: null,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000002',
    name: 'Stylo plume Lamy Safari noir',
    brand: 'Lamy',
    ean: '4014519000105',
    image_url: null,
    price_ttc_cents: 2490,
    price_ht_cents: 2075,
    vat_rate: 20,
    eco_tax_cents: 0,
    stock_boutique: 0,
    pos_price_tiers: null,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000003',
    name: 'Stylo roller Pilot V5 rouge',
    brand: 'Pilot',
    ean: '4902505085796',
    image_url: null,
    price_ttc_cents: 350,
    price_ht_cents: 292,
    vat_rate: 20,
    eco_tax_cents: 0,
    stock_boutique: 7,
    pos_price_tiers: null,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000004',
    name: 'Cahier Clairefontaine 96p grands carreaux',
    brand: 'Clairefontaine',
    ean: '3037920636016',
    image_url: null,
    price_ttc_cents: 245,
    price_ht_cents: 204,
    vat_rate: 20,
    eco_tax_cents: 0,
    stock_boutique: 15,
    pos_price_tiers: null,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000005',
    name: 'Livre « Le Petit Prince »',
    brand: 'Gallimard',
    ean: '9782070408504',
    image_url: null,
    price_ttc_cents: 790,
    price_ht_cents: 749,
    vat_rate: 5.5,
    eco_tax_cents: 0,
    stock_boutique: 3,
    pos_price_tiers: null,
  },
  {
    id: 'a0000000-0000-4000-8000-000000000006',
    name: 'Impression / photocopie',
    brand: null,
    ean: null,
    image_url: null,
    price_ttc_cents: 20,
    price_ht_cents: 17,
    vat_rate: 20,
    eco_tax_cents: 0,
    stock_boutique: 0,
    pos_price_tiers: [
      { price: 0.2, title: 'A4 noir & blanc' },
      { price: 0.6, title: 'A4 couleur' },
      { price: 1.2, title: 'A3 couleur' },
    ],
  },
];

export const MOCK_CUSTOMERS: PosCustomer[] = [
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    display_name: 'Mairie de Chaumont',
    company_name: 'Mairie de Chaumont',
    siret: '215 201 218 00018',
    vat_number: 'FR00215201218',
    kind: 'company',
    customer_type: 'collectivite',
    payment_terms_days: 30,
    pricing_rules_count: 2,
    open_quotes_count: 1,
    revenue_ttc_12m: 4820.5,
    email: 'achats@chaumont.fr',
    phone: '03 25 30 60 00',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    display_name: 'Cabinet Martin & Associés',
    company_name: 'Cabinet Martin & Associés',
    siret: '512 345 678 00021',
    vat_number: 'FR45512345678',
    kind: 'company',
    customer_type: 'entreprise',
    payment_terms_days: 0,
    pricing_rules_count: 0,
    open_quotes_count: 0,
    revenue_ttc_12m: 320,
    email: 'contact@cabinet-martin.fr',
    phone: null,
  },
];

export const MOCK_QUOTES: Record<string, CustomerQuote[]> = {
  'c0000000-0000-4000-8000-000000000001': [
    {
      id: 'd0000000-0000-4000-8000-000000000001',
      quote_number: 'DV-2026-0042',
      status: 'sent',
      valid_until: '2026-12-31',
      total_ttc: 60.6,
      items: [
        {
          product_id: 'a0000000-0000-4000-8000-000000000001',
          label: 'Stylo bille BIC Cristal bleu',
          quantity: 50,
          unit_price_ht: 0.9,
          unit_price_ttc: 1.08,
          discount_percent: 0,
          vat_rate: 20,
        },
        {
          product_id: 'a0000000-0000-4000-8000-000000000004',
          label: 'Cahier Clairefontaine 96p grands carreaux',
          quantity: 3,
          unit_price_ht: 1.8,
          unit_price_ttc: 2.16,
          discount_percent: 0,
          vat_rate: 20,
        },
      ],
    },
  ],
};

/** Règles tarifaires mock : Mairie → −10 % sur le BIC, prix net 2,00 € sur le cahier. */
export function mockResolvePrice(
  accountId: string,
  productId: string,
  qty: number,
): ResolvedPrice | null {
  const product = MOCK_PRODUCTS.find((p) => p.id === productId);
  if (!product) return null;
  const base: ResolvedPrice = {
    product_id: productId,
    qty,
    unit_price_ht_cents: product.price_ht_cents,
    unit_price_ttc_cents: product.price_ttc_cents,
    vat_rate: product.vat_rate,
    rule_id: null,
    rule_scope: null,
    rule_mode: null,
    rule_value: null,
    public_price_ht_cents: product.price_ht_cents,
  };
  if (accountId !== 'c0000000-0000-4000-8000-000000000001') return base;
  if (productId === 'a0000000-0000-4000-8000-000000000001') {
    return {
      ...base,
      unit_price_ht_cents: 90,
      unit_price_ttc_cents: 108,
      rule_id: 'e0000000-0000-4000-8000-000000000001',
      rule_scope: 'product',
      rule_mode: 'percent',
      rule_value: 10,
    };
  }
  if (productId === 'a0000000-0000-4000-8000-000000000004') {
    return {
      ...base,
      unit_price_ht_cents: 167,
      unit_price_ttc_cents: 200,
      rule_id: 'e0000000-0000-4000-8000-000000000002',
      rule_scope: 'product',
      rule_mode: 'net_price',
      rule_value: 1.67,
    };
  }
  return base;
}
