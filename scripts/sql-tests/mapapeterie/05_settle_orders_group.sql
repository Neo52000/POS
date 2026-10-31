-- =============================================================================
-- POS NF525 — test SQL (projet « ma-papeterie ») : encaissement groupé
-- -----------------------------------------------------------------------------
-- pos_settle_orders : un ticket règle deux commandes du même compte ; résultats
-- par (transaction_id, order_id) ; group_size = 2 ; rejeu idempotent par
-- couple ; les deux commandes sortent de pos_customer_open_orders.
-- Aucun effet persistant (exception ALL_OK). Nécessite un compte ayant au moins
-- deux commandes à encaisser.
-- =============================================================================
DO $$
DECLARE
  v_account uuid;
  v_o1      uuid;
  v_o2      uuid;
  v_txn     uuid := gen_random_uuid();
  v_batch   jsonb;
  v_res     jsonb;
  v_open    jsonb;
BEGIN
  SELECT (e ->> 'id')::uuid, a.id INTO v_o1, v_account
  FROM public.customer_accounts a
  CROSS JOIN LATERAL jsonb_array_elements(public.pos_customer_open_orders(a.id)) e
  WHERE jsonb_array_length(public.pos_customer_open_orders(a.id)) >= 2
  LIMIT 1;
  IF v_account IS NULL THEN RAISE EXCEPTION 'aucun compte avec 2 commandes à encaisser pour le test'; END IF;
  SELECT (e ->> 'id')::uuid INTO v_o2
  FROM jsonb_array_elements(public.pos_customer_open_orders(v_account)) e
  WHERE (e ->> 'id')::uuid <> v_o1 LIMIT 1;

  v_batch := jsonb_build_array(
    jsonb_build_object('transaction_id', v_txn, 'order_id', v_o1, 'customer_account_id', v_account,
      'register_code', 'TEST-01', 'ticket_number', 1, 'total_ttc_cents', 4321, 'business_at', now()),
    jsonb_build_object('transaction_id', v_txn, 'order_id', v_o2, 'customer_account_id', v_account,
      'register_code', 'TEST-01', 'ticket_number', 1, 'total_ttc_cents', 4321, 'business_at', now()));

  -- 1. les deux commandes réglées par le même ticket
  v_res := public.pos_settle_orders(v_batch);
  IF NOT (v_res -> 0 ->> 'applied')::boolean OR NOT (v_res -> 1 ->> 'applied')::boolean
     OR (v_res -> 1 ->> 'order_id')::uuid <> v_o2 THEN
    RAISE EXCEPTION 'règlement groupé non appliqué : %', v_res;
  END IF;
  IF (SELECT count(*) FROM public.pos_order_settlements WHERE pos_transaction_id = v_txn AND group_size = 2) <> 2 THEN
    RAISE EXCEPTION 'group_size incorrect';
  END IF;

  -- 2. retirées des commandes à encaisser
  v_open := public.pos_customer_open_orders(v_account);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_open) e WHERE (e ->> 'id')::uuid IN (v_o1, v_o2)) THEN
    RAISE EXCEPTION 'commande groupée encore proposée';
  END IF;

  -- 3. rejeu idempotent par couple
  v_res := public.pos_settle_orders(v_batch);
  IF NOT (v_res -> 0 ->> 'already_applied')::boolean OR NOT (v_res -> 1 ->> 'already_applied')::boolean THEN
    RAISE EXCEPTION 'rejeu groupé non idempotent : %', v_res;
  END IF;
  IF (SELECT count(*) FROM public.pos_order_settlements WHERE pos_transaction_id = v_txn) <> 2 THEN
    RAISE EXCEPTION 'doublon de règlement groupé';
  END IF;

  RAISE EXCEPTION 'ALL_OK';
END;
$$;
