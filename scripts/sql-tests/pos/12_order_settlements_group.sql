-- =============================================================================
-- POS NF525 — test SQL (projet Pos) : encaissement groupé de commandes
-- -----------------------------------------------------------------------------
-- pos_order_settlement_record_many / _pending / _mark (couples) : plusieurs
-- commandes par vente, ensemble figé à la 1re inscription, résultat par couple,
-- compatibilité de pos_order_settlement_record et de _mark sans p_order_ids.
-- Aucun effet persistant (exception ALL_OK). Nécessite une vente (test 02).
-- =============================================================================
DO $$
DECLARE
  v_sale  uuid;
  v_sale2 uuid;
  v_o1    uuid := gen_random_uuid();
  v_o2    uuid := gen_random_uuid();
  v_o3    uuid := gen_random_uuid();
  v_n     int;
BEGIN
  IF has_function_privilege('authenticated', 'public.pos_order_settlement_record_many(uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_order_settlement_mark(uuid[], text, text, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'fonctions du pont commandes exposées aux clients';
  END IF;
  SELECT t.id INTO v_sale FROM public.pos_transactions t
  WHERE t.kind = 'sale' AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements s WHERE s.transaction_id = t.id)
  ORDER BY t.received_at DESC LIMIT 1;
  SELECT t.id INTO v_sale2 FROM public.pos_transactions t
  WHERE t.kind = 'sale' AND t.id <> v_sale
    AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements s WHERE s.transaction_id = t.id)
  ORDER BY t.received_at DESC LIMIT 1;
  IF v_sale IS NULL THEN RAISE EXCEPTION 'aucune vente pour le test'; END IF;

  -- 1. inscription groupée (doublons ignorés), ensemble figé
  v_n := public.pos_order_settlement_record_many(v_sale, ARRAY[v_o1, v_o2, v_o1]);
  IF v_n <> 2 THEN RAISE EXCEPTION 'inscription groupée : % au lieu de 2', v_n; END IF;
  IF public.pos_order_settlement_record_many(v_sale, ARRAY[v_o3]) <> 0 THEN
    RAISE EXCEPTION 'commande ajoutée à une vente déjà liée';
  END IF;
  IF public.pos_order_settlement_record_many(v_sale, '{}'::uuid[]) <> 0 THEN RAISE EXCEPTION 'liste vide inscrite'; END IF;

  -- 2. pending : une ligne par commande
  IF (SELECT count(*) FROM public.pos_order_settlement_pending(10, ARRAY[v_sale])) <> 2 THEN
    RAISE EXCEPTION 'pending groupé incorrect';
  END IF;

  -- 3. résultat par couple : o1 done, o2 rejected
  PERFORM public.pos_order_settlement_mark(ARRAY[v_sale], 'done', NULL, ARRAY[v_o1]);
  PERFORM public.pos_order_settlement_mark(ARRAY[v_sale], 'rejected', 'ACCOUNT_MISMATCH', ARRAY[v_o2]);
  IF (SELECT status FROM public.pos_order_settlements WHERE transaction_id = v_sale AND order_id = v_o1) <> 'done'
     OR (SELECT status FROM public.pos_order_settlements WHERE transaction_id = v_sale AND order_id = v_o2) <> 'rejected' THEN
    RAISE EXCEPTION 'marquage par couple incorrect';
  END IF;

  -- 4. longueurs incohérentes
  BEGIN
    PERFORM public.pos_order_settlement_mark(ARRAY[v_sale, v_sale], 'done', NULL, ARRAY[v_o1]);
    RAISE EXCEPTION 'VALIDATION attendu';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;

  -- 5. compatibilité : record (1 commande) et mark sans p_order_ids (toutes les commandes de la vente)
  IF v_sale2 IS NOT NULL THEN
    IF NOT public.pos_order_settlement_record(v_sale2, v_o3) THEN RAISE EXCEPTION 'record unitaire refusé'; END IF;
    IF public.pos_order_settlement_mark(ARRAY[v_sale2], 'done') <> 1 THEN RAISE EXCEPTION 'mark sans p_order_ids'; END IF;
  END IF;

  RAISE EXCEPTION 'ALL_OK';
END;
$$;
