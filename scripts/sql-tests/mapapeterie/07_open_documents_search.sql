-- =============================================================================
-- POS NF525 — test SQL (projet « ma-papeterie ») : pos_open_documents_search
-- Recherche par n° de commande / nom, résultat par client, exclusion d'une
-- commande déjà réglée, droits. Aucun effet persistant : exception ALL_OK finale.
-- =============================================================================
DO $$
DECLARE
  v_acc  uuid;
  v_a    uuid;
  v_b    uuid;
  v_la   uuid;
  v_lb   uuid;
  v_no_a text;
  v_res  jsonb;
  v_row  jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.pos_open_documents_search(text, int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_open_documents_search(text, int)', 'EXECUTE') THEN
    RAISE EXCEPTION 'droits trop ouverts';
  END IF;

  INSERT INTO public.customer_accounts (email, display_name)
    VALUES ('pos-search-test@example.com', 'Zzrecherche Testeur') RETURNING id INTO v_acc;
  INSERT INTO public.sales_orders (account_id, customer_email, origin, status)
    VALUES (v_acc, 'pos-search-test@example.com', 'erp', 'confirmed') RETURNING id, order_number INTO v_a, v_no_a;
  INSERT INTO public.sales_order_lines (order_id, label, qty, unit_price_ht, vat_rate, line_total_ht)
    VALUES (v_a, 'Ligne A', 2, 10, 20, 20) RETURNING id INTO v_la;
  INSERT INTO public.sales_orders (account_id, customer_email, origin, status)
    VALUES (v_acc, 'pos-search-test@example.com', 'erp', 'confirmed') RETURNING id INTO v_b;
  INSERT INTO public.sales_order_lines (order_id, label, qty, unit_price_ht, vat_rate, line_total_ht)
    VALUES (v_b, 'Ligne B', 1, 7, 20, 7) RETURNING id INTO v_lb;

  -- Par nom : un résultat, 2 commandes, 32,40 € TTC (20×1,2 + 7×1,2)
  v_res := public.pos_open_documents_search('Zzrecherche', 10);
  IF jsonb_array_length(v_res) <> 1 THEN RAISE EXCEPTION 'recherche par nom KO : %', v_res; END IF;
  v_row := v_res -> 0;
  IF v_row ->> 'owner_kind' <> 'account' OR (v_row ->> 'orders_count')::int <> 2
     OR (v_row ->> 'open_ttc')::numeric <> 32.40 THEN
    RAISE EXCEPTION 'ligne résultat KO : %', v_row;
  END IF;

  -- Par n° de commande
  IF v_no_a IS NOT NULL THEN
    v_res := public.pos_open_documents_search(v_no_a, 10);
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res) e WHERE (e ->> 'account_id')::uuid = v_acc) THEN
      RAISE EXCEPTION 'recherche par n° KO : %', v_res;
    END IF;
  END IF;

  -- Requête vide : liste complète, contient le client
  v_res := public.pos_open_documents_search(NULL, 50);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res) e WHERE (e ->> 'account_id')::uuid = v_acc) THEN
    RAISE EXCEPTION 'liste complète KO';
  END IF;

  -- Commande A réglée en caisse : il ne reste que B
  PERFORM public.pos_settle_documents(jsonb_build_array(jsonb_build_object(
    'transaction_id', gen_random_uuid(), 'customer_account_id', v_acc, 'business_at', now(),
    'lines', jsonb_build_array(jsonb_build_object('sales_order_line_id', v_la, 'qty', 2)))));
  v_res := public.pos_open_documents_search('Zzrecherche', 10);
  IF (v_res -> 0 ->> 'orders_count')::int <> 1 THEN RAISE EXCEPTION 'après règlement KO : %', v_res; END IF;

  -- Plus rien à encaisser : le client disparaît
  PERFORM public.pos_settle_documents(jsonb_build_array(jsonb_build_object(
    'transaction_id', gen_random_uuid(), 'customer_account_id', v_acc, 'business_at', now(),
    'lines', jsonb_build_array(jsonb_build_object('sales_order_line_id', v_lb, 'qty', 1)))));
  IF jsonb_array_length(public.pos_open_documents_search('Zzrecherche', 10)) <> 0 THEN
    RAISE EXCEPTION 'client soldé encore listé';
  END IF;

  -- Un seul caractère : VALIDATION
  BEGIN
    PERFORM public.pos_open_documents_search('z', 10);
    RAISE EXCEPTION 'VALIDATION attendue';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'VALIDATION attendue' THEN RAISE; END IF;
  END;

  RAISE EXCEPTION 'ALL_OK';
END;
$$;
