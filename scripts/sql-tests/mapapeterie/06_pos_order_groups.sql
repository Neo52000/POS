-- =============================================================================
-- POS NF525 — test SQL (projet « ma-papeterie ») : lots préparés au back-office
-- -----------------------------------------------------------------------------
-- admin_create_pos_order_group / pos_customer_open_documents.prepared_group /
-- admin_pos_order_settlements : droits, refus, lot exposé, remplacement,
-- règlement d'une ligne (pos_settle_documents) visible dans le résumé.
-- Aucun effet persistant (exception ALL_OK). Nécessite un compte (hors Client
-- passage) ayant au moins deux documents ouverts.
-- =============================================================================
DO $$
DECLARE
  v_acc  uuid;
  v_docs jsonb;
  v_o    uuid[];
  v_d    uuid[];
  v_g    uuid;
  v_g2   uuid;
  v_line jsonb;
  v_txn  uuid := gen_random_uuid();
  v_n    int;
BEGIN
  IF has_function_privilege('authenticated', 'public.admin_create_pos_order_group(uuid, uuid[], uuid[], boolean, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.admin_pos_order_settlements(uuid[])', 'EXECUTE')
     OR has_table_privilege('anon', 'public.pos_order_groups', 'SELECT') THEN
    RAISE EXCEPTION 'lots exposés aux clients';
  END IF;
  SELECT a.id INTO v_acc FROM public.customer_accounts a
   WHERE NOT coalesce(a.is_passage, false)
     AND (SELECT count(DISTINCT (kind, doc_id)) FROM public.pos_open_document_lines(a.id, NULL)) >= 2
   LIMIT 1;
  IF v_acc IS NULL THEN RAISE EXCEPTION 'aucun compte avec 2 documents ouverts pour le test'; END IF;

  v_docs := public.pos_customer_open_documents(v_acc);
  SELECT coalesce(array_agg((e ->> 'id')::uuid), '{}') INTO v_o FROM jsonb_array_elements(v_docs -> 'orders') e;
  SELECT coalesce(array_agg((e ->> 'id')::uuid), '{}') INTO v_d FROM jsonb_array_elements(v_docs -> 'delivery_notes') e;
  IF cardinality(v_o) + cardinality(v_d) > 50 THEN v_o := v_o[1:2]; v_d := '{}'; END IF;

  -- 1. refus : document inconnu, lot d'un seul document
  BEGIN PERFORM public.admin_create_pos_order_group(v_acc, ARRAY[gen_random_uuid(), v_o[1]], '{}'); RAISE EXCEPTION 'X';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%DOCUMENT_NOT_OPEN%' AND SQLERRM NOT LIKE '%VALIDATION%' THEN RAISE EXCEPTION 'refus attendu : %', SQLERRM; END IF;
  END;
  BEGIN PERFORM public.admin_create_pos_order_group(v_acc, '{}', '{}'); RAISE EXCEPTION 'X';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%VALIDATION%' THEN RAISE EXCEPTION 'VALIDATION attendu : %', SQLERRM; END IF;
  END;

  -- 2. lot exposé à la caisse, remplacé par un nouveau lot sur les mêmes documents
  v_g := public.admin_create_pos_order_group(v_acc, v_o, v_d, true, NULL);
  IF (public.pos_customer_open_documents(v_acc) -> 'prepared_group' ->> 'id')::uuid IS DISTINCT FROM v_g THEN
    RAISE EXCEPTION 'prepared_group absent';
  END IF;
  v_g2 := public.admin_create_pos_order_group(v_acc, v_o, v_d, false, NULL);
  IF (SELECT cancelled_at FROM public.pos_order_groups WHERE id = v_g) IS NULL THEN RAISE EXCEPTION 'lot non remplacé'; END IF;

  -- 3. règlement d'une ligne en caisse : visible dans le résumé back-office
  v_line := coalesce(v_docs -> 'orders' -> 0 -> 'items' -> 0, v_docs -> 'delivery_notes' -> 0 -> 'items' -> 0);
  PERFORM public.pos_settle_documents(jsonb_build_array(jsonb_build_object(
    'transaction_id', v_txn, 'customer_account_id', v_acc, 'register_code', 'TEST-01', 'ticket_number', 1,
    'business_at', now(), 'lines', jsonb_build_array(jsonb_build_object(
      'sales_order_line_id', v_line ->> 'sales_order_line_id',
      'delivery_note_line_id', v_line ->> 'delivery_note_line_id',
      'qty', v_line -> 'quantity')))));
  SELECT count(*) INTO v_n
    FROM public.admin_pos_order_settlements(
      (SELECT array_agg(l.order_id) FROM public.sales_order_lines l WHERE l.id = (v_line ->> 'sales_order_line_id')::uuid)) x
   WHERE x.pos_transaction_id = v_txn;
  IF v_n <> 1 THEN RAISE EXCEPTION 'résumé des règlements incorrect'; END IF;

  -- 4. annulation (une seule fois)
  IF NOT public.admin_cancel_pos_order_group(v_g2, v_acc) OR public.admin_cancel_pos_order_group(v_g2, v_acc) THEN
    RAISE EXCEPTION 'annulation incorrecte';
  END IF;

  RAISE EXCEPTION 'ALL_OK';
END;
$$;
