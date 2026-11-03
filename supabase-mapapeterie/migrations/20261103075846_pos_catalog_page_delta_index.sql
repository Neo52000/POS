-- =============================================================================
-- POS bridge (projet ma-papeterie) : pos_catalog_page sans lecture complète de
-- products — corrige les 500 (statement timeout anon 3 s) de la synchro caisse
-- -----------------------------------------------------------------------------
-- Constat (03/11/2026, logs prod) : `POST rpc/pos_catalog_page` → 500,
-- « canceling statement due to statement timeout » (07:31–07:36 UTC).
-- Cause : la condition unique
--   (p_since IS NULL AND pos_visible) OR (p_since IS NOT NULL AND updated_at > p_since)
-- ne peut pas utiliser d'index (fonction SQL non inlinée à cause de SET
-- search_path → plan générique) ; aucun index sur products.updated_at non
-- plus. Chaque delta (toutes les 30 min, cf. apps/pos/src/lib/offlineCatalog.ts)
-- lisait les 116 762 lignes de products (heap 224 Mo + TOAST) : 2,5 à 5,9 s
-- mesurés, au-delà du statement_timeout de 3 s du rôle anon.
--
-- Correctif :
--   1. index (id, updated_at) : keyset par id + filtre updated_at dans l'index
--      (seuls les produits modifiés sont relus) ;
--   2. pos_catalog_page en plpgsql, une requête par mode (complet / delta),
--      chacune indexable. Signature, colonnes, tri, bornes, droits et
--      sémantique inchangés (delta = produits modifiés, visibles ou non).
-- Mesures prod (transaction annulée puis application) : delta 30 min
-- 5 879 → 56 ms (page 2 : 15 ms), delta 7 j 722 ms, complet page 1 294 ms.
-- Équivalence vérifiée : mêmes lignes, 0 différence, sur delta 45 min, delta
-- 3 j, complet page 1 et complet page 2 (EXCEPT ancien / nouveau).
--
-- L'index a été créé en prod en CONCURRENTLY (hors transaction) avant cette
-- migration ; IF NOT EXISTS le rend sans effet ici et le recrée sur une base
-- reconstruite. Recopier dans Neo52000/ma-papeterie-v1 (ENGINEERING.md §4).
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_products_id_updated_at
  ON public.products USING btree (id, updated_at);

CREATE OR REPLACE FUNCTION public.pos_catalog_page(
  p_after_id uuid        DEFAULT NULL,
  p_limit    integer     DEFAULT 5000,
  p_since    timestamptz DEFAULT NULL
)
RETURNS TABLE(id uuid, name text, brand text, ean text, image_url text, price_ttc_cents bigint,
              price_ht_cents bigint, vat_rate numeric, eco_tax_cents bigint, stock_boutique integer,
              pos_price_tiers jsonb, updated_at timestamptz, pos_visible boolean)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  v_after uuid := coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_limit int  := least(greatest(coalesce(p_limit, 5000), 1), 10000);
BEGIN
  IF p_since IS NULL THEN
    -- Synchro complète : produits visibles en caisse, keyset par id.
    RETURN QUERY
      SELECT c.id, c.name::text, c.brand::text, c.ean::text, c.image_url::text,
             c.price_ttc_cents, c.price_ht_cents, c.vat_rate, c.eco_tax_cents, c.stock_boutique::int,
             c.pos_price_tiers, c.updated_at, c.pos_visible
      FROM public.pos_catalog c
      WHERE c.id > v_after AND c.pos_visible
      ORDER BY c.id
      LIMIT v_limit;
  ELSE
    -- Delta : tout produit modifié depuis p_since, y compris devenu invisible
    -- (la caisse le retire alors de son cache).
    RETURN QUERY
      SELECT c.id, c.name::text, c.brand::text, c.ean::text, c.image_url::text,
             c.price_ttc_cents, c.price_ht_cents, c.vat_rate, c.eco_tax_cents, c.stock_boutique::int,
             c.pos_price_tiers, c.updated_at, c.pos_visible
      FROM public.pos_catalog c
      WHERE c.id > v_after AND c.updated_at > p_since
      ORDER BY c.id
      LIMIT v_limit;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.pos_catalog_page(uuid, int, timestamptz) IS
  'POS bridge : pagination keyset (id) du catalogue caisse pour le cache hors ligne ; p_since = delta (inclut les produits devenus invisibles). Une requête indexée par mode (idx_products_id_updated_at). Appelable avec la clé anon.';
GRANT EXECUTE ON FUNCTION public.pos_catalog_page(uuid, int, timestamptz) TO anon, authenticated, service_role;
