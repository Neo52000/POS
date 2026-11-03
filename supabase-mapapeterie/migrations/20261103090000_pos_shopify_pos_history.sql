-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — historique Shopify POS consultable en caisse
-- -----------------------------------------------------------------------------
-- Ventes de l'ancienne caisse Shopify POS (avant la bascule NF525), affichées en
-- lecture seule dans l'Historique de la caisse.
--
-- HORS PÉRIMÈTRE FISCAL : lecture de `shopify_orders` uniquement ; rien n'est
-- écrit, ni ici ni dans la base fiscale Pos. La valeur fiscale de ces ventes reste
-- dans les archives Shopify.
--
-- Même définition que le canal `pos` de v_admin_revenue_daily (dashboard /admin) :
--   * raw_payload ->> 'source_name' = 'pos' ;
--   * CA : financial_status ∉ (voided, refunded) ; commandes de test et annulées
--     exclues de la liste comme du CA.
-- Les commandes remboursées restent listées (statut visible), hors CA.
--
--   * pos_shopify_pos_days()        : jours ayant des ventes Shopify POS, du plus
--                                     récent au plus ancien, avec totaux (centimes).
--   * pos_shopify_pos_day(p_date)   : commandes d'un jour (Europe/Paris) avec lignes.
-- SECURITY DEFINER, réservées au service role. Idempotent.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pos_shopify_pos_days()
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

  SELECT coalesce(jsonb_agg(d.doc ORDER BY d.day DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT (o.shopify_created_at AT TIME ZONE 'Europe/Paris')::date AS day,
           jsonb_build_object(
             'date',            (o.shopify_created_at AT TIME ZONE 'Europe/Paris')::date,
             'orders',          count(*),
             'total_ttc_cents', round(coalesce(sum(o.total_ttc), 0) * 100)::bigint,
             'total_tax_cents', round(coalesce(sum(o.total_tax), 0) * 100)::bigint
           ) AS doc
    FROM public.shopify_orders o
    WHERE o.raw_payload ->> 'source_name' = 'pos'
      AND coalesce(o.financial_status, '') NOT IN ('voided', 'refunded')
      AND coalesce((o.raw_payload ->> 'test')::boolean, false) = false
      AND nullif(o.raw_payload ->> 'cancelled_at', '') IS NULL
    GROUP BY 1
  ) d;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_shopify_pos_days() IS
  'POS bridge (hors fiscal) : jours de ventes Shopify POS (canal pos du dashboard), totaux en centimes, du plus récent au plus ancien.';

CREATE OR REPLACE FUNCTION public.pos_shopify_pos_day(p_date date)
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
  IF p_date IS NULL THEN
    RAISE EXCEPTION 'VALIDATION' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(x.doc ORDER BY x.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT o.shopify_created_at AS created_at,
           jsonb_build_object(
             'id',                   o.id,
             'name',                 coalesce(o.shopify_order_name, '#' || o.shopify_order_number),
             'created_at',           o.shopify_created_at,
             'financial_status',     o.financial_status,
             'total_ttc_cents',      round(coalesce(o.total_ttc, 0) * 100)::bigint,
             'total_tax_cents',      round(coalesce(o.total_tax, 0) * 100)::bigint,
             'total_discount_cents', round(coalesce(o.total_discount, 0) * 100)::bigint,
             'payment_methods',      coalesce(o.raw_payload -> 'payment_gateway_names', '[]'::jsonb),
             'customer_name',        nullif(trim(concat_ws(' ', o.customer_first_name, o.customer_last_name)), ''),
             'lines', coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'title',       coalesce(li ->> 'title', li ->> 'name'),
                        'sku',         li ->> 'sku',
                        'qty',         coalesce((li ->> 'quantity')::numeric, 0),
                        'price_cents', round(coalesce((li ->> 'price')::numeric, 0) * 100)::bigint,
                        'discount_cents', round(coalesce((li ->> 'total_discount')::numeric, 0) * 100)::bigint
                      ) ORDER BY ord)
               FROM jsonb_array_elements(coalesce(o.line_items, '[]'::jsonb)) WITH ORDINALITY AS l(li, ord)
             ), '[]'::jsonb)
           ) AS doc
    FROM public.shopify_orders o
    WHERE o.raw_payload ->> 'source_name' = 'pos'
      AND (o.shopify_created_at AT TIME ZONE 'Europe/Paris')::date = p_date
      AND coalesce(o.financial_status, '') <> 'voided'
      AND coalesce((o.raw_payload ->> 'test')::boolean, false) = false
      AND nullif(o.raw_payload ->> 'cancelled_at', '') IS NULL
  ) x;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_shopify_pos_day(date) IS
  'POS bridge (hors fiscal) : commandes Shopify POS d''un jour (Europe/Paris) avec lignes ; remboursées incluses (statut), annulées / voided / test exclues.';

REVOKE EXECUTE ON FUNCTION public.pos_shopify_pos_days(), public.pos_shopify_pos_day(date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_shopify_pos_days(), public.pos_shopify_pos_day(date)
  TO service_role;
