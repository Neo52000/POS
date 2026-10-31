-- =============================================================================
-- POS NF525 — test SQL 19 (projet « Pos ») : duplicatas, vente de formation,
-- caisses d'essai (0.4.0, lot 7)
-- -----------------------------------------------------------------------------
-- Caisse éphémère T19-<horodatage> (is_test), tout est annulé à la fin.
-- Vérifie : pos_reprint journalise le JET reprint de façon synchrone et renvoie
-- le rang du duplicata (1, 2, en comptant une réimpression antérieure tracée) ;
-- ticket inconnu refusé ; training_sale exige training=true et refuse tout
-- numéro fiscal ; is_test : TEST-01 marqué, modification par RPC tracée.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_reg     uuid;
  v_cashier uuid := gen_random_uuid();
  v_sess    public.pos_sessions;
  v_txn     uuid;
  v_r       jsonb;
  v_n       int;
  v_log     text[] := '{}';
BEGIN
  BEGIN
    INSERT INTO public.pos_registers (code, label, is_test)
    VALUES ('T19-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), 'Caisse éphémère test 19', true)
    RETURNING id INTO v_reg;
    v_sess := public.pos_open_session(v_reg, 0, v_cashier);
    v_txn := (public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
      'session_id', v_sess.id, 'kind', 'sale', 'business_at', now(), 'cashier_id', v_cashier,
      'lines', '[{"line_no":1,"label":"Agenda","qty":1,"unit_price_ttc_cents":990,"vat_rate":20}]'::jsonb,
      'payments', '[{"method":"cash","amount_cents":990}]'::jsonb)) ->> 'transaction_id')::uuid;

    -- 1. duplicatas numérotés, journalisés avant impression
    v_r := public.pos_reprint(v_txn);
    IF (v_r ->> 'duplicate_number')::int <> 1 THEN RAISE EXCEPTION 'duplicata 1 attendu : %', v_r; END IF;
    SELECT count(*) INTO v_n FROM public.pos_events
    WHERE id = (v_r ->> 'event_id')::bigint AND event_type = 'reprint' AND register_id = v_reg
      AND (payload ->> 'duplicate_number')::int = 1 AND payload ->> 'transaction_id' = v_txn::text;
    IF v_n <> 1 THEN RAISE EXCEPTION 'JET reprint absent ou incomplet'; END IF;
    -- réimpression antérieure (best effort 0.3.0) : comptée dans le rang
    PERFORM public.pos_log_event('reprint', jsonb_build_object('transaction_id', v_txn, 'ticket_code', 'T-legacy'), now(), v_reg, v_sess.id);
    v_r := public.pos_reprint(v_txn, true);
    IF (v_r ->> 'duplicate_number')::int <> 3
       OR NOT EXISTS (SELECT 1 FROM public.pos_events WHERE id = (v_r ->> 'event_id')::bigint AND payload ->> 'training' = 'true') THEN
      RAISE EXCEPTION 'duplicata 3 (formation) attendu : %', v_r;
    END IF;
    BEGIN
      PERFORM public.pos_reprint(gen_random_uuid());
      RAISE EXCEPTION 'TRANSACTION_NOT_FOUND attendu';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'TRANSACTION_NOT_FOUND' THEN RAISE; END IF;
    END;
    v_log := array_append(v_log, 'reprint|duplicatas n°1 puis n°3 (réimpression antérieure comptée), JET synchrone ; ticket inconnu refusé');

    -- 2. vente de formation : drapeau obligatoire, aucun numéro fiscal
    PERFORM public.pos_log_event('training_sale', jsonb_build_object('training', true, 'training_code', 'FORM-0001',
      'lines', '[{"label":"Agenda","qty":1,"line_ttc_cents":990}]'::jsonb, 'total_ttc_cents', 990, 'business_at', now()),
      now(), v_reg, NULL);
    FOR v_n IN 1..3 LOOP
      BEGIN
        PERFORM public.pos_log_event('training_sale', CASE v_n
          WHEN 1 THEN '{"total_ttc_cents":990}'::jsonb
          WHEN 2 THEN '{"training":true,"ticket_number":12}'::jsonb
          ELSE '{"training":true,"transaction_id":"00000000-0000-4000-8000-000000000000"}'::jsonb END, now(), v_reg, NULL);
        RAISE EXCEPTION 'training_sale invalide accepté (cas %)', v_n;
      EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
      END;
    END LOOP;
    v_log := array_append(v_log, 'training_sale|JET training_sale accepté ; sans drapeau, avec numéro ou transaction refusé');

    -- 3. caisses d'essai
    IF NOT (SELECT is_test FROM public.pos_registers WHERE code = 'TEST-01') THEN
      RAISE EXCEPTION 'TEST-01 non marquée is_test';
    END IF;
    PERFORM public.pos_admin_update_register(v_reg, '{"is_test":false}'::jsonb, 'Bascule de test (test 19)');
    IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'register_change'
                   AND payload -> 'changed' ? 'is_test' AND payload -> 'actor' ->> 'reason' = 'Bascule de test (test 19)') THEN
      RAISE EXCEPTION 'changement is_test non tracé';
    END IF;
    v_log := array_append(v_log, 'is_test|TEST-01 marquée ; changement is_test par RPC tracé (register_change)');

    RAISE EXCEPTION 'T19_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'T19_ROLLBACK' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results
  SELECT split_part(l, '|', 1), true, split_part(l, '|', 2) FROM unnest(v_log) AS l;
  INSERT INTO pos_test_results VALUES ('rollback', true, 'caisse éphémère annulée : aucune trace en base');
END;
$$;

SELECT * FROM pos_test_results;
