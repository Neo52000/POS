-- =============================================================================
-- POS NF525 — test SQL (projet « ma-papeterie ») : commandes ET BL à encaisser,
-- règlement groupé à la ligne
-- -----------------------------------------------------------------------------
-- pos_customer_open_documents (commande partiellement livrée → partie BL + partie
-- non livrée, sans double compte), pos_settle_documents (BL + commande sur un
-- ticket, rejeu idempotent, QTY_EXCEEDED, ACCOUNT_MISMATCH), blocage de fusion
-- 'pos_settled', droits. Aucun effet persistant : exception ALL_OK finale.
-- =============================================================================
DO $$
DECLARE
  v_acc   uuid;
  v_other uuid;
  v_a     uuid;
  v_b     uuid;
  v_l1    uuid;
  v_l2    uuid;
  v_lb    uuid;
  v_dn    uuid;
  v_dnl   uuid;
  v_docs  jsonb;
  v_res   jsonb;
  v_t1    uuid := gen_random_uuid();
BEGIN
  IF has_function_privilege('anon', 'public.pos_settle_documents(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_customer_open_documents(uuid)', 'EXECUTE')
     OR has_table_privilege('anon', 'public.pos_settled_lines', 'SELECT') THEN
    RAISE EXCEPTION 'droits trop ouverts';
  END IF;

  INSERT INTO public.customer_accounts (email, display_name)
    VALUES ('pos-docs-test@example.com', 'Test docs') RETURNING id INTO v_acc;
  INSERT INTO public.customer_accounts (email, display_name)
    VALUES ('pos-docs-other@example.com', 'Autre') RETURNING id INTO v_other;

  INSERT INTO public.sales_orders (account_id, customer_email, origin, status)
    VALUES (v_acc, 'pos-docs-test@example.com', 'erp', 'confirmed') RETURNING id INTO v_a;
  INSERT INTO public.sales_order_lines (order_id, label, qty, unit_price_ht, vat_rate, line_total_ht)
    VALUES (v_a, 'Ligne 1', 5, 10, 20, 50) RETURNING id INTO v_l1;
  INSERT INTO public.sales_order_lines (order_id, label, qty, unit_price_ht, vat_rate, line_total_ht)
    VALUES (v_a, 'Ligne 2', 2, 4, 20, 8) RETURNING id INTO v_l2;
  INSERT INTO public.sales_orders (account_id, customer_email, origin, status)
    VALUES (v_acc, 'pos-docs-test@example.com', 'erp', 'confirmed') RETURNING id INTO v_b;
  INSERT INTO public.sales_order_lines (order_id, label, qty, unit_price_ht, vat_rate, line_total_ht)
    VALUES (v_b, 'Ligne B', 1, 7, 20, 7) RETURNING id INTO v_lb;

  -- BL : 3 des 5 de la ligne 1
  INSERT INTO public.delivery_notes (order_id) VALUES (v_a) RETURNING id INTO v_dn;
  INSERT INTO public.delivery_note_lines (delivery_note_id, sales_order_line_id, label, qty_delivered)
    VALUES (v_dn, v_l1, 'Ligne 1', 3) RETURNING id INTO v_dnl;
  UPDATE public.sales_order_lines SET qty_delivered = 3 WHERE id = v_l1;

  v_docs := public.pos_customer_open_documents(v_acc);
  IF jsonb_array_length(v_docs -> 'orders') <> 2 OR jsonb_array_length(v_docs -> 'delivery_notes') <> 1 THEN
    RAISE EXCEPTION 'documents ouverts KO : %', v_docs;
  END IF;
  IF (SELECT (i ->> 'quantity')::numeric FROM jsonb_array_elements(v_docs -> 'delivery_notes' -> 0 -> 'items') i) <> 3 THEN
    RAISE EXCEPTION 'quantité BL KO : %', v_docs;
  END IF;
  IF (SELECT (i ->> 'quantity')::numeric
        FROM jsonb_array_elements(v_docs -> 'orders') o, jsonb_array_elements(o -> 'items') i
       WHERE (i ->> 'sales_order_line_id')::uuid = v_l1) <> 2 THEN
    RAISE EXCEPTION 'reste non livré ligne 1 KO : %', v_docs;
  END IF;

  -- Ticket 1 : BL (3) + commande B (1)
  v_res := public.pos_settle_documents(jsonb_build_array(jsonb_build_object(
    'transaction_id', v_t1, 'customer_account_id', v_acc, 'business_at', now(),
    'register_code', 'TEST-DOCS', 'ticket_number', 1,
    'lines', jsonb_build_array(
      jsonb_build_object('sales_order_line_id', v_l1, 'delivery_note_line_id', v_dnl, 'qty', 3),
      jsonb_build_object('sales_order_line_id', v_lb, 'qty', 1)))));
  IF NOT (v_res -> 0 ->> 'applied')::boolean THEN RAISE EXCEPTION 'règlement KO : %', v_res; END IF;

  v_docs := public.pos_customer_open_documents(v_acc);
  IF jsonb_array_length(v_docs -> 'orders') <> 1 OR jsonb_array_length(v_docs -> 'delivery_notes') <> 0 THEN
    RAISE EXCEPTION 'après règlement KO : %', v_docs;
  END IF;

  -- Rejeu idempotent
  v_res := public.pos_settle_documents(jsonb_build_array(jsonb_build_object(
    'transaction_id', v_t1, 'customer_account_id', v_acc, 'business_at', now(),
    'lines', jsonb_build_array(jsonb_build_object('sales_order_line_id', v_lb, 'qty', 1)))));
  IF NOT coalesce((v_res -> 0 ->> 'already_applied')::boolean, false) THEN
    RAISE EXCEPTION 'rejeu KO : %', v_res;
  END IF;

  -- Quantité au-delà de l'ouvert (2 restants sur la ligne 1) : refus, rien d'écrit
  v_res := public.pos_settle_documents(jsonb_build_array(jsonb_build_object(
    'transaction_id', gen_random_uuid(), 'customer_account_id', v_acc, 'business_at', now(),
    'lines', jsonb_build_array(
      jsonb_build_object('sales_order_line_id', v_l2, 'qty', 2),
      jsonb_build_object('sales_order_line_id', v_l1, 'qty', 5)))));
  IF v_res -> 0 ->> 'error' IS DISTINCT FROM 'QTY_EXCEEDED' THEN RAISE EXCEPTION 'QTY_EXCEEDED KO : %', v_res; END IF;
  IF (SELECT count(*) FROM public.pos_settled_lines WHERE sales_order_line_id = v_l2) <> 0 THEN
    RAISE EXCEPTION 'ticket refusé partiellement écrit';
  END IF;

  -- Mauvais client
  v_res := public.pos_settle_documents(jsonb_build_array(jsonb_build_object(
    'transaction_id', gen_random_uuid(), 'customer_account_id', v_other, 'business_at', now(),
    'lines', jsonb_build_array(jsonb_build_object('sales_order_line_id', v_l2, 'qty', 1)))));
  IF v_res -> 0 ->> 'error' IS DISTINCT FROM 'ACCOUNT_MISMATCH' THEN RAISE EXCEPTION 'ACCOUNT_MISMATCH KO : %', v_res; END IF;

  -- Fusion / ajout interdits après encaissement
  IF public.sales_order_edit_block_reason(v_b) IS DISTINCT FROM 'pos_settled' THEN
    RAISE EXCEPTION 'blocage pos_settled KO : %', public.sales_order_edit_block_reason(v_b);
  END IF;

  RAISE EXCEPTION 'ALL_OK';
END;
$$;
