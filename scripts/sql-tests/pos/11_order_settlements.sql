-- =============================================================================
-- POS NF525 — test SQL (projet Pos) : règlement des commandes transférées
-- -----------------------------------------------------------------------------
-- pos_order_settlement_record / _pending / _mark : inscription idempotente
-- (ventes uniquement), envoi ciblé, done / rejected définitifs, droits.
-- Aucun effet persistant : le bloc se termine par l'exception ALL_OK qui annule
-- toutes les écritures (résultat attendu : ALL_OK). Nécessite une vente et un
-- remboursement existants (tests 02 et 05).
-- =============================================================================
DO $$
DECLARE
  v_sale   uuid;
  v_refund uuid;
  v_order  uuid := gen_random_uuid();
  v_rows   jsonb[];
BEGIN
  IF has_function_privilege('authenticated', 'public.pos_order_settlement_record(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pos_order_settlement_pending(int, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'fonctions du pont commandes exposées aux clients';
  END IF;
  SELECT t.id INTO v_sale FROM public.pos_transactions t
  WHERE t.kind = 'sale' AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements s WHERE s.transaction_id = t.id)
  ORDER BY t.received_at DESC LIMIT 1;
  SELECT t.id INTO v_refund FROM public.pos_transactions t WHERE t.kind = 'refund' LIMIT 1;
  IF v_sale IS NULL THEN RAISE EXCEPTION 'aucune vente pour le test'; END IF;

  -- 1. inscription idempotente, ventes uniquement
  IF NOT public.pos_order_settlement_record(v_sale, v_order) THEN RAISE EXCEPTION 'inscription refusée'; END IF;
  IF public.pos_order_settlement_record(v_sale, gen_random_uuid()) THEN RAISE EXCEPTION 'double inscription'; END IF;
  IF v_refund IS NOT NULL AND public.pos_order_settlement_record(v_refund, v_order) THEN
    RAISE EXCEPTION 'remboursement inscrit';
  END IF;

  -- 2. envoi ciblé
  SELECT array_agg(r) INTO v_rows FROM public.pos_order_settlement_pending(10, ARRAY[v_sale]) r;
  IF coalesce(array_length(v_rows, 1), 0) <> 1 OR (v_rows[1] ->> 'order_id')::uuid <> v_order
     OR v_rows[1] ->> 'total_ttc_cents' IS NULL OR v_rows[1] ->> 'register_code' IS NULL THEN
    RAISE EXCEPTION 'pending incorrect : %', v_rows;
  END IF;

  -- 3. échec technique : reste pending ; puis done : sort de la file, définitif
  PERFORM public.pos_order_settlement_mark(ARRAY[v_sale], 'pending', 'timeout');
  IF (SELECT status FROM public.pos_order_settlements WHERE transaction_id = v_sale) <> 'pending'
     OR (SELECT attempts FROM public.pos_order_settlements WHERE transaction_id = v_sale) <> 1 THEN
    RAISE EXCEPTION 'échec technique mal tracé';
  END IF;
  PERFORM public.pos_order_settlement_mark(ARRAY[v_sale], 'done', NULL);
  IF EXISTS (SELECT 1 FROM public.pos_order_settlement_pending(10, ARRAY[v_sale])) THEN
    RAISE EXCEPTION 'règlement done encore en file';
  END IF;
  IF public.pos_order_settlement_mark(ARRAY[v_sale], 'rejected', 'x') <> 0 THEN
    RAISE EXCEPTION 'done modifié après coup';
  END IF;

  -- 4. statut invalide
  BEGIN
    PERFORM public.pos_order_settlement_mark(ARRAY[v_sale], 'failed', NULL);
    RAISE EXCEPTION 'VALIDATION attendu';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;

  RAISE EXCEPTION 'ALL_OK';
END;
$$;
