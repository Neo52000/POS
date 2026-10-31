-- =============================================================================
-- POS NF525 — test SQL (projet « ma-papeterie ») : lots préparés au back-office
-- -----------------------------------------------------------------------------
-- admin_create_pos_order_group / admin_cancel_pos_order_group /
-- pos_customer_open_orders.prepared_group : droits, refus métier, lot exposé à
-- la caisse, remplacement, disparition après règlement partiel, annulation.
-- Aucun effet persistant (exception ALL_OK). Nécessite un compte (hors Client
-- passage) ayant au moins deux commandes encaissables.
-- =============================================================================
DO $$
DECLARE
  v_acc  uuid;
  v_o1   uuid;
  v_o2   uuid;
  v_g    uuid;
  v_g2   uuid;
  v_open jsonb;
BEGIN
  IF has_function_privilege('authenticated', 'public.admin_create_pos_order_group(uuid, uuid[], boolean, uuid)', 'EXECUTE')
     OR has_table_privilege('anon', 'public.pos_order_groups', 'SELECT') THEN
    RAISE EXCEPTION 'lots exposés aux clients';
  END IF;
  SELECT a.id INTO v_acc FROM public.customer_accounts a
  WHERE NOT coalesce(a.is_passage, false)
    AND (SELECT count(*) FROM public.sales_orders so WHERE public.pos_order_is_cashable(so.id, a.id)) >= 2
  LIMIT 1;
  IF v_acc IS NULL THEN RAISE EXCEPTION 'aucun compte avec 2 commandes encaissables pour le test'; END IF;
  SELECT so.id INTO v_o1 FROM public.sales_orders so WHERE public.pos_order_is_cashable(so.id, v_acc) LIMIT 1;
  SELECT so.id INTO v_o2 FROM public.sales_orders so
  WHERE so.id <> v_o1 AND public.pos_order_is_cashable(so.id, v_acc) LIMIT 1;

  -- 1. refus métier
  BEGIN PERFORM public.admin_create_pos_order_group(v_acc, ARRAY[v_o1]); RAISE EXCEPTION 'X';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%VALIDATION%' THEN RAISE EXCEPTION 'VALIDATION attendu : %', SQLERRM; END IF; END;
  BEGIN PERFORM public.admin_create_pos_order_group(v_acc, ARRAY[v_o1, gen_random_uuid()]); RAISE EXCEPTION 'X';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%ORDER_NOT_CASHABLE%' THEN RAISE EXCEPTION 'ORDER_NOT_CASHABLE attendu : %', SQLERRM; END IF; END;

  -- 2. lot exposé à la caisse sur ses deux commandes
  v_g := public.admin_create_pos_order_group(v_acc, ARRAY[v_o1, v_o2], true, NULL);
  v_open := public.pos_customer_open_orders(v_acc);
  IF (SELECT count(*) FROM jsonb_array_elements(v_open) e WHERE (e -> 'prepared_group' ->> 'id')::uuid = v_g) <> 2 THEN
    RAISE EXCEPTION 'prepared_group absent : %', v_open;
  END IF;

  -- 3. un nouveau lot sur les mêmes commandes remplace l'ancien
  v_g2 := public.admin_create_pos_order_group(v_acc, ARRAY[v_o2, v_o1], false, NULL);
  IF (SELECT cancelled_at FROM public.pos_order_groups WHERE id = v_g) IS NULL THEN RAISE EXCEPTION 'lot non remplacé'; END IF;

  -- 4. une commande réglée en caisse : le lot n'est plus proposé
  PERFORM public.pos_settle_orders(jsonb_build_array(jsonb_build_object(
    'transaction_id', gen_random_uuid(), 'order_id', v_o1, 'customer_account_id', v_acc,
    'total_ttc_cents', 100, 'business_at', now())));
  v_open := public.pos_customer_open_orders(v_acc);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_open) e WHERE e -> 'prepared_group' <> 'null'::jsonb) THEN
    RAISE EXCEPTION 'lot proposé après règlement partiel';
  END IF;

  -- 5. annulation (une seule fois)
  IF NOT public.admin_cancel_pos_order_group(v_g2, v_acc) OR public.admin_cancel_pos_order_group(v_g2, v_acc) THEN
    RAISE EXCEPTION 'annulation incorrecte';
  END IF;

  RAISE EXCEPTION 'ALL_OK';
END;
$$;
