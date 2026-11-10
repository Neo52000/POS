-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — prestations de service vendables en caisse
-- -----------------------------------------------------------------------------
-- Les articles de la catégorie « Services » (copies, impression, numérisation,
-- plastification, reliure, photos, grand format) n'ont pas de coût d'achat : la règle
-- is_vendable du canal pos (cost_price NOT NULL et price > cost_price) les rendait
-- invisibles en caisse.
--
-- update_is_vendable : canal pos + catégorie Services -> vendable dès price >= 0,05.
-- Les autres produits sont inchangés. Les services existants sont recalculés.
--
-- Déjà appliquée sur ma-papeterie (version 20261110083656). Idempotent.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_is_vendable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.sales_channel = 'pos' AND NEW.category = 'Services' THEN
    -- Prestations de la boutique (copies, reliure, photos…) : pas de coût d'achat.
    NEW.is_vendable := (NEW.price >= 0.05);
  ELSIF NEW.sales_channel = 'pos' THEN
    NEW.is_vendable := (
      NEW.price >= 0.05
      AND NEW.cost_price IS NOT NULL
      AND NEW.price > NEW.cost_price
    );
  ELSIF NEW.is_pod = TRUE THEN
    NEW.is_vendable := (
      NEW.price >= 0.05
      AND NEW.slug IS NOT NULL
      AND NEW.slug <> ''
      AND NEW.cost_price IS NOT NULL
      AND NEW.price > NEW.cost_price
    );
  ELSE
    NEW.is_vendable := (
      NEW.ean IS NOT NULL
      AND NEW.ean <> ''
      AND COALESCE(NEW.public_price_ttc, NEW.price_ttc, NEW.price) >= 0.05
      AND NEW.cost_price IS NOT NULL
      AND COALESCE(NEW.public_price_ttc, NEW.price_ttc, NEW.price) > NEW.cost_price
      AND (
        EXISTS (
          SELECT 1
          FROM public.supplier_products sp
          WHERE sp.product_id = NEW.id
        )
        OR EXISTS (
          SELECT 1
          FROM public.supplier_offers so
          WHERE so.product_id = NEW.id
        )
      )
    );
  END IF;

  RETURN NEW;
END
$function$;

-- Recalcule is_vendable des services déjà en base (le trigger se déclenche sur UPDATE OF price).
UPDATE public.products SET price = price
WHERE category = 'Services' AND sales_channel = 'pos' AND is_active;

-- =============================================================================
-- ROLLBACK : recréer update_is_vendable sans la première branche (version
-- 20260920071003 is_vendable_use_effective_price / 20260902104622), puis
-- UPDATE public.products SET price = price WHERE category = 'Services';
-- =============================================================================

-- =============================================================================
-- RPC catalogue : prestations de service visibles en caisse (accès direct en caisse).
-- Appliquée sur ma-papeterie (version 20261110084xxx, nom pos_service_products).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.pos_service_products()
RETURNS TABLE (
  id               uuid,
  name             text,
  brand            text,
  ean              text,
  image_url        text,
  price_ttc_cents  bigint,
  price_ht_cents   bigint,
  vat_rate         numeric,
  eco_tax_cents    bigint,
  stock_boutique   int,
  pos_price_tiers  jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT c.id, c.name::text, c.brand::text, c.ean::text, c.image_url::text,
         c.price_ttc_cents, c.price_ht_cents, c.vat_rate, c.eco_tax_cents,
         c.stock_boutique::int, c.pos_price_tiers
  FROM public.pos_catalog c
  JOIN public.products p ON p.id = c.id
  WHERE c.pos_visible AND p.category = 'Services'
  ORDER BY c.name, c.price_ttc_cents
  LIMIT 200;
$$;
COMMENT ON FUNCTION public.pos_service_products() IS 'POS bridge : prestations de service (catégorie Services) visibles en caisse, même projection que pos_search_products. Appelable avec la clé anon.';
GRANT EXECUTE ON FUNCTION public.pos_service_products() TO anon, authenticated, service_role;
-- ROLLBACK : DROP FUNCTION IF EXISTS public.pos_service_products();
