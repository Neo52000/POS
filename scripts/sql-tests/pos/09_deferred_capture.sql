-- =============================================================================
-- POS NF525 — test SQL 09 (projet « Pos ») : enregistrement différé d'un
-- paiement déjà capté (deferred_capture, lot 4 bis)
-- -----------------------------------------------------------------------------
-- Écrit sur la caisse TEST-01 (2 sessions, ventes et remboursements de test
-- conservés : immutabilité). Rejouable. Vérifie : remboursement CB différé
-- hors borne « en ligne » accepté (et tracé au JET), contrôle témoin sans
-- deferred_capture refusé, deferred_capture sans CB ou avec CB manuelle
-- refusé, fenêtre de 72 h, offline_queued + remboursement toujours refusé,
-- rattachement à la session ouverte après clôture, idempotence du rejeu.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_reg      uuid;
  v_cashier  uuid := gen_random_uuid();
  v_open     uuid;
  v_s1       public.pos_sessions;
  v_s2       public.pos_sessions;
  v_sale1    uuid;
  v_sale2    uuid;
  v_res      jsonb;
  v_txn      jsonb;
  v_x        uuid := gen_random_uuid();
  v_line     jsonb := '[{"line_no":1,"label":"DEF","qty":1,"unit_price_ttc_cents":1500,"vat_rate":20}]'::jsonb;
  v_rline    jsonb := '[{"line_no":1,"label":"DEF","qty":-1,"unit_price_ttc_cents":1500,"vat_rate":20}]'::jsonb;
  v_cb       jsonb := '[{"method":"cb","amount_cents":1500,"tpe_response":{"AE":"10"}}]'::jsonb;
  v_rcb      jsonb := '[{"method":"cb","amount_cents":-1500,"tpe_response":{"AE":"10"}}]'::jsonb;
BEGIN
  INSERT INTO public.pos_registers (code, label) VALUES ('TEST-01', 'Caisse de test SQL') ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_reg FROM public.pos_registers WHERE code = 'TEST-01';
  SELECT id INTO v_open FROM public.pos_sessions WHERE register_id = v_reg AND status = 'open';
  IF v_open IS NOT NULL THEN
    PERFORM public.pos_close_session(v_open, 0, 'fermeture préalable (test 09)', v_cashier);
  END IF;
  v_s1 := public.pos_open_session(v_reg, 0, v_cashier);

  -- deux ventes CB en ligne (cibles des remboursements)
  v_sale1 := (public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_s1.id, 'kind', 'sale', 'business_at', now(), 'cashier_id', v_cashier,
    'lines', v_line, 'payments', v_cb)) ->> 'transaction_id')::uuid;
  v_sale2 := (public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_s1.id, 'kind', 'sale', 'business_at', now(), 'cashier_id', v_cashier,
    'lines', v_line, 'payments', v_cb)) ->> 'transaction_id')::uuid;

  -- 1. témoin : remboursement -30 min SANS deferred_capture -> refusé
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
      'session_id', v_s1.id, 'kind', 'refund', 'refund_of_transaction_id', v_sale1, 'refund_reason', 'test 09 témoin',
      'business_at', now() - interval '30 minutes', 'cashier_id', v_cashier, 'lines', v_rline, 'payments', v_rcb));
    RAISE EXCEPTION 'BUSINESS_AT_OUT_OF_RANGE attendu (témoin)';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'BUSINESS_AT_OUT_OF_RANGE' THEN RAISE; END IF;
  END;

  -- 2. même remboursement avec deferred_capture -> accepté, tracé au JET
  v_res := public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_s1.id, 'kind', 'refund', 'refund_of_transaction_id', v_sale1, 'refund_reason', 'test 09 différé',
    'business_at', now() - interval '30 minutes', 'deferred_capture', true, 'cashier_id', v_cashier,
    'lines', v_rline, 'payments', v_rcb));
  v_txn := v_res -> 'transaction';
  IF (v_txn ->> 'kind') <> 'refund' OR (v_txn ->> 'offline_queued')::boolean
     OR NOT EXISTS (SELECT 1 FROM public.pos_events e WHERE e.event_type = 'refund'
                    AND (e.payload ->> 'transaction_id')::uuid = (v_txn ->> 'id')::uuid
                    AND (e.payload ->> 'deferred_capture')::boolean) THEN
    RAISE EXCEPTION 'remboursement différé incorrect : %', v_txn;
  END IF;
  INSERT INTO pos_test_results VALUES ('deferred_refund', true, 'témoin -30 min refusé ; différé accepté, JET deferred_capture=true');

  -- 3. garde-fous
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
      'session_id', v_s1.id, 'kind', 'sale', 'business_at', now() - interval '30 minutes', 'deferred_capture', true,
      'cashier_id', v_cashier, 'lines', v_line, 'payments', '[{"method":"cash","amount_cents":1500}]'::jsonb));
    RAISE EXCEPTION 'VALIDATION attendu (différé sans CB)';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
      'session_id', v_s1.id, 'kind', 'sale', 'business_at', now() - interval '30 minutes', 'deferred_capture', true,
      'cashier_id', v_cashier, 'lines', v_line,
      'payments', '[{"method":"cb","amount_cents":1500,"manual_fallback":true,"tpe_response":{"reason":"TPE HS"}}]'::jsonb));
    RAISE EXCEPTION 'VALIDATION attendu (différé avec CB manuelle)';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
      'session_id', v_s1.id, 'kind', 'refund', 'refund_of_transaction_id', v_sale2, 'refund_reason', 'test 09 -73 h',
      'business_at', now() - interval '73 hours', 'deferred_capture', true, 'cashier_id', v_cashier,
      'lines', v_rline, 'payments', v_rcb));
    RAISE EXCEPTION 'BUSINESS_AT_OUT_OF_RANGE attendu (-73 h)';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'BUSINESS_AT_OUT_OF_RANGE' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
      'session_id', v_s1.id, 'kind', 'refund', 'refund_of_transaction_id', v_sale2, 'refund_reason', 'test 09 offline',
      'business_at', now(), 'offline_queued', true, 'deferred_capture', true, 'cashier_id', v_cashier,
      'lines', v_rline, 'payments', v_rcb));
    RAISE EXCEPTION 'VALIDATION attendu (remboursement offline_queued)';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('guards', true, 'sans CB, CB manuelle, -73 h, offline_queued+remboursement refusés');

  -- 4. rattachement après clôture + idempotence
  PERFORM public.pos_close_session(v_s1.id, 0, 'test 09', v_cashier);
  v_s2 := public.pos_open_session(v_reg, 0, v_cashier);
  v_res := public.pos_finalize_sale(jsonb_build_object('client_txn_id', v_x, 'register_id', v_reg,
    'session_id', v_s1.id, 'kind', 'refund', 'refund_of_transaction_id', v_sale2, 'refund_reason', 'test 09 rattaché',
    'business_at', now() - interval '1 hour', 'deferred_capture', true, 'cashier_id', v_cashier,
    'lines', v_rline, 'payments', v_rcb));
  v_txn := v_res -> 'transaction';
  IF (v_txn ->> 'session_id')::uuid <> v_s2.id
     OR NOT EXISTS (SELECT 1 FROM public.pos_events e WHERE e.event_type = 'offline_reattached'
                    AND (e.payload ->> 'transaction_id')::uuid = (v_txn ->> 'id')::uuid
                    AND (e.payload ->> 'original_session_id')::uuid = v_s1.id) THEN
    RAISE EXCEPTION 'rattachement du remboursement différé incorrect : %', v_txn;
  END IF;
  v_res := public.pos_finalize_sale(jsonb_build_object('client_txn_id', v_x, 'register_id', v_reg,
    'session_id', v_s1.id, 'kind', 'refund', 'refund_of_transaction_id', v_sale2, 'refund_reason', 'test 09 rattaché',
    'business_at', now() - interval '1 hour', 'deferred_capture', true, 'cashier_id', v_cashier,
    'lines', v_rline, 'payments', v_rcb));
  IF NOT (v_res ->> 'idempotent_replay')::boolean
     OR (SELECT count(*) FROM public.pos_transactions WHERE client_txn_id = v_x) <> 1 THEN
    RAISE EXCEPTION 'rejeu non idempotent';
  END IF;
  INSERT INTO pos_test_results VALUES ('reattach_idempotent', true, 'session fermée -> session ouverte (JET offline_reattached), rejeu idempotent');

  PERFORM public.pos_close_session(v_s2.id, 0, 'test 09 fin', v_cashier);
END $$;

SELECT * FROM pos_test_results;
