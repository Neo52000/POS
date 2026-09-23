-- =============================================================================
-- POS NF525 — test SQL 05 (projet « Pos ») : remboursements et outbox stock
-- -----------------------------------------------------------------------------
-- Écrit sur la caisse TEST-01 (tickets conservés). Le stock lui-même vit dans
-- ma-papeterie : ici on vérifie l'outbox pos_stock_sync (une ligne par ligne
-- de ticket avec product_id, deltas signés, clés idempotentes) et le cycle de
-- synchronisation (pos_stock_sync_pending / pos_stock_sync_mark).
-- Vérifie aussi : REFUND_EXCEEDS_SOLD (cumul des remboursements),
-- REFUND_TARGET_NOT_FOUND, signes des quantités/paiements, motif requis.
-- Rejouable : oui (client_txn_id aléatoires, product_id fictif).
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_reg       uuid;
  v_session   uuid;
  v_cashier   uuid := gen_random_uuid();
  v_product   uuid := gen_random_uuid();     -- id produit ma-papeterie (fictif : aucune FK côté Pos)
  v_res       jsonb;
  v_sale_id   uuid;
  v_refund_id uuid;
  v_base      jsonb;
  v_sync      public.pos_stock_sync;
  v_detail    text;
  v_n         int;
BEGIN
  -- ---------------------------------------------------------------- setup
  INSERT INTO public.pos_registers (code, label) VALUES ('TEST-01', 'Caisse de test SQL') ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_reg FROM public.pos_registers WHERE code = 'TEST-01';
  SELECT id INTO v_session FROM public.pos_sessions WHERE register_id = v_reg AND status = 'open';
  IF v_session IS NULL THEN
    SELECT id INTO v_session FROM public.pos_open_session(v_reg, 0, v_cashier);
  END IF;

  -- ------------------------------------------------------------- 1. vente ×2
  v_res := public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_session, 'kind', 'sale',
    'business_at', now(), 'cashier_id', v_cashier,
    'lines', jsonb_build_array(jsonb_build_object('line_no', 1, 'product_id', v_product, 'label', 'Produit stock', 'qty', 2, 'unit_price_ttc_cents', 500, 'vat_rate', 20)),
    'payments', '[{"method":"cash","amount_cents":1000}]'::jsonb, 'change_cents', 0));
  v_sale_id := (v_res ->> 'transaction_id')::uuid;
  SELECT * INTO v_sync FROM public.pos_stock_sync WHERE transaction_id = v_sale_id;
  IF NOT FOUND OR v_sync.product_id <> v_product OR v_sync.qty_delta <> -2 OR v_sync.status <> 'pending'
     OR v_sync.idempotency_key <> v_sale_id::text || ':1' THEN
    RAISE EXCEPTION 'outbox de la vente incorrecte : %', to_jsonb(v_sync);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_stock_sync_pending(1000) p WHERE p.id = v_sync.id) THEN
    RAISE EXCEPTION 'pos_stock_sync_pending ne liste pas le mouvement';
  END IF;
  INSERT INTO pos_test_results VALUES ('sale_outbox', true, 'vente ×2 -> pos_stock_sync qty_delta -2 pending, clé ' || v_sync.idempotency_key);

  -- ---------------------------------------------- 2. cycle de synchronisation
  PERFORM public.pos_stock_sync_mark(v_sync.id, 'failed', 'HTTP 503', NULL);
  IF NOT EXISTS (SELECT 1 FROM public.pos_stock_sync WHERE id = v_sync.id AND status = 'failed' AND attempts = 1 AND last_error = 'HTTP 503') THEN
    RAISE EXCEPTION 'pos_stock_sync_mark(failed) inattendu';
  END IF;
  PERFORM public.pos_stock_sync_mark(v_sync.id, 'pending', NULL, NULL);     -- remise en file par l'opérateur
  PERFORM public.pos_stock_sync_mark(v_sync.id, 'done', NULL, -2);
  IF NOT EXISTS (SELECT 1 FROM public.pos_stock_sync WHERE id = v_sync.id AND status = 'done' AND attempts = 3
                 AND remote_stock_after = -2 AND done_at IS NOT NULL AND last_error IS NULL) THEN
    RAISE EXCEPTION 'pos_stock_sync_mark(done) inattendu';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_stock_sync_pending(1000) p WHERE p.id = v_sync.id) THEN
    RAISE EXCEPTION 'mouvement done encore listé comme pending';
  END IF;
  BEGIN
    PERFORM public.pos_stock_sync_mark(-1, 'done', NULL, NULL);
    RAISE EXCEPTION 'STOCK_SYNC_NOT_FOUND attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'STOCK_SYNC_NOT_FOUND' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('sync_cycle', true, 'failed -> pending -> done (attempts=3, remote_stock_after=-2), id inconnu refusé');

  -- ------------------------------------------------------ 3. remboursement ×1
  v_base := jsonb_build_object(
    'register_id', v_reg, 'session_id', v_session, 'kind', 'refund', 'refund_of_transaction_id', v_sale_id,
    'refund_reason', 'test', 'business_at', now(), 'cashier_id', v_cashier,
    'lines', jsonb_build_array(jsonb_build_object('line_no', 1, 'product_id', v_product, 'label', 'Produit stock', 'qty', -1, 'unit_price_ttc_cents', 500, 'vat_rate', 20)),
    'payments', '[{"method":"cash","amount_cents":-500}]'::jsonb, 'change_cents', 0);
  v_res := public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid()));
  v_refund_id := (v_res ->> 'transaction_id')::uuid;
  IF (v_res -> 'transaction' ->> 'total_ttc_cents')::bigint <> -500 OR (v_res -> 'transaction' ->> 'kind') <> 'refund'
     OR (v_res -> 'transaction' ->> 'refund_of_transaction_id')::uuid <> v_sale_id THEN
    RAISE EXCEPTION 'ticket de remboursement incorrect';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_stock_sync WHERE transaction_id = v_refund_id AND product_id = v_product
                 AND qty_delta = 1 AND status = 'pending' AND idempotency_key = v_refund_id::text || ':1') THEN
    RAISE EXCEPTION 'outbox du remboursement absente ou incorrecte';
  END IF;
  INSERT INTO pos_test_results VALUES ('refund_1', true, 'ticket ' || (v_res -> 'transaction' ->> 'ticket_number') || ' : -500 TTC, outbox qty_delta +1');

  -- --------------------------------------------- 4. erreurs de remboursement
  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'lines', jsonb_build_array(jsonb_build_object('line_no', 1, 'product_id', v_product, 'label', 'Produit stock', 'qty', -2, 'unit_price_ttc_cents', 500, 'vat_rate', 20)),
      'payments', '[{"method":"cash","amount_cents":-1000}]'::jsonb));
    RAISE EXCEPTION 'REFUND_EXCEEDS_SOLD attendu';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM <> 'REFUND_EXCEEDS_SOLD' THEN RAISE; END IF;
    IF (v_detail::jsonb ->> 'sold')::numeric <> 2 OR (v_detail::jsonb ->> 'already_refunded')::numeric <> 1 OR (v_detail::jsonb ->> 'requested')::numeric <> 2 THEN
      RAISE EXCEPTION 'DETAIL REFUND_EXCEEDS_SOLD inattendu : %', v_detail;
    END IF;
  END;
  INSERT INTO pos_test_results VALUES ('refund_exceeds_sold', true, '1 déjà remboursé + 2 demandés > 2 vendus (DETAIL ok)');

  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(), 'refund_of_transaction_id', gen_random_uuid()));
    RAISE EXCEPTION 'REFUND_TARGET_NOT_FOUND attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'REFUND_TARGET_NOT_FOUND' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(), 'refund_of_transaction_id', v_refund_id));
    RAISE EXCEPTION 'REFUND_TARGET_NOT_FOUND attendu (cible = un remboursement)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'REFUND_TARGET_NOT_FOUND' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('refund_target_not_found', true, 'cible inconnue ou non-vente');

  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'lines', jsonb_build_array(jsonb_build_object('line_no', 1, 'product_id', v_product, 'label', 'Produit stock', 'qty', 1, 'unit_price_ttc_cents', 500, 'vat_rate', 20)),
      'payments', '[{"method":"cash","amount_cents":500}]'::jsonb));
    RAISE EXCEPTION 'erreur attendue (qty positive sur refund)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT IN ('VALIDATION', 'PAYMENTS_MISMATCH') THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(), 'refund_reason', ''));
    RAISE EXCEPTION 'VALIDATION attendu (refund_reason vide)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(), 'change_cents', 100,
      'payments', '[{"method":"cash","amount_cents":-400}]'::jsonb));
    RAISE EXCEPTION 'PAYMENTS_MISMATCH attendu (rendu sur remboursement)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'PAYMENTS_MISMATCH' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('refund_validation', true, 'qty positive / motif vide / rendu monnaie refusés');

  -- ------------------------------------------ 5. 2e remboursement ×1 (solde)
  v_res := public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid()));
  SELECT coalesce(sum(qty_delta), 0)::int INTO v_n
  FROM public.pos_stock_sync WHERE transaction_id IN (v_sale_id, v_refund_id, (v_res ->> 'transaction_id')::uuid);
  IF v_n <> 0 THEN RAISE EXCEPTION 'somme des deltas outbox : attendu 0, obtenu %', v_n; END IF;
  INSERT INTO pos_test_results VALUES ('refund_2', true, 'solde remboursé : Σ qty_delta outbox = 0');

  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid()));
    RAISE EXCEPTION 'REFUND_EXCEEDS_SOLD attendu (tout est remboursé)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'REFUND_EXCEEDS_SOLD' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('refund_exhausted', true, '2 vendus, 2 remboursés : 3e refusé');

  -- ----------------------------------------------------------- 6. chaîne
  IF NOT (SELECT ok FROM public.pos_verify_chain(v_reg)) THEN
    RAISE EXCEPTION 'chaîne TEST-01 rompue';
  END IF;
  INSERT INTO pos_test_results VALUES ('verify_chain', true, 'chaîne TEST-01 intacte');
END $$;

SELECT * FROM pos_test_results;
