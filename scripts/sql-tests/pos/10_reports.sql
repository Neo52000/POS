-- =============================================================================
-- POS NF525 — test SQL 10 (projet « Pos ») : lecture X et clôtures Z2 / Z3
-- -----------------------------------------------------------------------------
-- Écrit sur la caisse TEST-01 (session ouverte, 2 ventes, lecture X, fermeture).
-- Les cas Z2 / Z3 utilisent une caisse TEST-10 créée dans un sous-bloc annulé
-- (aucune trace). Rejouable : oui.
-- Vérifie : agrégats X ≡ Z1 de la même session, espèces attendues, GTP
-- projeté, JET x_report, aucune clôture ni compteur modifié par un X,
-- SESSION_NOT_OPEN ; pos_close_period : PERIOD_NOT_ENDED, NOTHING_TO_CLOSE,
-- SESSION_OPEN_IN_PERIOD, création puis idempotence (already_exists).
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_reg        uuid;
  v_cashier    uuid := gen_random_uuid();
  v_open       uuid;
  v_session    public.pos_sessions;
  v_x          jsonb;
  v_res        jsonb;
  v_closing    public.pos_closings;
  v_closings   bigint;
  v_counter    bigint;
  v_prev_gtp   bigint;
BEGIN
  INSERT INTO public.pos_registers (code, label) VALUES ('TEST-01', 'Caisse de test SQL') ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_reg FROM public.pos_registers WHERE code = 'TEST-01';
  SELECT id INTO v_open FROM public.pos_sessions WHERE register_id = v_reg AND status = 'open';
  IF v_open IS NOT NULL THEN
    PERFORM public.pos_close_session(v_open, 0, 'fermeture préalable (test 10)', v_cashier);
  END IF;
  SELECT coalesce((SELECT grand_total_perpetual_cents FROM public.pos_closings
                   WHERE register_id = v_reg AND period_type = 'daily' ORDER BY closing_number DESC LIMIT 1), 0)
  INTO v_prev_gtp;

  -- --------------------------------------------------------- 1. lecture X
  v_session := public.pos_open_session(v_reg, 5000, v_cashier);
  PERFORM public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_session.id, 'kind', 'sale',
    'business_at', now(), 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"A","qty":1,"unit_price_ttc_cents":2000,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cash","amount_cents":5000}]'::jsonb, 'change_cents', 3000));
  PERFORM public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_session.id, 'kind', 'sale',
    'business_at', now(), 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"B","qty":1,"unit_price_ttc_cents":1500,"vat_rate":5.5}]'::jsonb,
    'payments', '[{"method":"cb","amount_cents":1500}]'::jsonb, 'change_cents', 0));

  SELECT count(*) INTO v_closings FROM public.pos_closings WHERE register_id = v_reg;
  SELECT value INTO v_counter FROM public.pos_counters WHERE register_id = v_reg AND kind = 'closing';
  v_x := public.pos_x_report(v_session.id);
  IF (v_x #>> '{figures,txn_count}')::int <> 2 OR (v_x #>> '{figures,total_ttc_cents}')::bigint <> 3500
     OR (v_x #>> '{figures,change_cents}')::bigint <> 3000
     OR (v_x #>> '{figures,cash,expected_cash_cents}')::bigint <> 7000
     OR (v_x #>> '{figures,grand_total_perpetual_cents}')::bigint <> v_prev_gtp + 3500
     OR v_x ->> 'register_code' <> 'TEST-01' THEN
    RAISE EXCEPTION 'lecture X : agrégats inattendus %', v_x;
  END IF;
  IF public.pos_canonical_vat_breakdown(v_x #> '{figures,vat_breakdown}') <> '5.50:1422:78:1500;20.00:1667:333:2000' THEN
    RAISE EXCEPTION 'lecture X : ventilation TVA %', v_x #> '{figures,vat_breakdown}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE id = (v_x ->> 'x_number')::bigint AND event_type = 'x_report'
                   AND session_id = v_session.id) THEN
    RAISE EXCEPTION 'lecture X : événement JET x_report absent';
  END IF;
  IF (SELECT count(*) FROM public.pos_closings WHERE register_id = v_reg) <> v_closings
     OR (SELECT value FROM public.pos_counters WHERE register_id = v_reg AND kind = 'closing') <> v_counter THEN
    RAISE EXCEPTION 'lecture X : une clôture a été créée (remise à zéro interdite)';
  END IF;
  INSERT INTO pos_test_results VALUES ('x_report', true, 'X n°' || (v_x ->> 'x_number') || ' : 2 tickets, 3500 TTC, attendu 7000, JET, aucune clôture');

  -- X ≡ Z1 de la même session
  v_res := public.pos_close_session(v_session.id, 7000, 'test 10', v_cashier);
  v_closing := jsonb_populate_record(NULL::public.pos_closings, v_res -> 'closing');
  IF v_closing.txn_count <> (v_x #>> '{figures,txn_count}')::int
     OR v_closing.total_ttc_cents <> (v_x #>> '{figures,total_ttc_cents}')::bigint
     OR v_closing.total_ht_cents <> (v_x #>> '{figures,total_ht_cents}')::bigint
     OR v_closing.grand_total_perpetual_cents <> (v_x #>> '{figures,grand_total_perpetual_cents}')::bigint
     OR v_closing.payments_breakdown <> v_x #> '{figures,payments}'
     OR (v_res #>> '{session,expected_cash_cents}')::bigint <> (v_x #>> '{figures,cash,expected_cash_cents}')::bigint THEN
    RAISE EXCEPTION 'X et Z1 divergent : X % / Z %', v_x -> 'figures', v_res;
  END IF;
  INSERT INTO pos_test_results VALUES ('x_equals_z1', true, 'agrégats, paiements, GTP et espèces attendues identiques');

  BEGIN
    PERFORM public.pos_x_report(v_session.id);
    RAISE EXCEPTION 'SESSION_NOT_OPEN attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SESSION_NOT_OPEN' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('x_closed_session', true, 'refusée sur session fermée');

  -- ------------------------------------------------------- 2. Z2 / Z3
  BEGIN
    PERFORM public.pos_close_period(v_reg, 'monthly', now());
    RAISE EXCEPTION 'PERIOD_NOT_ENDED attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'PERIOD_NOT_ENDED' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_close_period(v_reg, 'daily', now() - interval '40 days');
    RAISE EXCEPTION 'VALIDATION attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('period_guards', true, 'mois en cours refusé, type daily refusé');

  -- Caisse TEST-10 éphémère : tout est annulé par l'exception finale du sous-bloc.
  BEGIN
    DECLARE
      v_reg10  uuid;
      v_ref    timestamptz := now() - interval '70 days';
      v_bounds record;
      v_daily  public.pos_closings;
      v_z2     jsonb;
      v_z2b    jsonb;
      v_z3     jsonb;
      v_s10    uuid;
      v_last   public.pos_closings;
    BEGIN
      INSERT INTO public.pos_registers (code, label) VALUES ('TEST-10', 'Caisse éphémère test 10') RETURNING id INTO v_reg10;
      SELECT * INTO v_bounds FROM public.pos_period_bounds('monthly', v_ref);

      BEGIN
        PERFORM public.pos_close_period(v_reg10, 'monthly', v_ref);
        RAISE EXCEPTION 'NOTHING_TO_CLOSE attendu';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'NOTHING_TO_CLOSE' THEN RAISE; END IF;
      END;

      v_daily := public.pos_compute_closing(v_reg10, 'daily', v_bounds.period_start + interval '1 day',
                                            v_bounds.period_start + interval '1 day 8 hours', NULL, v_cashier);

      INSERT INTO public.pos_sessions (register_id, session_number, opened_by, opened_at, opening_float_cents, status)
      VALUES (v_reg10, 1, v_cashier, v_bounds.period_end - interval '2 hours', 0, 'open')
      RETURNING id INTO v_s10;
      BEGIN
        PERFORM public.pos_close_period(v_reg10, 'monthly', v_ref);
        RAISE EXCEPTION 'SESSION_OPEN_IN_PERIOD attendu';
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM <> 'SESSION_OPEN_IN_PERIOD' THEN RAISE; END IF;
      END;
      -- Son Z1 (commencé dans la période) rejoint le Z2.
      PERFORM public.pos_close_session(v_s10, 0, 'test 10', v_cashier);
      SELECT * INTO v_last FROM public.pos_closings WHERE register_id = v_reg10 ORDER BY closing_number DESC LIMIT 1;

      v_z2 := public.pos_close_period(v_reg10, 'monthly', v_ref);
      v_z2b := public.pos_close_period(v_reg10, 'monthly', v_bounds.period_start + interval '3 days');
      IF (v_z2 ->> 'already_exists')::boolean OR NOT (v_z2b ->> 'already_exists')::boolean
         OR v_z2 #>> '{closing,id}' <> v_z2b #>> '{closing,id}'
         OR (v_z2 #>> '{closing,closing_number}')::bigint <> v_last.closing_number + 1
         OR v_z2 #>> '{closing,prev_hash}' <> v_last.hash
         OR v_last.closing_number <> v_daily.closing_number + 1
         OR (v_z2 #>> '{closing,period_start}')::timestamptz <> v_bounds.period_start THEN
        RAISE EXCEPTION 'Z2 inattendu : % / %', v_z2, v_z2b;
      END IF;

      IF (SELECT period_end FROM public.pos_period_bounds('annual', v_ref)) <= now() THEN
        v_z3 := public.pos_close_period(v_reg10, 'annual', v_ref);
        IF (v_z3 #>> '{closing,period_type}') <> 'annual' THEN
          RAISE EXCEPTION 'Z3 inattendu : %', v_z3;
        END IF;
      ELSE
        BEGIN
          PERFORM public.pos_close_period(v_reg10, 'annual', v_ref);
          RAISE EXCEPTION 'PERIOD_NOT_ENDED attendu (Z3)';
        EXCEPTION WHEN OTHERS THEN
          IF SQLERRM <> 'PERIOD_NOT_ENDED' THEN RAISE; END IF;
        END;
      END IF;
      RAISE EXCEPTION 'test10_rollback';
    END;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'test10_rollback' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.pos_registers WHERE code = 'TEST-10') THEN
    RAISE EXCEPTION 'la caisse TEST-10 aurait dû être annulée';
  END IF;
  INSERT INTO pos_test_results VALUES ('close_period', true, 'NOTHING_TO_CLOSE, SESSION_OPEN_IN_PERIOD, Z2 créé puis idempotent, Z3 selon la date');
END $$;

SELECT * FROM pos_test_results;
