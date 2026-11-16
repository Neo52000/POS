-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — base de la valorisation d'inventaire (comptable)
-- -----------------------------------------------------------------------------
-- pos_inventory_valuation_base(p_product_ids) : références au stock boutique non nul (+ celles
-- du lot compté en caisse) avec prix d'achat HT (cost_price). Service role uniquement : le prix
-- d'achat n'est jamais exposé à la clé anon. Lu par l'Edge Function pos-inventory-valuation.
-- Stock physique de la boutique uniquement (stock_boutique) : le stock « en ligne » est le stock
-- virtuel des fournisseurs, pas un stock détenu.
-- Déjà appliquée sur ma-papeterie (version 20261116172509). Idempotent.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.pos_inventory_valuation_base(p_product_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS TABLE (
  product_id     uuid,
  ean            text,
  name           text,
  brand          text,
  category       text,
  stock_boutique integer,
  cost_price     numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  -- Stock physique de la boutique : toute référence au stock non nul, plus celles du lot compté.
  RETURN QUERY
    SELECT p.id, p.ean::text, p.name::text, p.brand::text, p.category::text,
           coalesce(p.stock_boutique, 0)::integer, p.cost_price::numeric
    FROM public.products p
    WHERE coalesce(p.stock_boutique, 0) <> 0
       OR p.id = ANY (coalesce(p_product_ids, '{}'::uuid[]))
    ORDER BY p.category NULLS LAST, p.name;
END;
$$;
COMMENT ON FUNCTION public.pos_inventory_valuation_base(uuid[]) IS 'POS bridge (service role) : références au stock boutique non nul (+ celles de p_product_ids) avec prix d''achat HT (cost_price), pour la valorisation d''inventaire du comptable.';
REVOKE EXECUTE ON FUNCTION public.pos_inventory_valuation_base(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_inventory_valuation_base(uuid[]) TO service_role;

-- ROLLBACK : DROP FUNCTION IF EXISTS public.pos_inventory_valuation_base(uuid[]);
