-- =============================================================================
-- POS NF525 — test SQL 06 (projet « Pos ») : sessions et clôtures
-- -----------------------------------------------------------------------------
-- Écrit sur la caisse TEST-01 (session, 2 ventes, clôtures daily + monthly de
-- test, conservées). Rejouable : oui (une session ouverte préexistante est
-- d'abord fermée). Vérifie : SESSION_ALREADY_OPEN, numérotation des sessions,
-- espèces attendues / écart, clôture Z (compteurs, totaux, ventilation
-- paiements, grand total perpétuel, chaînage), idempotence de
-- pos_compute_closing, agrégat monthly, SESSION_NOT_OPEN après fermeture.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_reg       uuid;
  v_cashier   uuid := gen_random_uuid();
  v_open      uuid;
  v_session   public.pos_sessions;
  v_res       jsonb;
  v_closing   public.pos_closings;
  v_closing2  public.pos_closings;
  v_monthly   public.pos_closings;
  v_prev_gtp  bigint;
  v_prev_hash text;
  v_prev_no   bigint;
  v_n         int;
BEGIN
  -- ---------------------------------------------------------------- setup
  INSERT INTO public.pos_registers (code, label) VALUES ('TEST-01', 'Caisse de test SQL') ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_reg FROM public.pos_registers WHERE code = 'TEST-01';
  SELECT id INTO v_open FROM public.pos_sessions WHERE register_id = v_reg AND status = 'open';
  IF v_open IS NOT NULL THEN
    PERFORM public.pos_close_session(v_open, 0, 'fermeture préalable (test 06)', v_cashier);
  END IF;
  SELECT coalesce(max(grand_total_perpetual_cents), 0) INTO v_prev_gtp
  FROM public.pos_closings WHERE register_id = v_reg AND period_type = 'daily'
    AND closing_number = (SELECT max(closing_number) FROM public.pos_closings WHERE register_id = v_reg AND period_type = 'daily');
  SELECT hash, closing_number INTO v_prev_hash, v_prev_no FROM public.pos_closings WHERE register_id = v_reg ORDER BY closing_number DESC LIMIT 1;
  SELECT coalesce(max(session_number), 0) INTO v_n FROM public.pos_sessions WHERE register_id = v_reg;

  -- ------------------------------------------------------------ 1. ouverture
  v_session := public.pos_open_session(v_reg, 5000, v_cashier);
  IF v_session.status <> 'open' OR v_session.opening_float_cents <> 5000 OR v_session.session_number <> v_n + 1 THEN
    RAISE EXCEPTION 'ouverture de session incorrecte';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE event_type = 'session_open' AND session_id = v_session.id) THEN
    RAISE EXCEPTION 'événement session_open absent';
  END IF;
  INSERT INTO pos_test_results VALUES ('open_session', true, 'session n°' || v_session.session_number || ', fond 5000');

  BEGIN
    PERFORM public.pos_open_session(v_reg, 0, v_cashier);
    RAISE EXCEPTION 'SESSION_ALREADY_OPEN attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SESSION_ALREADY_OPEN' THEN RAISE; END IF;
  END;
  IF (SELECT value FROM public.pos_counters WHERE register_id = v_reg AND kind = 'session') <> v_session.session_number THEN
    RAISE EXCEPTION 'compteur session incrémenté malgré l''échec';
  END IF;
  INSERT INTO pos_test_results VALUES ('session_already_open', true, 'refusé, compteur intact');

  -- ------------------------------------------------------------- 2. ventes
  -- vente A : 2000 TTC (20 %), 5000 en espèces, rendu 3000
  PERFORM public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_session.id, 'kind', 'sale',
    'business_at', now(), 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"A","qty":1,"unit_price_ttc_cents":2000,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cash","amount_cents":5000}]'::jsonb, 'change_cents', 3000));
  -- vente B : 1500 TTC (5.5 %), CB
  PERFORM public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_session.id, 'kind', 'sale',
    'business_at', now(), 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"B","qty":1,"unit_price_ttc_cents":1500,"vat_rate":5.5}]'::jsonb,
    'payments', '[{"method":"cb","amount_cents":1500}]'::jsonb, 'change_cents', 0));
  INSERT INTO pos_test_results VALUES ('sales', true, 'A 2000 (cash 5000, rendu 3000) + B 1500 (cb)');

  -- ----------------------------------------------------------- 3. fermeture
  v_res := public.pos_close_session(v_session.id, 4000, 'test 06', v_cashier);
  v_session := (SELECT s FROM public.pos_sessions s WHERE s.id = v_session.id);
  IF v_session.status <> 'closed' OR v_session.expected_cash_cents <> 7000 OR v_session.variance_cents <> -3000
     OR v_session.counted_cash_cents <> 4000 OR v_session.closing_id IS NULL OR v_session.closed_at IS NULL THEN
    RAISE EXCEPTION 'fermeture : attendu expected 7000 / variance -3000, obtenu % / %', v_session.expected_cash_cents, v_session.variance_cents;
  END IF;
  INSERT INTO pos_test_results VALUES ('close_session', true, 'espèces attendues 7000 (5000 + 5000 - 3000), comptées 4000, écart -3000');

  -- ------------------------------------------------------------ 4. clôture Z
  SELECT * INTO v_closing FROM public.pos_closings WHERE id = v_session.closing_id;
  IF v_closing.period_type <> 'daily' OR v_closing.session_id <> v_session.id OR v_closing.txn_count <> 2
     OR v_closing.total_ttc_cents <> 3500 OR v_closing.total_vat_cents <> (333 + 78) OR v_closing.total_ht_cents <> (3500 - 411)
     OR v_closing.refunds_ttc_cents <> 0 OR v_closing.last_ticket_number - v_closing.first_ticket_number <> 1 THEN
    RAISE EXCEPTION 'clôture Z : agrégats inattendus (%)', to_jsonb(v_closing);
  END IF;
  IF public.pos_canonical_vat_breakdown(v_closing.vat_breakdown) <> '5.50:1422:78:1500;20.00:1667:333:2000' THEN
    RAISE EXCEPTION 'clôture Z : ventilation TVA %', public.pos_canonical_vat_breakdown(v_closing.vat_breakdown);
  END IF;
  IF (SELECT (e ->> 'amount_cents')::bigint FROM jsonb_array_elements(v_closing.payments_breakdown) e WHERE e ->> 'method' = 'cash') <> 5000
     OR (SELECT (e ->> 'amount_cents')::bigint FROM jsonb_array_elements(v_closing.payments_breakdown) e WHERE e ->> 'method' = 'cb') <> 1500
     OR (SELECT (e ->> 'count')::int FROM jsonb_array_elements(v_closing.payments_breakdown) e WHERE e ->> 'method' = 'cash') <> 1 THEN
    RAISE EXCEPTION 'clôture Z : ventilation paiements %', v_closing.payments_breakdown;
  END IF;
  IF v_closing.grand_total_perpetual_cents <> v_prev_gtp + 3500 THEN
    RAISE EXCEPTION 'grand total perpétuel : attendu %, obtenu %', v_prev_gtp + 3500, v_closing.grand_total_perpetual_cents;
  END IF;
  IF coalesce(v_closing.prev_hash, '') <> coalesce(v_prev_hash, '') OR v_closing.closing_number <> coalesce(v_prev_no, 0) + 1 THEN
    RAISE EXCEPTION 'clôture Z : chaînage / numérotation';
  END IF;
  IF v_closing.hash <> public.pos_sha256('v1|closing|' || v_closing.closing_number || '|daily|' || public.pos_canonical_ts(v_closing.period_start)
       || '|' || public.pos_canonical_ts(v_closing.period_end) || '|2|3500|' || v_closing.grand_total_perpetual_cents || '|' || coalesce(v_closing.prev_hash, '')) THEN
    RAISE EXCEPTION 'clôture Z : hash non reproductible';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE event_type = 'closing' AND (payload ->> 'closing_id')::uuid = v_closing.id)
     OR NOT EXISTS (SELECT 1 FROM public.pos_events WHERE event_type = 'session_close' AND session_id = v_session.id) THEN
    RAISE EXCEPTION 'événements closing / session_close absents';
  END IF;
  INSERT INTO pos_test_results VALUES ('closing_daily', true, 'Z n°' || v_closing.closing_number || ' : 2 tickets, 3500 TTC, GTP ' || v_closing.grand_total_perpetual_cents || ', hash ok');

  -- ------------------------------------------------ 5. idempotence clôture
  v_closing2 := public.pos_compute_closing(v_reg, 'daily', v_closing.period_start, v_closing.period_end + interval '1 hour', v_session.id, v_cashier);
  IF v_closing2.id <> v_closing.id THEN
    RAISE EXCEPTION 'pos_compute_closing devrait renvoyer la clôture existante';
  END IF;
  INSERT INTO pos_test_results VALUES ('closing_idempotent', true, 'même (caisse, type, période_start) -> même clôture');

  -- ------------------------------------------------------- 6. monthly
  -- période = [ouverture de session, maintenant) : contient exactement la daily de cette session
  v_monthly := public.pos_compute_closing(v_reg, 'monthly', v_session.opened_at, clock_timestamp() + interval '1 second', NULL, v_cashier);
  IF v_monthly.period_type <> 'monthly' OR v_monthly.txn_count <> 2 OR v_monthly.total_ttc_cents <> 3500
     OR v_monthly.grand_total_perpetual_cents <> v_closing.grand_total_perpetual_cents
     OR v_monthly.closing_number <> v_closing.closing_number + 1 OR v_monthly.prev_hash <> v_closing.hash
     OR public.pos_canonical_vat_breakdown(v_monthly.vat_breakdown) <> public.pos_canonical_vat_breakdown(v_closing.vat_breakdown) THEN
    RAISE EXCEPTION 'clôture monthly : agrégats inattendus (%)', to_jsonb(v_monthly);
  END IF;
  INSERT INTO pos_test_results VALUES ('closing_monthly', true, 'n°' || v_monthly.closing_number || ' agrège la daily, GTP repris, chaînée');

  -- ------------------------------------------------- 7. session fermée
  BEGIN
    PERFORM public.pos_close_session(v_session.id, 0, NULL, v_cashier);
    RAISE EXCEPTION 'SESSION_NOT_OPEN attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SESSION_NOT_OPEN' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(jsonb_build_object(
      'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_session.id, 'kind', 'sale',
      'business_at', now(), 'cashier_id', v_cashier,
      'lines', '[{"line_no":1,"label":"C","qty":1,"unit_price_ttc_cents":100,"vat_rate":20}]'::jsonb,
      'payments', '[{"method":"cb","amount_cents":100}]'::jsonb, 'change_cents', 0));
    RAISE EXCEPTION 'SESSION_NOT_OPEN attendu (vente sur session fermée)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SESSION_NOT_OPEN' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('session_closed', true, 'fermeture et vente refusées sur session fermée');

  -- ------------------------------------------------- 8. chaînes
  IF NOT (SELECT ok FROM public.pos_verify_chain(v_reg)) THEN RAISE EXCEPTION 'chaîne tickets TEST-01 rompue'; END IF;
  IF NOT (SELECT ok FROM public.pos_verify_events_chain(v_reg)) THEN RAISE EXCEPTION 'chaîne JET TEST-01 rompue'; END IF;
  SELECT count(*) INTO v_n
  FROM (SELECT c.prev_hash, lag(c.hash) OVER (ORDER BY c.closing_number) AS expected
        FROM public.pos_closings c WHERE c.register_id = v_reg) x
  WHERE coalesce(x.prev_hash, '') <> coalesce(x.expected, '');
  IF v_n <> 0 THEN RAISE EXCEPTION 'chaîne des clôtures rompue (% ruptures)', v_n; END IF;
  INSERT INTO pos_test_results VALUES ('verify_chains', true, 'tickets, JET et clôtures chaînés');
END $$;

SELECT * FROM pos_test_results;
