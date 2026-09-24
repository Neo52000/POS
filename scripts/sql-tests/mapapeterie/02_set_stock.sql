-- =============================================================================
-- POS NF525 — test SQL (projet « ma-papeterie ») : inventaire (lot 6)
-- -----------------------------------------------------------------------------
-- pos_set_stock_boutique : valeur absolue, mouvement tracé (reason inventory:),
-- delta 0 accepté, idempotence par clé, validations, produit inconnu, droits.
-- Effet sur les données : 3 mouvements de test conservés ; stock_boutique du
-- produit de test revient à sa valeur initiale.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_product uuid;
  v_stock0  int;
  v_key1    text := 'inv-test-' || gen_random_uuid()::text;
  v_key2    text := 'inv-test-' || gen_random_uuid()::text;
  v_key3    text := 'inv-test-' || gen_random_uuid()::text;
  v_res     jsonb;
  v_online0 int;
BEGIN
  IF has_function_privilege('anon', 'public.pos_set_stock_boutique(uuid, int, text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon ne doit pas exécuter pos_set_stock_boutique';
  END IF;
  SELECT c.id INTO v_product FROM public.pos_catalog c WHERE c.pos_visible ORDER BY c.ean NULLS LAST LIMIT 1;
  SELECT coalesce(stock_boutique, 0), stock_online INTO v_stock0, v_online0 FROM public.products WHERE id = v_product;
  INSERT INTO pos_test_results VALUES ('grants', true, 'anon refusé ; produit ' || v_product || ', stock initial ' || v_stock0);

  -- 1. comptage conforme : delta 0 tracé
  v_res := public.pos_set_stock_boutique(v_product, v_stock0, 'test inventaire conforme', v_key1);
  IF NOT (v_res ->> 'applied')::boolean OR (v_res ->> 'delta')::int <> 0 OR (v_res ->> 'stock_after')::int <> v_stock0 THEN
    RAISE EXCEPTION 'comptage conforme incorrect : %', v_res;
  END IF;
  -- 2. comptage +3
  v_res := public.pos_set_stock_boutique(v_product, v_stock0 + 3, 'test inventaire +3', v_key2);
  IF (v_res ->> 'delta')::int <> 3 OR (v_res ->> 'stock_before')::int <> v_stock0
     OR (SELECT stock_boutique FROM public.products WHERE id = v_product) <> v_stock0 + 3 THEN
    RAISE EXCEPTION 'comptage +3 incorrect : %', v_res;
  END IF;
  -- 3. rejeu de la même clé avec une autre valeur : ignoré
  v_res := public.pos_set_stock_boutique(v_product, 999, 'rejeu', v_key2);
  IF (v_res ->> 'applied')::boolean OR NOT (v_res ->> 'already_applied')::boolean
     OR (SELECT stock_boutique FROM public.products WHERE id = v_product) <> v_stock0 + 3 THEN
    RAISE EXCEPTION 'rejeu non idempotent : %', v_res;
  END IF;
  INSERT INTO pos_test_results VALUES ('set_absolute', true, 'delta 0 tracé, +3 appliqué, rejeu ignoré');

  -- 4. validations
  BEGIN
    PERFORM public.pos_set_stock_boutique(v_product, -1, 'x', 'inv-test-negative');
    RAISE EXCEPTION 'VALIDATION attendu (compté négatif)';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_set_stock_boutique(v_product, 1, 'x', 'court');
    RAISE EXCEPTION 'VALIDATION attendu (clé courte)';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_set_stock_boutique(gen_random_uuid(), 1, 'x', 'inv-test-unknown-product');
    RAISE EXCEPTION 'PRODUCT_NOT_FOUND attendu';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'PRODUCT_NOT_FOUND' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('validation', true, 'négatif, clé courte, produit inconnu refusés');

  -- 5. retour à l'état initial + traces
  PERFORM public.pos_set_stock_boutique(v_product, v_stock0, 'test inventaire retour', v_key3);
  IF (SELECT coalesce(stock_boutique, 0) FROM public.products WHERE id = v_product) <> v_stock0
     OR (SELECT stock_online FROM public.products WHERE id = v_product) IS DISTINCT FROM v_online0
     OR (SELECT count(*) FROM public.pos_stock_movements WHERE idempotency_key IN (v_key1, v_key2, v_key3) AND reason LIKE 'inventory: %') <> 3 THEN
    RAISE EXCEPTION 'état final incorrect';
  END IF;
  INSERT INTO pos_test_results VALUES ('restore', true, 'stock boutique ' || v_stock0 || ' restauré, stock_online intact, 3 mouvements inventory');
END $$;

SELECT * FROM pos_test_results;
