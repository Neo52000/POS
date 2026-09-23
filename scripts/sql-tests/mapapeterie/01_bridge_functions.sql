-- =============================================================================
-- POS NF525 — test SQL (projet « ma-papeterie ») : fonctions bridge
-- -----------------------------------------------------------------------------
-- Exécution : une seule requête multi-statements (MCP execute_sql), en tant
-- qu'opérateur direct (service role implicite hors PostgREST).
-- Vérifie : signatures, droits (anon = catalogue seulement), recherche
-- catalogue, EAN, pagination, tarifs négociés, clients, devis,
-- pos_apply_stock_movements (idempotence, effet net nul), pos_adjust_stock_boutique.
-- Effet sur les données : mouvements pos_stock_movements de test (conservés) ;
-- stock_boutique du produit de test revient à sa valeur initiale.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_missing  text;
  v_expected text[];
  v_product  uuid;
  v_ean      text;
  v_name     text;
  v_stock0   int;
  v_stock    int;
  v_key1     text := 'test:' || gen_random_uuid()::text;
  v_key2     text := 'test:' || gen_random_uuid()::text;
  v_res      jsonb;
  v_customer uuid;
  v_n        int;
BEGIN
  -- 1. signatures
  v_expected := ARRAY[
    'pos_bridge_is_service_role()',
    'pos_bridge_require_service_role()',
    'pos_bridge_error(p_code text, p_detail jsonb)',
    'pos_search_products(p_query text, p_limit integer)',
    'pos_product_by_ean(p_ean text)',
    'pos_catalog_page(p_after_id uuid, p_limit integer, p_since timestamp with time zone)',
    'pos_resolve_cart_prices(p_account_id uuid, p_lines jsonb)',
    'pos_customer_lookup(p_query text, p_limit integer)',
    'pos_customer_get(p_account_id uuid)',
    'pos_customer_open_quotes(p_account_id uuid)',
    'pos_apply_stock_movements(p_movements jsonb)',
    'pos_adjust_stock_boutique(p_product_id uuid, p_delta integer, p_reason text)'
  ];
  SELECT string_agg(e, E'\n') INTO v_missing
  FROM unnest(v_expected) e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = e);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION E'fonctions manquantes ou signature différente :\n%', v_missing;
  END IF;
  IF to_regclass('public.pos_catalog') IS NULL OR to_regclass('public.pos_stock_movements') IS NULL THEN
    RAISE EXCEPTION 'pos_catalog / pos_stock_movements manquants';
  END IF;
  INSERT INTO pos_test_results VALUES ('functions', true, array_length(v_expected, 1) || ' signatures, vue pos_catalog, table pos_stock_movements');

  -- 2. droits : anon = catalogue uniquement
  IF NOT has_function_privilege('anon', 'public.pos_search_products(text, int)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.pos_product_by_ean(text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.pos_catalog_page(uuid, int, timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_apply_stock_movements(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_customer_lookup(text, int)', 'EXECUTE')
     OR has_table_privilege('anon', 'public.pos_stock_movements', 'SELECT') THEN
    RAISE EXCEPTION 'droits anon incorrects';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.products'::regclass AND tgname ILIKE '%pos%') THEN
    RAISE EXCEPTION 'un trigger pos_* existe sur products (interdit)';
  END IF;
  INSERT INTO pos_test_results VALUES ('grants', true, 'anon : lectures catalogue seulement ; aucun trigger POS sur products');

  -- 3. catalogue
  SELECT c.id, c.ean, c.name INTO v_product, v_ean, v_name
  FROM public.pos_catalog c WHERE c.pos_visible AND c.ean ~ '^\d{8,14}$'
  ORDER BY c.ean LIMIT 1;
  IF v_product IS NULL THEN
    RAISE EXCEPTION 'aucun produit vendable en caisse avec EAN numérique';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_search_products(v_ean) s WHERE s.id = v_product) THEN
    RAISE EXCEPTION 'pos_search_products(EAN) ne trouve pas %', v_ean;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_search_products(split_part(v_name, ' ', 1), 50) s WHERE s.id = v_product) THEN
    RAISE EXCEPTION 'pos_search_products(texte) ne trouve pas "%"', split_part(v_name, ' ', 1);
  END IF;
  IF (SELECT count(*) FROM public.pos_product_by_ean(v_ean)) <> 1
     OR (SELECT p.price_ttc_cents FROM public.pos_product_by_ean(v_ean) p) IS NULL
     OR (SELECT p.vat_rate FROM public.pos_product_by_ean(v_ean) p) NOT IN (0, 2.10, 5.50, 10.00, 20.00) THEN
    RAISE EXCEPTION 'pos_product_by_ean incohérent pour %', v_ean;
  END IF;
  IF (SELECT count(*) FROM public.pos_catalog_page(NULL, 10, NULL)) < 1
     OR EXISTS (SELECT 1 FROM public.pos_catalog_page(NULL, 100, NULL) p WHERE NOT p.pos_visible) THEN
    RAISE EXCEPTION 'pos_catalog_page : synchro complète incorrecte';
  END IF;
  IF (SELECT count(*) FROM public.pos_search_products('')) <> 0 THEN
    RAISE EXCEPTION 'pos_search_products('''') devrait être vide';
  END IF;
  INSERT INTO pos_test_results VALUES ('catalog', true, 'EAN ' || v_ean || ' (' || left(v_name, 30) || ') : recherche, ean, page');

  -- 4. tarifs négociés (structure ; la valeur dépend des règles du client)
  SELECT id INTO v_customer FROM public.customer_360 ORDER BY (kind = 'b2b') DESC, display_name LIMIT 1;
  IF v_customer IS NOT NULL THEN
    SELECT count(*) INTO v_n FROM public.pos_resolve_cart_prices(v_customer, jsonb_build_array(jsonb_build_object('product_id', v_product, 'qty', 2)));
    IF v_n <> 1 THEN RAISE EXCEPTION 'pos_resolve_cart_prices : 1 ligne attendue, %', v_n; END IF;
    IF (SELECT r.unit_price_ttc_cents FROM public.pos_resolve_cart_prices(v_customer, jsonb_build_array(jsonb_build_object('product_id', v_product, 'qty', 2))) r) IS NULL THEN
      RAISE EXCEPTION 'pos_resolve_cart_prices : prix TTC NULL pour un produit existant';
    END IF;
    IF public.pos_customer_get(v_customer) ->> 'id' <> v_customer::text THEN
      RAISE EXCEPTION 'pos_customer_get incohérent';
    END IF;
    IF public.pos_customer_get(gen_random_uuid()) IS NOT NULL THEN
      RAISE EXCEPTION 'pos_customer_get(inconnu) devrait être NULL';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_customer_lookup(left(coalesce((public.pos_customer_get(v_customer) ->> 'display_name'), 'x'), 4), 50) l WHERE l.id = v_customer) THEN
      RAISE EXCEPTION 'pos_customer_lookup ne trouve pas le client';
    END IF;
    IF jsonb_typeof(public.pos_customer_open_quotes(v_customer)) <> 'array' THEN
      RAISE EXCEPTION 'pos_customer_open_quotes doit renvoyer un tableau';
    END IF;
    INSERT INTO pos_test_results VALUES ('customers', true, 'resolve_cart_prices, customer_get, customer_lookup, open_quotes sur ' || v_customer);
  ELSE
    INSERT INTO pos_test_results VALUES ('customers', true, 'ignoré : customer_360 vide');
  END IF;

  -- 5. mouvements de stock idempotents (effet net nul)
  SELECT coalesce(stock_boutique, 0) INTO v_stock0 FROM public.products WHERE id = v_product;
  v_res := public.pos_apply_stock_movements(jsonb_build_array(
    jsonb_build_object('idempotency_key', v_key1, 'product_id', v_product, 'qty_delta', -2, 'transaction_ref', 'T-TEST-000001', 'reason', 'pos_sale'),
    jsonb_build_object('idempotency_key', 'test:bad', 'product_id', gen_random_uuid(), 'qty_delta', 1)));
  IF jsonb_array_length(v_res) <> 2
     OR NOT (v_res -> 0 ->> 'applied')::boolean OR (v_res -> 0 ->> 'stock_after')::int <> v_stock0 - 2
     OR (v_res -> 0 ->> 'went_negative')::boolean <> (v_stock0 - 2 < 0)
     OR (v_res -> 1 ->> 'applied')::boolean OR (v_res -> 1 ->> 'error') <> 'PRODUCT_NOT_FOUND' THEN
    RAISE EXCEPTION 'pos_apply_stock_movements : résultat inattendu %', v_res;
  END IF;
  SELECT coalesce(stock_boutique, 0) INTO v_stock FROM public.products WHERE id = v_product;
  IF v_stock <> v_stock0 - 2 THEN RAISE EXCEPTION 'stock après -2 : %', v_stock; END IF;
  -- rejeu de la même clé : non appliqué
  v_res := public.pos_apply_stock_movements(jsonb_build_array(jsonb_build_object('idempotency_key', v_key1, 'product_id', v_product, 'qty_delta', -2)));
  IF (v_res -> 0 ->> 'applied')::boolean OR NOT (v_res -> 0 ->> 'already_applied')::boolean OR (v_res -> 0 ->> 'stock_after')::int <> v_stock0 - 2 THEN
    RAISE EXCEPTION 'pos_apply_stock_movements : rejeu non idempotent %', v_res;
  END IF;
  SELECT coalesce(stock_boutique, 0) INTO v_stock FROM public.products WHERE id = v_product;
  IF v_stock <> v_stock0 - 2 THEN RAISE EXCEPTION 'stock modifié par le rejeu : %', v_stock; END IF;
  -- contre-mouvement
  v_res := public.pos_apply_stock_movements(jsonb_build_array(jsonb_build_object('idempotency_key', v_key2, 'product_id', v_product, 'qty_delta', 2, 'transaction_ref', 'T-TEST-000002', 'reason', 'pos_refund')));
  SELECT coalesce(stock_boutique, 0) INTO v_stock FROM public.products WHERE id = v_product;
  IF v_stock <> v_stock0 THEN RAISE EXCEPTION 'stock final : attendu %, obtenu %', v_stock0, v_stock; END IF;
  IF (SELECT count(*) FROM public.pos_stock_movements WHERE idempotency_key IN (v_key1, v_key2)) <> 2
     OR (SELECT transaction_ref FROM public.pos_stock_movements WHERE idempotency_key = v_key1) <> 'T-TEST-000001' THEN
    RAISE EXCEPTION 'pos_stock_movements : journal incomplet';
  END IF;
  INSERT INTO pos_test_results VALUES ('apply_stock_movements', true, 'stock ' || v_stock0 || ' -> ' || (v_stock0 - 2) || ' (rejeu ignoré) -> ' || v_stock0 || ' ; produit inconnu signalé');

  -- 6. ajustement manuel ±1
  IF public.pos_adjust_stock_boutique(v_product, 1, 'test inventaire +1') <> v_stock0 + 1
     OR public.pos_adjust_stock_boutique(v_product, -1, 'test inventaire -1') <> v_stock0 THEN
    RAISE EXCEPTION 'pos_adjust_stock_boutique incohérent';
  END IF;
  BEGIN
    PERFORM public.pos_adjust_stock_boutique(v_product, 0, 'x');
    RAISE EXCEPTION 'VALIDATION attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('adjust_stock', true, '+1 / -1 tracés, delta 0 refusé, stock final ' || v_stock0);
END $$;

SELECT * FROM pos_test_results;
