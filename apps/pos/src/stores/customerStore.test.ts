import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/events', () => ({ logEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/edge', () => ({
  edge: { resolvePrices: vi.fn() },
}));

import { edge } from '@/lib/edge';
import { useCartStore } from './cartStore';
import { useCustomerStore } from './customerStore';
import type { PosCustomer, PosProduct, ResolvedPrice } from '@/types/pos';

const BIC: PosProduct = {
  id: 'a0000000-0000-4000-8000-000000000001',
  name: 'Stylo BIC',
  brand: 'BIC',
  ean: '3086123101227',
  image_url: null,
  price_ttc_cents: 120,
  price_ht_cents: 100,
  vat_rate: 20,
  eco_tax_cents: 0,
  stock_boutique: 5,
  pos_price_tiers: null,
};
const CAHIER: PosProduct = {
  ...BIC,
  id: 'a0000000-0000-4000-8000-000000000004',
  name: 'Cahier',
  price_ttc_cents: 245,
};

const MAIRIE: PosCustomer = {
  id: 'c0000000-0000-4000-8000-000000000001',
  display_name: 'Mairie de Chaumont',
  company_name: 'Mairie de Chaumont',
  siret: null,
  vat_number: null,
  kind: 'company',
  customer_type: 'collectivite',
  payment_terms_days: 30,
  pricing_rules_count: 2,
  open_quotes_count: 0,
  revenue_ttc_12m: null,
  email: null,
  phone: null,
};

function resolved(product_id: string, ttc: number, rule: string | null, qty = 1): ResolvedPrice {
  return {
    product_id,
    qty,
    unit_price_ht_cents: Math.round(ttc / 1.2),
    unit_price_ttc_cents: ttc,
    vat_rate: 20,
    rule_id: rule,
    rule_scope: rule ? 'product' : null,
    rule_mode: rule ? 'percent' : null,
    rule_value: rule ? 10 : null,
    public_price_ht_cents: 100,
  };
}

describe('customerStore.attach', () => {
  beforeEach(() => {
    useCartStore.setState({ lines: [], quote_id: null });
    useCustomerStore.setState({
      account: null,
      pricing: {},
      quotes: [],
      resolving: false,
      pendingLines: 0,
      error: null,
    });
    useCartStore.getState().setLocked(false);
    vi.mocked(edge.resolvePrices).mockReset();
  });

  it('appelle pos-resolve-prices avec les lignes du panier et réapplique les prix', async () => {
    const cart = useCartStore.getState();
    cart.addProduct(BIC, { qty: 2 });
    cart.addProduct(CAHIER);
    vi.mocked(edge.resolvePrices).mockResolvedValueOnce([
      resolved(BIC.id, 108, 'e0000000-0000-4000-8000-000000000001', 2),
      resolved(CAHIER.id, 245, null),
    ]);

    await useCustomerStore.getState().attach(MAIRIE);

    expect(edge.resolvePrices).toHaveBeenCalledWith(MAIRIE.id, [
      { product_id: BIC.id, qty: 2 },
      { product_id: CAHIER.id, qty: 1 },
    ]);
    const lines = useCartStore.getState().lines;
    expect(lines[0]?.unit_price_ttc_cents).toBe(108);
    expect(lines[0]?.pricing_rule_id).toBe('e0000000-0000-4000-8000-000000000001');
    expect(lines[0]?.public_price_ttc_cents).toBe(120);
    expect(lines[1]?.unit_price_ttc_cents).toBe(245);
    expect(lines[1]?.pricing_rule_id).toBeNull();
    expect(useCustomerStore.getState().pricing[BIC.id]?.rule_id).toBe(
      'e0000000-0000-4000-8000-000000000001',
    );
    expect(useCustomerStore.getState().resolving).toBe(false);
  });

  it('résout le prix à chaque ajout quand un client est attaché', async () => {
    vi.mocked(edge.resolvePrices).mockResolvedValue([
      resolved(BIC.id, 108, 'e0000000-0000-4000-8000-000000000001'),
    ]);
    await useCustomerStore.getState().attach(MAIRIE);
    expect(edge.resolvePrices).not.toHaveBeenCalled(); // panier vide : pas d'appel
    useCartStore.getState().addProduct(BIC);
    await vi.waitFor(() => {
      expect(useCartStore.getState().lines[0]?.unit_price_ttc_cents).toBe(108);
    });
    expect(edge.resolvePrices).toHaveBeenCalledWith(MAIRIE.id, [{ product_id: BIC.id, qty: 1 }]);
  });

  it('detach restaure les prix publics', async () => {
    useCartStore.getState().addProduct(BIC);
    vi.mocked(edge.resolvePrices).mockResolvedValueOnce([
      resolved(BIC.id, 108, 'e0000000-0000-4000-8000-000000000001'),
    ]);
    await useCustomerStore.getState().attach(MAIRIE);
    expect(useCartStore.getState().lines[0]?.unit_price_ttc_cents).toBe(108);
    useCustomerStore.getState().detach();
    expect(useCustomerStore.getState().account).toBeNull();
    expect(useCartStore.getState().lines[0]?.unit_price_ttc_cents).toBe(120);
    expect(useCartStore.getState().lines[0]?.pricing_rule_id).toBeNull();
  });

  it('remonte une erreur sans casser le panier', async () => {
    useCartStore.getState().addProduct(BIC);
    vi.mocked(edge.resolvePrices).mockRejectedValueOnce(new Error('NETWORK'));
    await useCustomerStore.getState().attach(MAIRIE);
    expect(useCustomerStore.getState().error).toBe('NETWORK');
    expect(useCustomerStore.getState().account?.id).toBe(MAIRIE.id);
    expect(useCartStore.getState().lines[0]?.unit_price_ttc_cents).toBe(120);
  });

  it('ignore une réponse tarifaire périmée (quantité modifiée entre-temps)', async () => {
    await useCustomerStore.getState().attach(MAIRIE); // panier vide : aucun appel
    let releaseFirst: (v: ResolvedPrice[]) => void = () => undefined;
    vi.mocked(edge.resolvePrices)
      .mockImplementationOnce(() => new Promise((r) => (releaseFirst = r)))
      .mockResolvedValueOnce([resolved(BIC.id, 96, 'rule-qty-10', 10)]);
    const line = useCartStore.getState().addProduct(BIC); // requête 1 (qty 1)
    expect(useCustomerStore.getState().pendingLines).toBe(1);
    useCartStore.getState().setQty(line.key, 10); // requête 2 (qty 10)
    await vi.waitFor(() => expect(useCartStore.getState().lines[0]?.unit_price_ttc_cents).toBe(96));
    releaseFirst([resolved(BIC.id, 108, 'rule-qty-1', 1)]);
    await vi.waitFor(() => expect(useCustomerStore.getState().pendingLines).toBe(0));
    expect(useCartStore.getState().lines[0]?.unit_price_ttc_cents).toBe(96);
  });

  it('ne modifie pas les prix pendant un encaissement (panier verrouillé)', async () => {
    useCartStore.getState().addProduct(BIC);
    useCartStore.getState().setLocked(true);
    vi.mocked(edge.resolvePrices).mockResolvedValueOnce([resolved(BIC.id, 108, 'rule')]);
    await useCustomerStore.getState().attach(MAIRIE);
    expect(useCartStore.getState().lines[0]?.unit_price_ttc_cents).toBe(120);
  });

  it('ne remplace jamais un prix forcé à la main', async () => {
    const line = useCartStore.getState().addProduct(BIC);
    useCartStore.getState().setUnitPrice(line.key, 100);
    vi.mocked(edge.resolvePrices).mockResolvedValue([resolved(BIC.id, 108, 'rule')]);
    await useCustomerStore.getState().attach(MAIRIE);
    useCartStore.getState().setQty(line.key, 3);
    await vi.waitFor(() => expect(useCustomerStore.getState().pendingLines).toBe(0));
    const l = useCartStore.getState().lines[0];
    expect(l?.unit_price_ttc_cents).toBe(100);
    expect(l?.price_overridden).toBe(true);
    // Pas de nouvelle résolution pour une ligne à prix forcé.
    expect(edge.resolvePrices).toHaveBeenCalledTimes(1);
  });
});
