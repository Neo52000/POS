-- =============================================================================
-- POS NF525 — test SQL 07 (projet « Pos ») : mode hors ligne (lot 4)
-- -----------------------------------------------------------------------------
-- Écrit sur la caisse TEST-01 (2 sessions, ventes de test conservées :
-- immutabilité). Rejouable : oui (une session ouverte préexistante est d'abord
-- fermée). Vérifie : bornes business_at en ligne / hors ligne
-- (BUSINESS_AT_OUT_OF_RANGE), remboursement hors ligne refusé, vente hors ligne
-- acceptée (offline_queued, provisional_ref), rejeu après clôture sans session
-- ouverte (SESSION_NOT_OPEN, compteur intact), rattachement à la session
-- ouverte + événement offline_reattached, business_date d'origine,
-- idempotence du rejeu, vente en ligne sur session fermée refusée,
-- pos_client_settings.
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
  v_res      jsonb;
  v_txn      jsonb;
  v_x        uuid := gen_random_uuid();
  v_counter  bigint;
  v_ba       timestamptz := now() - interval '2 hours';
  v_settings jsonb;
  v_lines    jsonb := '[{"line_no":1,"label":"OFF","qty":1,"unit_price_ttc_cents":1200,"vat_rate":20}]'::jsonb;
  v_pays     jsonb := '[{"method":"cash","amount_cents":1200}]'::jsonb;

BEGIN
  -- ---------------------------------------------------------------- setup
  INSERT INTO public.pos_registers (code, label) VALUES ('TEST-01', 'Caisse de test SQL') ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_reg FROM public.pos_registers WHERE code = 'TEST-01';
  SELECT id INTO v_open FROM public.pos_sessions WHERE register_id = v_reg AND status = 'open';
  IF v_open IS NOT NULL THEN
    PERFORM public.pos_close_session(v_open, 0, 'fermeture préalable (test 07)', v_cashier);
  END IF;
  v_s1 := public.pos_open_session(v_reg, 0, v_cashier);

  -- ------------------------------------------------ 1. bornes en ligne
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object(
      'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'sale',
      'business_at', now() - interval '20 minutes', 'cashier_id', v_cashier, 'lines', v_lines, 'payments', v_pays));
    RAISE EXCEPTION 'BUSINESS_AT_OUT_OF_RANGE attendu (en ligne, -20 min)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'BUSINESS_AT_OUT_OF_RANGE' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object(
      'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'sale',
      'business_at', now() + interval '20 minutes', 'cashier_id', v_cashier, 'lines', v_lines, 'payments', v_pays));
    RAISE EXCEPTION 'BUSINESS_AT_OUT_OF_RANGE attendu (en ligne, +20 min)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'BUSINESS_AT_OUT_OF_RANGE' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('online_bounds', true, '±20 min refusés (tolérance 10 min)');

  -- ------------------------------------------------ 2. bornes hors ligne
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object(
      'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'sale',
      'business_at', now() - interval '73 hours', 'offline_queued', true, 'provisional_ref', 'OFF-TEST-01-00000000-001',
      'cashier_id', v_cashier, 'lines', v_lines, 'payments', v_pays));
    RAISE EXCEPTION 'BUSINESS_AT_OUT_OF_RANGE attendu (hors ligne, -73 h)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'BUSINESS_AT_OUT_OF_RANGE' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object(
      'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'sale',
      'business_at', now() + interval '10 minutes', 'offline_queued', true, 'provisional_ref', 'OFF-TEST-01-00000000-002',
      'cashier_id', v_cashier, 'lines', v_lines, 'payments', v_pays));
    RAISE EXCEPTION 'BUSINESS_AT_OUT_OF_RANGE attendu (hors ligne, +10 min)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'BUSINESS_AT_OUT_OF_RANGE' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object(
      'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'refund',
      'refund_of_transaction_id', gen_random_uuid(), 'refund_reason', 'test hors ligne',
      'business_at', now(), 'offline_queued', true, 'cashier_id', v_cashier,
      'lines', '[{"line_no":1,"label":"OFF","qty":-1,"unit_price_ttc_cents":1200,"vat_rate":20}]'::jsonb,
      'payments', '[{"method":"cash","amount_cents":-1200}]'::jsonb));
    RAISE EXCEPTION 'VALIDATION attendu (remboursement hors ligne)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('offline_bounds', true, '-73 h et +10 min refusés ; remboursement hors ligne refusé');

  -- ------------------------------------------- 3. vente hors ligne acceptée
  v_res := public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'sale',
    'business_at', v_ba, 'offline_queued', true, 'provisional_ref', 'OFF-TEST-01-00000000-003',
    'cashier_id', v_cashier, 'lines', v_lines, 'payments', v_pays));
  v_txn := v_res -> 'transaction';
  IF NOT (v_txn ->> 'offline_queued')::boolean OR v_txn ->> 'provisional_ref' <> 'OFF-TEST-01-00000000-003'
     OR (v_txn ->> 'session_id')::uuid <> v_s1.id OR (v_txn ->> 'business_at')::timestamptz <> v_ba THEN
    RAISE EXCEPTION 'vente hors ligne mal enregistrée : %', v_txn;
  END IF;
  INSERT INTO pos_test_results VALUES ('offline_sale', true, 'ticket ' || (v_txn ->> 'ticket_number') || ', business_at -2 h conservé');

  -- --------------------------- 4. rejeu après clôture, aucune session ouverte
  PERFORM public.pos_close_session(v_s1.id, 1200, 'test 07', v_cashier);
  SELECT value INTO v_counter FROM public.pos_counters WHERE register_id = v_reg AND kind = 'ticket';
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object(
      'client_txn_id', v_x, 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'sale',
      'business_at', v_ba, 'offline_queued', true, 'provisional_ref', 'OFF-TEST-01-00000000-004',
      'cashier_id', v_cashier, 'lines', v_lines, 'payments', v_pays));
    RAISE EXCEPTION 'SESSION_NOT_OPEN attendu (aucune session ouverte)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SESSION_NOT_OPEN' THEN RAISE; END IF;
  END;
  IF (SELECT value FROM public.pos_counters WHERE register_id = v_reg AND kind = 'ticket') <> v_counter THEN
    RAISE EXCEPTION 'compteur ticket incrémenté malgré SESSION_NOT_OPEN';
  END IF;
  INSERT INTO pos_test_results VALUES ('replay_no_open_session', true, 'SESSION_NOT_OPEN, compteur intact');

  -- ----------------------------------- 5. rattachement à la session ouverte
  v_s2 := public.pos_open_session(v_reg, 0, v_cashier);
  v_res := public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', v_x, 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'sale',
    'business_at', v_ba, 'offline_queued', true, 'provisional_ref', 'OFF-TEST-01-00000000-004',
    'cashier_id', v_cashier, 'lines', v_lines, 'payments', v_pays));
  v_txn := v_res -> 'transaction';
  IF (v_txn ->> 'session_id')::uuid <> v_s2.id
     OR (v_txn ->> 'business_date')::date <> (v_ba AT TIME ZONE 'Europe/Paris')::date
     OR (v_txn ->> 'ticket_number')::bigint <> v_counter + 1 THEN
    RAISE EXCEPTION 'rattachement incorrect : %', v_txn;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pos_events e
    WHERE e.event_type = 'offline_reattached' AND e.session_id = v_s2.id
      AND (e.payload ->> 'transaction_id')::uuid = (v_txn ->> 'id')::uuid
      AND (e.payload ->> 'original_session_id')::uuid = v_s1.id) THEN
    RAISE EXCEPTION 'événement offline_reattached absent';
  END IF;
  INSERT INTO pos_test_results VALUES ('reattach', true, 'session fermée -> session ouverte, JET offline_reattached, business_date d''origine');

  -- -------------------------------------------------- 6. idempotence du rejeu
  v_res := public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', v_x, 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'sale',
    'business_at', v_ba, 'offline_queued', true, 'provisional_ref', 'OFF-TEST-01-00000000-004',
    'cashier_id', v_cashier, 'lines', v_lines, 'payments', v_pays));
  IF NOT (v_res ->> 'idempotent_replay')::boolean
     OR (SELECT count(*) FROM public.pos_transactions WHERE client_txn_id = v_x) <> 1 THEN
    RAISE EXCEPTION 'rejeu non idempotent : %', v_res;
  END IF;
  INSERT INTO pos_test_results VALUES ('idempotent_replay', true, 'rejeu = même transaction, aucune insertion');

  -- ----------------------------- 7. vente en ligne sur session fermée refusée
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object(
      'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_s1.id, 'kind', 'sale',
      'business_at', now(), 'cashier_id', v_cashier, 'lines', v_lines, 'payments', v_pays));
    RAISE EXCEPTION 'SESSION_NOT_OPEN attendu (vente en ligne, session fermée)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SESSION_NOT_OPEN' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('online_closed_session', true, 'pas de rattachement pour une vente en ligne');

  -- ---------------------------------------------------- 8. pos_client_settings
  v_settings := public.pos_client_settings();
  IF (v_settings ->> 'offline_max_txns')::int <> 50 OR (v_settings ->> 'offline_max_hours')::int <> 24
     OR (v_settings -> 'clock_tolerance' ->> 'online_minutes')::int <> 10
     OR (v_settings -> 'clock_tolerance' ->> 'offline_hours')::int <> 72
     OR v_settings ->> 'server_now' IS NULL THEN
    RAISE EXCEPTION 'pos_client_settings incorrect : %', v_settings;
  END IF;
  INSERT INTO pos_test_results VALUES ('client_settings', true, v_settings::text);

  PERFORM public.pos_close_session(v_s2.id, 1200, 'test 07 fin', v_cashier);
END $$;

SELECT * FROM pos_test_results;
