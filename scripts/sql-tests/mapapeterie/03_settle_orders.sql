-- =============================================================================
-- POS NF525 — test SQL (projet « ma-papeterie ») : commandes réglées en caisse
-- -----------------------------------------------------------------------------
-- pos_settle_orders : règlement appliqué, commande retirée de
-- pos_customer_open_orders, rejeu idempotent, ORDER_NOT_FOUND, ACCOUNT_MISMATCH,
-- VALIDATION, droits. Aucun effet persistant : le bloc se termine par
-- l'exception ALL_OK qui annule toutes les écritures (résultat attendu : ALL_OK).
-- =============================================================================
DO $$
DECLARE
  v_order   uuid;
  v_account uuid;
  v_txn     uuid := gen_random_uuid();
  v_res     jsonb;
  v_open    jsonb;
BEGIN
  IF has_function_privilege('anon', 'public.pos_settle_orders(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon ne doit pas exécuter pos_settle_orders';
  END IF;
  -- Une commande actuellement à encaisser
  SELECT so.id, so.account_id INTO v_order, v_account
  FROM public.sales_orders so
  WHERE so.account_id IS NOT NULL
    AND so.status NOT IN ('cancelled', 'invoiced')
    AND coalesce(so.shopify_financial_status, '') NOT IN
        ('paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided')
    AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements ps WHERE ps.order_id = so.id)
  LIMIT 1;
  IF v_order IS NULL THEN RAISE EXCEPTION 'aucune commande à encaisser pour le test'; END IF;
  v_open := public.pos_customer_open_orders(v_account);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_open) e WHERE (e ->> 'id')::uuid = v_order) THEN
    RAISE EXCEPTION 'commande absente de pos_customer_open_orders avant règlement';
  END IF;

  -- 1. règlement appliqué
  v_res := public.pos_settle_orders(jsonb_build_array(jsonb_build_object(
    'transaction_id', v_txn, 'order_id', v_order, 'customer_account_id', v_account,
    'register_code', 'TEST-01', 'ticket_number', 1, 'total_ttc_cents', 1234,
    'business_at', now())));
  IF NOT (v_res -> 0 ->> 'applied')::boolean THEN RAISE EXCEPTION 'règlement non appliqué : %', v_res; END IF;

  -- 2. commande retirée des commandes à encaisser
  v_open := public.pos_customer_open_orders(v_account);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_open) e WHERE (e ->> 'id')::uuid = v_order) THEN
    RAISE EXCEPTION 'commande encore proposée après règlement';
  END IF;

  -- 3. rejeu idempotent
  v_res := public.pos_settle_orders(jsonb_build_array(jsonb_build_object(
    'transaction_id', v_txn, 'order_id', v_order, 'customer_account_id', v_account,
    'total_ttc_cents', 1234, 'business_at', now())));
  IF (v_res -> 0 ->> 'applied')::boolean OR NOT (v_res -> 0 ->> 'already_applied')::boolean THEN
    RAISE EXCEPTION 'rejeu non idempotent : %', v_res;
  END IF;
  IF (SELECT count(*) FROM public.pos_order_settlements WHERE pos_transaction_id = v_txn) <> 1 THEN
    RAISE EXCEPTION 'doublon de règlement';
  END IF;

  -- 4. refus métier
  v_res := public.pos_settle_orders(jsonb_build_array(
    jsonb_build_object('transaction_id', gen_random_uuid(), 'order_id', gen_random_uuid(),
      'customer_account_id', v_account, 'total_ttc_cents', 1, 'business_at', now()),
    jsonb_build_object('transaction_id', gen_random_uuid(), 'order_id', v_order,
      'customer_account_id', gen_random_uuid(), 'total_ttc_cents', 1, 'business_at', now()),
    jsonb_build_object('transaction_id', 'pas-un-uuid', 'order_id', v_order)));
  IF v_res -> 0 ->> 'error' <> 'ORDER_NOT_FOUND'
     OR v_res -> 1 ->> 'error' <> 'ACCOUNT_MISMATCH'
     OR v_res -> 2 ->> 'error' <> 'VALIDATION' THEN
    RAISE EXCEPTION 'refus métier incorrects : %', v_res;
  END IF;

  RAISE EXCEPTION 'ALL_OK';
END;
$$;
