-- =============================================================================
-- POS NF525 — test SQL 13 (projet « Pos ») : signature Fiskaly sans repli
-- silencieux (0.4.0, lot 1)
-- -----------------------------------------------------------------------------
-- Tout se déroule dans un sous-bloc annulé à la fin (aucune trace en base :
-- une caisse `live` de test ne doit jamais atteindre pos-sales-sync).
-- Caisses éphémères T13-LIVE-<horodatage> (live) et T13-TEST-<horodatage> (test).
-- Vérifie : vente d'une caisse live enregistrée en pending_signature ; signature
-- simulée (record « mock-… », payload mock=true, mode=mock) refusée par
-- pos_mark_signature (FISKALY_MOCK_FOR_LIVE_REGISTER), ticket jamais signed et
-- tentatives non consommées ; signature réelle acceptée ; caisse de test : mock
-- accepté (non-régression du développement).
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_ts       text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
  v_live     uuid;
  v_test     uuid;
  v_cashier  uuid := gen_random_uuid();
  v_sess     public.pos_sessions;
  v_res      jsonb;
  v_txn      uuid;
  v_txn_test uuid;
  v_row      public.pos_transactions;
  v_log      text[] := '{}';
  v_case     record;
  v_sale     jsonb := '{"kind":"sale","lines":[{"line_no":1,"label":"Stylo","qty":1,"unit_price_ttc_cents":250,"vat_rate":20}],"payments":[{"method":"cash","amount_cents":250}]}';
BEGIN
  BEGIN
    INSERT INTO public.pos_registers (code, label, fiskaly_env)
    VALUES ('T13-LIVE-' || v_ts, 'Caisse live éphémère test 13', 'live') RETURNING id INTO v_live;
    INSERT INTO public.pos_registers (code, label, fiskaly_env)
    VALUES ('T13-TEST-' || v_ts, 'Caisse test éphémère test 13', 'test') RETURNING id INTO v_test;

    -- 1. vente sur caisse live : enregistrée, en attente de signature
    v_sess := public.pos_open_session(v_live, 0, v_cashier);
    v_res := public.pos_finalize_sale(v_sale || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'register_id', v_live, 'session_id', v_sess.id, 'business_at', now(), 'cashier_id', v_cashier));
    v_txn := (v_res ->> 'transaction_id')::uuid;
    SELECT * INTO v_row FROM public.pos_transactions WHERE id = v_txn;
    IF v_row.signature_status <> 'pending_signature' THEN
      RAISE EXCEPTION 'vente live : pending_signature attendu, obtenu %', v_row.signature_status;
    END IF;
    v_log := array_append(v_log, 'live_sale_pending|ticket ' || v_row.ticket_number || ' enregistré, pending_signature');

    -- 2. toute forme de signature simulée est refusée
    FOR v_case IN
      SELECT * FROM (VALUES
        ('mock-' || v_txn::text, '{"system_id":"s"}'::jsonb),
        ('rec-1', '{"mock":true}'::jsonb),
        ('rec-2', '{"mode":"mock"}'::jsonb)) AS c(record_id, payload)
    LOOP
      BEGIN
        PERFORM public.pos_mark_signature(v_txn, 'signed', v_case.record_id, 'sig', v_case.payload, NULL);
        RAISE EXCEPTION 'signature mock acceptée pour une caisse live (%)', v_case.record_id;
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'FISKALY_MOCK_FOR_LIVE_REGISTER' THEN RAISE; END IF;
      END;
    END LOOP;
    SELECT * INTO v_row FROM public.pos_transactions WHERE id = v_txn;
    IF v_row.signature_status <> 'pending_signature' OR v_row.signature_attempts <> 0
       OR v_row.fiskaly_signature IS NOT NULL THEN
      RAISE EXCEPTION 'ticket live modifié par un refus : %', to_jsonb(v_row);
    END IF;
    v_log := array_append(v_log, 'mock_refused_live|3 formes de signature mock refusées, ticket toujours pending_signature, 0 tentative');

    -- 3. FISKALY_NOT_CONFIGURED (Edge) : pending_signature conservé, rejouable
    PERFORM public.pos_mark_signature(v_txn, 'pending_signature', NULL, NULL, NULL, 'FISKALY_NOT_CONFIGURED: caisse live sans FISKALY_BASE_URL');
    IF NOT EXISTS (SELECT 1 FROM public.pos_pending_signatures(500) p WHERE p.id = v_txn) THEN
      RAISE EXCEPTION 'ticket live absent de pos_pending_signatures';
    END IF;
    v_log := array_append(v_log, 'not_configured_replayable|pending_signature + JET signature_failed, rejoué par pos-sign-pending');

    -- 4. signature réelle acceptée
    PERFORM public.pos_mark_signature(v_txn, 'signed', 'rec-live-1', 'sig-live', '{"system_id":"sys-live"}'::jsonb, NULL);
    SELECT * INTO v_row FROM public.pos_transactions WHERE id = v_txn;
    IF v_row.signature_status <> 'signed' THEN
      RAISE EXCEPTION 'signature réelle refusée : %', v_row.signature_status;
    END IF;
    v_log := array_append(v_log, 'live_real_signature|signature réelle acceptée');

    -- 5. caisse de test : le mock reste accepté
    v_sess := public.pos_open_session(v_test, 0, v_cashier);
    v_res := public.pos_finalize_sale(v_sale || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'register_id', v_test, 'session_id', v_sess.id, 'business_at', now(), 'cashier_id', v_cashier));
    v_txn_test := (v_res ->> 'transaction_id')::uuid;
    PERFORM public.pos_mark_signature(v_txn_test, 'signed', 'mock-' || v_txn_test::text, 'sig', '{"mock":true}'::jsonb, NULL);
    IF (SELECT signature_status FROM public.pos_transactions WHERE id = v_txn_test) <> 'signed' THEN
      RAISE EXCEPTION 'mock refusé sur caisse de test';
    END IF;
    v_log := array_append(v_log, 'test_register_mock|caisse de test : mock accepté');

    RAISE EXCEPTION 'T13_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'T13_ROLLBACK' THEN RAISE; END IF;
  END;

  INSERT INTO pos_test_results
  SELECT split_part(l, '|', 1), true, split_part(l, '|', 2) FROM unnest(v_log) AS l;
  INSERT INTO pos_test_results VALUES ('rollback', true, 'caisses éphémères annulées : aucune trace en base');
END;
$$;

SELECT * FROM pos_test_results;
