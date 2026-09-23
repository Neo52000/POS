-- =============================================================================
-- POS NF525 — bridge ma-papeterie (projet Supabase « ma-papeterie »)
-- -----------------------------------------------------------------------------
-- Le module POS (projet « Pos ») n'a pas accès aux tables ma-papeterie. Ce
-- fichier expose, dans ma-papeterie, les fonctions dont la caisse a besoin :
--   * lecture catalogue (SECURITY INVOKER, appelées directement par la PWA avec
--     la clé anon de ma-papeterie : products est en lecture publique) :
--       pos_search_products, pos_product_by_ean, pos_catalog_page (+ vue pos_catalog)
--   * réservées au service role (appelées par les Edge Functions de Pos avec la
--     clé service de ma-papeterie), SECURITY DEFINER car customer_accounts /
--     customer_360 / client_quotes sont en RLS deny-all :
--       pos_resolve_cart_prices, pos_customer_lookup, pos_customer_get,
--       pos_customer_open_quotes, pos_apply_stock_movements
--   * pos_adjust_stock_boutique (admin ma-papeterie ou service role)
--   * table pos_stock_movements : journal idempotent des mouvements de
--     products.stock_boutique appliqués par la caisse.
-- Contraintes : aucun trigger sur products (le trigger existant
-- trg_3_sync_boutique_to_locations propage stock_boutique), stock_online jamais
-- touché, stock négatif toléré et tracé.
-- Idempotent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_bridge_is_service_role()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      OR session_user <> 'authenticator';
$$;
COMMENT ON FUNCTION public.pos_bridge_is_service_role() IS 'POS bridge : vrai pour le service role (Edge Functions Pos) ou une connexion directe hors PostgREST.';

CREATE OR REPLACE FUNCTION public.pos_bridge_require_service_role()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NOT public.pos_bridge_is_service_role() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE';
  END IF;
END;
$$;
COMMENT ON FUNCTION public.pos_bridge_require_service_role() IS 'POS bridge : lève FORBIDDEN_ROLE (42501) si l''appelant n''est pas le service role.';

CREATE OR REPLACE FUNCTION public.pos_bridge_error(p_code text, p_detail jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_code, DETAIL = coalesce(p_detail, '{}'::jsonb)::text;
END;
$$;
COMMENT ON FUNCTION public.pos_bridge_error(text, jsonb) IS 'POS bridge : lève une erreur métier (ERRCODE P0001, MESSAGE = code, DETAIL = JSON).';

-- -----------------------------------------------------------------------------
-- Catalogue : vue de projection caisse (prix en centimes, TVA arrondie)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.pos_catalog
WITH (security_invoker = true)
AS
SELECT
  p.id,
  p.name,
  p.brand,
  p.ean,
  p.image_url,
  round(coalesce(p.public_price_ttc, p.price_ttc, 0) * 100)::bigint                                   AS price_ttc_cents,
  -- HT dérivé du TTC affiché avec la formule SPEC §2 (informatif)
  round(round(coalesce(p.public_price_ttc, p.price_ttc, 0) * 100) * 10000
        / (10000 + round(round(coalesce(p.tva_rate, 20), 2) * 100)))::bigint                            AS price_ht_cents,
  round(coalesce(p.tva_rate, 20), 2)                                                                     AS vat_rate,
  round(coalesce(p.eco_tax, 0) * 100)::bigint                                                            AS eco_tax_cents,
  coalesce(p.stock_boutique, 0)                                                                          AS stock_boutique,
  p.pos_price_tiers,
  p.manufacturer_code,
  p.search_vector,
  p.updated_at,
  (coalesce(p.is_active, false) AND coalesce(p.is_vendable, false)
     AND p.sales_channel IN ('both', 'pos'))                                                             AS pos_visible
FROM public.products p;
COMMENT ON VIEW public.pos_catalog IS 'POS bridge : projection caisse de products (prix en centimes, TVA arrondie, stock_boutique, visibilité POS). security_invoker.';
GRANT SELECT ON public.pos_catalog TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_search_products(p_query text, p_limit int DEFAULT 20)
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
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_q     text := btrim(coalesce(p_query, ''));
  v_limit int  := least(greatest(coalesce(p_limit, 20), 1), 200);
  v_tsq   tsquery;
BEGIN
  IF v_q = '' THEN
    RETURN;
  END IF;

  -- Code-barres saisi/scanné : correspondance exacte prioritaire
  IF v_q ~ '^\d{8,14}$' THEN
    RETURN QUERY
      SELECT c.id, c.name::text, c.brand::text, c.ean::text, c.image_url::text,
             c.price_ttc_cents, c.price_ht_cents, c.vat_rate, c.eco_tax_cents, c.stock_boutique::int, c.pos_price_tiers
      FROM public.pos_catalog c
      WHERE c.pos_visible AND c.ean = v_q
      ORDER BY c.name
      LIMIT v_limit;
    IF FOUND THEN
      RETURN;
    END IF;
  END IF;

  v_tsq := plainto_tsquery('french', v_q);

  RETURN QUERY
    SELECT c.id, c.name::text, c.brand::text, c.ean::text, c.image_url::text,
           c.price_ttc_cents, c.price_ht_cents, c.vat_rate, c.eco_tax_cents, c.stock_boutique::int, c.pos_price_tiers
    FROM public.pos_catalog c
    WHERE c.pos_visible
      AND (
        (numnode(v_tsq) > 0 AND c.search_vector @@ v_tsq)
        OR c.name ILIKE '%' || v_q || '%'
        OR c.ean LIKE v_q || '%'
        OR c.manufacturer_code ILIKE v_q || '%'
      )
    ORDER BY
      CASE WHEN numnode(v_tsq) > 0 THEN ts_rank(c.search_vector, v_tsq) ELSE 0 END DESC,
      c.name
    LIMIT v_limit;
END;
$$;
COMMENT ON FUNCTION public.pos_search_products(text, int) IS 'POS bridge : recherche catalogue caisse (EAN exact prioritaire, sinon full-text french + ILIKE nom/EAN/code fabricant). Produits actifs, vendables, canal both|pos. Appelable avec la clé anon.';

CREATE OR REPLACE FUNCTION public.pos_product_by_ean(p_ean text)
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
         c.price_ttc_cents, c.price_ht_cents, c.vat_rate, c.eco_tax_cents, c.stock_boutique::int, c.pos_price_tiers
  FROM public.pos_catalog c
  WHERE c.pos_visible AND c.ean = btrim(p_ean)
  ORDER BY c.updated_at DESC NULLS LAST
  LIMIT 1;
$$;
COMMENT ON FUNCTION public.pos_product_by_ean(text) IS 'POS bridge : produit vendable en caisse par EAN exact (1 ligne max). Appelable avec la clé anon.';

CREATE OR REPLACE FUNCTION public.pos_catalog_page(
  p_after_id uuid DEFAULT NULL,
  p_limit    int DEFAULT 5000,
  p_since    timestamptz DEFAULT NULL
)
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
  pos_price_tiers  jsonb,
  updated_at       timestamptz,
  pos_visible      boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
  -- Synchro complète (p_since NULL) : produits visibles uniquement.
  -- Synchro delta (p_since donné) : tout produit modifié depuis, y compris
  -- ceux devenus invisibles (pos_visible = false) pour permettre leur retrait local.
  SELECT c.id, c.name::text, c.brand::text, c.ean::text, c.image_url::text,
         c.price_ttc_cents, c.price_ht_cents, c.vat_rate, c.eco_tax_cents, c.stock_boutique::int, c.pos_price_tiers,
         c.updated_at, c.pos_visible
  FROM public.pos_catalog c
  WHERE (p_after_id IS NULL OR c.id > p_after_id)
    AND (
      (p_since IS NULL AND c.pos_visible)
      OR (p_since IS NOT NULL AND c.updated_at > p_since)
    )
  ORDER BY c.id
  LIMIT least(greatest(coalesce(p_limit, 5000), 1), 10000);
$$;
COMMENT ON FUNCTION public.pos_catalog_page(uuid, int, timestamptz) IS 'POS bridge : pagination keyset (id) du catalogue caisse pour le cache hors ligne ; p_since = delta (inclut les produits devenus invisibles). Appelable avec la clé anon.';

GRANT EXECUTE ON FUNCTION public.pos_search_products(text, int), public.pos_product_by_ean(text),
  public.pos_catalog_page(uuid, int, timestamptz) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pos_resolve_cart_prices : tarif négocié B2B par ligne via resolve_price()
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_resolve_cart_prices(p_account_id uuid, p_lines jsonb)
RETURNS TABLE (
  product_id            uuid,
  qty                   numeric,
  unit_price_ht_cents   bigint,
  unit_price_ttc_cents  bigint,
  vat_rate              numeric,
  rule_id               uuid,
  rule_scope            text,
  rule_mode             text,
  rule_value            numeric,
  public_price_ht_cents bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_lines","reason":"array expected"}'::jsonb);
  END IF;

  RETURN QUERY
    SELECT
      (e ->> 'product_id')::uuid,
      coalesce((e ->> 'qty')::numeric, 1),
      round(rp.unit_price_ht * 100)::bigint,
      round(rp.unit_price_ht * 100 * (1 + round(rp.vat_rate, 2) / 100))::bigint,
      round(rp.vat_rate, 2),
      rp.rule_id,
      rp.rule_scope::text,
      rp.rule_mode::text,
      rp.rule_value,
      round(rp.public_price_ht * 100)::bigint
    FROM jsonb_array_elements(p_lines) AS e
    LEFT JOIN LATERAL public.resolve_price(
      p_account_id,
      (e ->> 'product_id')::uuid,
      greatest(1, ceil(coalesce((e ->> 'qty')::numeric, 1)))::int
    ) AS rp ON true;
END;
$$;
COMMENT ON FUNCTION public.pos_resolve_cart_prices(uuid, jsonb) IS 'POS bridge (service role) : rejoue resolve_price() pour chaque {product_id, qty} ; prix HT/TTC en centimes (TTC = round(HT×100×(1+taux/100))). Ligne à NULL si produit inconnu.';

-- -----------------------------------------------------------------------------
-- Clients pro (customer_360 / client_quotes en RLS deny-all -> SECURITY DEFINER)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_customer_lookup(p_query text, p_limit int DEFAULT 10)
RETURNS TABLE (
  id                  uuid,
  display_name        text,
  company_name        text,
  siret               text,
  vat_number          text,
  kind                text,
  customer_type       text,
  payment_terms_days  int,
  pricing_rules_count int,
  open_quotes_count   int,
  revenue_ttc_12m     numeric,
  email               text,
  phone               text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_q text := btrim(coalesce(p_query, ''));
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF v_q = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT c.id,
           c.display_name::text,
           c.company_name::text,
           c.siret::text,
           c.vat_number::text,
           c.kind::text,
           c.customer_type::text,
           c.payment_terms_days::int,
           coalesce(c.pricing_rules_count, 0)::int,
           coalesce(c.open_quotes_count, 0)::int,
           coalesce(c.revenue_ttc_12m, 0)::numeric,
           c.email::text,
           c.phone::text
    FROM public.customer_360 c
    WHERE c.display_name ILIKE '%' || v_q || '%'
       OR c.company_name ILIKE '%' || v_q || '%'
       OR c.email        ILIKE '%' || v_q || '%'
       OR c.siret        ILIKE v_q || '%'
       OR c.phone        ILIKE '%' || v_q || '%'
    ORDER BY (c.kind = 'b2b') DESC, c.company_name NULLS LAST, c.display_name
    LIMIT least(greatest(coalesce(p_limit, 10), 1), 50);
END;
$$;
COMMENT ON FUNCTION public.pos_customer_lookup(text, int) IS 'POS bridge (service role) : recherche client (customer_360) par nom, société, email, SIRET, téléphone ; B2B en premier.';

CREATE OR REPLACE FUNCTION public.pos_customer_get(p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  SELECT jsonb_build_object(
           'id',                 c.id,
           'display_name',       c.display_name,
           'company_name',       c.company_name,
           'siret',              c.siret,
           'vat_number',         c.vat_number,
           'kind',               c.kind,
           'customer_type',      c.customer_type,
           'payment_terms_days', c.payment_terms_days,
           'email',              c.email,
           'phone',              c.phone)
  INTO v_result
  FROM public.customer_360 c
  WHERE c.id = p_account_id;
  RETURN v_result;   -- NULL si introuvable
END;
$$;
COMMENT ON FUNCTION public.pos_customer_get(uuid) IS 'POS bridge (service role) : fiche client (customer_360) pour la snapshot du ticket ; NULL si introuvable.';

CREATE OR REPLACE FUNCTION public.pos_customer_open_quotes(p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'quote_id',     q.id,
           'quote_number', q.quote_number,
           'status',       q.status,
           'valid_until',  q.valid_until,
           'subtotal_ht',  q.subtotal_ht,
           'vat_amount',   q.vat_amount,
           'total_ttc',    q.total_ttc,
           'created_at',   q.created_at,
           'items',        coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'product_id',       i.product_id,
                      'label',            i.product_name_snapshot,
                      'quantity',         i.quantity,
                      'unit_price_ht',    i.unit_price_ht,
                      'unit_price_ttc',   i.unit_price_ttc,
                      'discount_percent', coalesce(i.discount_percent, 0),
                      'vat_rate',         round(coalesce(i.vat_rate_snapshot, p.tva_rate, 20), 2),
                      'sort_order',       i.sort_order
                    ) ORDER BY i.sort_order, i.id)
             FROM public.client_quote_items i
             LEFT JOIN public.products p ON p.id = i.product_id
             WHERE i.quote_id = q.id
           ), '[]'::jsonb)
         ) ORDER BY q.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM public.client_quotes q
  WHERE q.customer_id = p_account_id
    AND q.status IN ('sent', 'draft');

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_customer_open_quotes(uuid) IS 'POS bridge (service role) : devis ouverts (draft, sent) d''un compte client avec leurs lignes (vat_rate = snapshot ou tva produit ou 20).';

-- -----------------------------------------------------------------------------
-- Stock boutique : journal idempotent + application des mouvements de la caisse
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_stock_movements (
  id              bigserial   PRIMARY KEY,
  idempotency_key text        NOT NULL UNIQUE,                  -- Pos : transaction_id:line_no ; ajustement : uuid
  product_id      uuid        NOT NULL REFERENCES public.products (id),
  qty_delta       int         NOT NULL,
  stock_before    int         NOT NULL,
  stock_after     int         NOT NULL,
  went_negative   boolean     NOT NULL DEFAULT false,
  transaction_ref text,                                         -- code ticket (texte libre) ou NULL
  reason          text        NOT NULL,                         -- pos_sale | pos_refund | adjustment | inventory ...
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pos_stock_movements IS 'POS bridge : mouvements de products.stock_boutique appliqués par la caisse (idempotents par idempotency_key, stock négatif toléré et tracé).';
CREATE INDEX IF NOT EXISTS pos_stock_movements_product_idx ON public.pos_stock_movements (product_id, created_at);
ALTER TABLE public.pos_stock_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_stock_movements FROM anon, authenticated;
DROP POLICY IF EXISTS pos_stock_movements_admin_select ON public.pos_stock_movements;
CREATE POLICY pos_stock_movements_admin_select ON public.pos_stock_movements
  FOR SELECT TO authenticated USING (public.is_admin());
GRANT SELECT ON public.pos_stock_movements TO authenticated;

CREATE OR REPLACE FUNCTION public.pos_apply_stock_movements(p_movements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_m        jsonb;
  v_key      text;
  v_pid      uuid;
  v_delta    int;
  v_ref      text;
  v_reason   text;
  v_before   int;
  v_after    int;
  v_existing public.pos_stock_movements;
  v_result   jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF p_movements IS NULL OR jsonb_typeof(p_movements) <> 'array' THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_movements","reason":"array expected"}'::jsonb);
  END IF;

  FOR v_m IN SELECT * FROM jsonb_array_elements(p_movements) LOOP
    v_key    := nullif(btrim(coalesce(v_m ->> 'idempotency_key', '')), '');
    v_ref    := nullif(v_m ->> 'transaction_ref', '');
    v_reason := coalesce(nullif(v_m ->> 'reason', ''), 'pos');
    BEGIN
      v_pid   := (v_m ->> 'product_id')::uuid;
      v_delta := (v_m ->> 'qty_delta')::int;
    EXCEPTION WHEN OTHERS THEN
      v_pid := NULL; v_delta := NULL;
    END;

    IF v_key IS NULL OR v_pid IS NULL OR v_delta IS NULL THEN
      v_result := v_result || jsonb_build_object('idempotency_key', v_key, 'applied', false, 'error', 'VALIDATION');
      CONTINUE;
    END IF;

    -- Sérialise les appels concurrents sur la même clé
    PERFORM pg_advisory_xact_lock(hashtext('pos_stock_movement:' || v_key));

    SELECT * INTO v_existing FROM public.pos_stock_movements m WHERE m.idempotency_key = v_key;
    IF FOUND THEN
      v_result := v_result || jsonb_build_object(
        'idempotency_key', v_key, 'applied', false, 'already_applied', true,
        'stock_after', v_existing.stock_after, 'went_negative', v_existing.went_negative);
      CONTINUE;
    END IF;

    SELECT coalesce(p.stock_boutique, 0) INTO v_before FROM public.products p WHERE p.id = v_pid FOR UPDATE;
    IF NOT FOUND THEN
      v_result := v_result || jsonb_build_object('idempotency_key', v_key, 'applied', false, 'error', 'PRODUCT_NOT_FOUND');
      CONTINUE;
    END IF;

    -- stock_boutique uniquement (jamais stock_online) ; négatif toléré
    UPDATE public.products p SET stock_boutique = v_before + v_delta WHERE p.id = v_pid
    RETURNING p.stock_boutique INTO v_after;

    INSERT INTO public.pos_stock_movements (idempotency_key, product_id, qty_delta, stock_before, stock_after, went_negative, transaction_ref, reason, created_by)
    VALUES (v_key, v_pid, v_delta, v_before, v_after, v_after < 0, v_ref, v_reason, auth.uid());

    v_result := v_result || jsonb_build_object(
      'idempotency_key', v_key, 'applied', true, 'stock_before', v_before, 'stock_after', v_after, 'went_negative', v_after < 0);
  END LOOP;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_apply_stock_movements(jsonb) IS 'POS bridge (service role) : applique sur products.stock_boutique les mouvements [{idempotency_key, product_id, qty_delta, transaction_ref?, reason?}] non encore appliqués ; renvoie [{idempotency_key, applied, stock_after, went_negative, error?}].';

CREATE OR REPLACE FUNCTION public.pos_adjust_stock_boutique(p_product_id uuid, p_delta int, p_reason text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_before int;
  v_after  int;
BEGIN
  IF NOT (public.pos_bridge_is_service_role() OR coalesce(public.is_admin(), false)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE';
  END IF;
  IF p_delta IS NULL OR p_delta = 0 THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_delta","reason":"non-zero integer required"}'::jsonb);
  END IF;
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_reason","reason":"required"}'::jsonb);
  END IF;

  SELECT coalesce(p.stock_boutique, 0) INTO v_before FROM public.products p WHERE p.id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.pos_bridge_error('PRODUCT_NOT_FOUND', jsonb_build_object('product_id', p_product_id));
  END IF;

  UPDATE public.products p SET stock_boutique = v_before + p_delta WHERE p.id = p_product_id
  RETURNING p.stock_boutique INTO v_after;

  INSERT INTO public.pos_stock_movements (idempotency_key, product_id, qty_delta, stock_before, stock_after, went_negative, transaction_ref, reason, created_by)
  VALUES (gen_random_uuid()::text, p_product_id, p_delta, v_before, v_after, v_after < 0, NULL, btrim(p_reason), auth.uid());

  RETURN v_after;
END;
$$;
COMMENT ON FUNCTION public.pos_adjust_stock_boutique(uuid, int, text) IS 'POS bridge (admin ma-papeterie ou service role) : ajuste products.stock_boutique (inventaire, correction) avec mouvement tracé. Retourne le stock après.';

-- -----------------------------------------------------------------------------
-- Droits d'exécution : PUBLIC et anon n'exécutent que les lectures catalogue ;
-- les autres fonctions sont réservées à authenticated / service_role (contrôle
-- service role à l'intérieur).
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.pos_bridge_is_service_role(), public.pos_bridge_require_service_role(), public.pos_bridge_error(text, jsonb),
  public.pos_resolve_cart_prices(uuid, jsonb), public.pos_customer_lookup(text, int), public.pos_customer_get(uuid),
  public.pos_customer_open_quotes(uuid), public.pos_apply_stock_movements(jsonb), public.pos_adjust_stock_boutique(uuid, int, text)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.pos_bridge_is_service_role(), public.pos_bridge_require_service_role(), public.pos_bridge_error(text, jsonb),
  public.pos_resolve_cart_prices(uuid, jsonb), public.pos_customer_lookup(text, int), public.pos_customer_get(uuid),
  public.pos_customer_open_quotes(uuid), public.pos_apply_stock_movements(jsonb), public.pos_adjust_stock_boutique(uuid, int, text)
TO authenticated, service_role;
