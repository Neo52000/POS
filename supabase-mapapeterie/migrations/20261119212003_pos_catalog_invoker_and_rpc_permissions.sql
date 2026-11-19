-- POS catalogue security hardening (2026-11-19).
-- Mirror of ma-papeterie-v1/supabase/migrations/20261119212003_pos_catalog_invoker_and_rpc_permissions.sql.
-- The PWA intentionally reads catalogue RPCs with the public anon key.
-- Keep those read-only endpoints available; harden the underlying view and
-- remove unnecessary direct write / service-only RPC grants.
--
-- pos_catalog_page, pos_search_products and pos_product_by_ean remain readable
-- by anon/authenticated because Neo52000/POS uses them from the PWA.
-- Customer, negotiated-price and stock bridge RPCs are called by POS Edge
-- Functions with MAPAP_SERVICE_ROLE_KEY, never with a seller JWT.
--
-- pos_adjust_stock_boutique is intentionally excluded: it has an explicit
-- is_admin() guard and authenticated admin access is part of the POS workflow.

ALTER VIEW public.pos_catalog SET (security_invoker = true);

REVOKE INSERT, UPDATE, DELETE ON TABLE public.pos_catalog
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.pos_apply_stock_movements(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_bridge_error(text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_bridge_is_service_role()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_bridge_require_service_role()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_customer_get(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_customer_lookup(text, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_customer_open_orders(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_customer_open_quotes(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_resolve_cart_prices(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_set_stock_boutique(uuid, integer, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_settle_orders(jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.pos_apply_stock_movements(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_bridge_error(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_bridge_is_service_role() TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_bridge_require_service_role() TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_customer_get(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_customer_lookup(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_customer_open_orders(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_customer_open_quotes(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_resolve_cart_prices(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_set_stock_boutique(uuid, integer, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_settle_orders(jsonb) TO service_role;

DO $verification$
DECLARE
  v_options text[];
  v_fn text;
  v_service_only text[] := ARRAY[
    'public.pos_apply_stock_movements(jsonb)',
    'public.pos_bridge_error(text,jsonb)',
    'public.pos_bridge_is_service_role()',
    'public.pos_bridge_require_service_role()',
    'public.pos_customer_get(uuid)',
    'public.pos_customer_lookup(text,integer)',
    'public.pos_customer_open_orders(uuid)',
    'public.pos_customer_open_quotes(uuid)',
    'public.pos_resolve_cart_prices(uuid,jsonb)',
    'public.pos_set_stock_boutique(uuid,integer,text,text)',
    'public.pos_settle_orders(jsonb)'
  ];
BEGIN
  SELECT reloptions INTO v_options
  FROM pg_class
  WHERE oid = 'public.pos_catalog'::regclass;

  IF NOT coalesce(v_options @> ARRAY['security_invoker=true'], false) THEN
    RAISE EXCEPTION 'pos_catalog must use security_invoker=true';
  END IF;

  IF NOT has_table_privilege('anon', 'public.pos_catalog', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.pos_catalog', 'SELECT') THEN
    RAISE EXCEPTION 'POS catalogue SELECT access must remain available';
  END IF;

  IF has_table_privilege('anon', 'public.pos_catalog', 'INSERT')
     OR has_table_privilege('anon', 'public.pos_catalog', 'UPDATE')
     OR has_table_privilege('anon', 'public.pos_catalog', 'DELETE')
     OR has_table_privilege('authenticated', 'public.pos_catalog', 'INSERT')
     OR has_table_privilege('authenticated', 'public.pos_catalog', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pos_catalog', 'DELETE') THEN
    RAISE EXCEPTION 'pos_catalog must be read-only for anon and authenticated';
  END IF;

  IF NOT has_function_privilege('anon', 'public.pos_catalog_page(uuid,integer,timestamp with time zone)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.pos_search_products(text,integer)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.pos_product_by_ean(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Public POS catalogue read RPCs must remain available';
  END IF;

  FOREACH v_fn IN ARRAY v_service_only LOOP
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role must retain EXECUTE on %', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service-only RPC still exposed to anon/authenticated: %', v_fn;
    END IF;
  END LOOP;

  IF NOT has_function_privilege('authenticated', 'public.pos_adjust_stock_boutique(uuid,integer,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated admin stock adjustment grant must remain intact';
  END IF;
END;
$verification$;
