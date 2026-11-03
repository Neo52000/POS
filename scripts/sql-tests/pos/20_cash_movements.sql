-- =============================================================================
-- POS NF525 — test SQL 20 (projet « Pos ») : mouvements d'espèces (0.5.0)
-- -----------------------------------------------------------------------------
-- Écrit sur la caisse TEST-01 (session ouverte, 1 vente espèces, 3 mouvements,
-- lecture X, clôture). Rejouable : oui.
-- Vérifie : validations (VALIDATION, SESSION_NOT_OPEN), idempotence par
-- client_movement_id, JET cash_movement lié (event_id), espèces attendues
-- X ≡ Z1 incluant apports − sorties, détail X, totaux du JET session_close,
-- chiffre d'affaires / GTP inchangés par les mouvements, immutabilité
-- (UPDATE / DELETE / TRUNCATE refusés).
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_reg      uuid;
  v_cashier  uuid := gen_random_uuid();
  v_open     uuid;
  v_session  public.pos_sessions;
  v_client   uuid := gen_random_uuid();
  v_m1       jsonb;
  v_m1b      jsonb;
  v_x        jsonb;
  v_res      jsonb;
  v_code     text;
  v_n        int;
  v_prev_gtp bigint;
BEGIN
  INSERT INTO public.pos_registers (code, label, is_test) VALUES ('TEST-01', 'Caisse de test SQL', true) ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_reg FROM public.pos_registers WHERE code = 'TEST-01';
  SELECT id INTO v_open FROM public.pos_sessions WHERE register_id = v_reg AND status = 'open';
  IF v_open IS NOT NULL THEN
    PERFORM public.pos_close_session(v_open, 0, 'fermeture préalable (test 20)', v_cashier);
  END IF;
  SELECT coalesce((SELECT grand_total_perpetual_cents FROM public.pos_closings
                   WHERE register_id = v_reg AND period_type = 'daily' ORDER BY closing_number DESC LIMIT 1), 0)
  INTO v_prev_gtp;

  -- Fond 50,00 + vente espèces 20,00 (tendu 50,00, rendu 30,00) = 70,00 attendus avant mouvements.
  v_session := public.pos_open_session(v_reg, 5000, v_cashier);
  PERFORM public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_session.id, 'kind', 'sale',
    'business_at', now(), 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"A","qty":1,"unit_price_ttc_cents":2000,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cash","amount_cents":5000}]'::jsonb, 'change_cents', 3000));

  -- ---------------------------------------------------------- 1. validations
  FOR v_code IN SELECT unnest(ARRAY['kind', 'amount', 'reason', 'client']) LOOP
    BEGIN
      PERFORM public.pos_record_cash_movement(
        v_session.id,
        CASE WHEN v_code = 'kind' THEN 'gift' ELSE 'bank_deposit' END,
        CASE WHEN v_code = 'amount' THEN 0 ELSE 1000 END,
        CASE WHEN v_code = 'reason' THEN '   ' ELSE 'test' END,
        NULL,
        CASE WHEN v_code = 'client' THEN NULL ELSE gen_random_uuid() END);
      RAISE EXCEPTION 'validation % acceptée à tort', v_code;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
    END;
  END LOOP;
  INSERT INTO pos_test_results VALUES ('validation', true, 'type, montant, motif, clé client refusés (VALIDATION)');

  -- ------------------------------------------------- 2. écriture et idempotence
  v_m1  := public.pos_record_cash_movement(v_session.id, 'bank_deposit', 3000, ' Remise BNP ', 'B-42', v_client);
  v_m1b := public.pos_record_cash_movement(v_session.id, 'bank_deposit', 3000, 'Remise BNP', 'B-42', v_client);
  IF (v_m1 ->> 'idempotent_replay')::boolean OR NOT (v_m1b ->> 'idempotent_replay')::boolean
     OR v_m1 #>> '{movement,id}' <> v_m1b #>> '{movement,id}'
     OR v_m1 #>> '{movement,reason}' <> 'Remise BNP'
     OR (SELECT count(*) FROM public.pos_cash_movements WHERE client_movement_id = v_client) <> 1 THEN
    RAISE EXCEPTION 'idempotence : % / %', v_m1, v_m1b;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_events e
                 WHERE e.id = (v_m1 #>> '{movement,event_id}')::bigint AND e.event_type = 'cash_movement'
                   AND e.session_id = v_session.id AND (e.payload ->> 'amount_cents')::bigint = 3000
                   AND e.payload ->> 'reference' = 'B-42') THEN
    RAISE EXCEPTION 'JET cash_movement absent ou incomplet';
  END IF;
  PERFORM public.pos_record_cash_movement(v_session.id, 'withdrawal', 500, 'Achat comptant', NULL, gen_random_uuid());
  PERFORM public.pos_record_cash_movement(v_session.id, 'cash_in', 1000, 'Apport de monnaie', NULL, gen_random_uuid());
  INSERT INTO pos_test_results VALUES ('record', true, 'mouvement enregistré une seule fois (rejeu), JET cash_movement lié');

  -- ------------------------------------------------------ 3. lecture X ≡ Z1
  -- 70,00 − 30,00 − 5,00 + 10,00 = 45,00
  v_x := public.pos_x_report(v_session.id);
  IF (v_x #>> '{figures,cash,expected_cash_cents}')::bigint <> 4500
     OR (v_x #>> '{figures,cash,movements_in_cents}')::bigint <> 1000
     OR (v_x #>> '{figures,cash,movements_out_cents}')::bigint <> 3500
     OR jsonb_array_length(v_x #> '{figures,cash,movements}') <> 3
     OR (v_x #>> '{figures,total_ttc_cents}')::bigint <> 2000
     OR (v_x #>> '{figures,grand_total_perpetual_cents}')::bigint <> v_prev_gtp + 2000 THEN
    RAISE EXCEPTION 'lecture X : %', v_x -> 'figures';
  END IF;
  INSERT INTO pos_test_results VALUES ('x_report', true, 'attendu 4500 (apports 1000, sorties 3500), 3 mouvements détaillés, CA et GTP inchangés');

  v_res := public.pos_close_session(v_session.id, 4400, 'test 20', v_cashier);
  IF (v_res #>> '{session,expected_cash_cents}')::bigint <> (v_x #>> '{figures,cash,expected_cash_cents}')::bigint
     OR (v_res #>> '{session,variance_cents}')::bigint <> -100
     OR (v_res #>> '{closing,total_ttc_cents}')::bigint <> 2000
     OR (v_res #>> '{closing,grand_total_perpetual_cents}')::bigint <> v_prev_gtp + 2000 THEN
    RAISE EXCEPTION 'clôture : %', v_res;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_events e
                 WHERE e.session_id = v_session.id AND e.event_type = 'session_close'
                   AND (e.payload ->> 'cash_movements_in_cents')::bigint = 1000
                   AND (e.payload ->> 'cash_movements_out_cents')::bigint = 3500) THEN
    RAISE EXCEPTION 'JET session_close : totaux des mouvements absents';
  END IF;
  INSERT INTO pos_test_results VALUES ('x_equals_z1', true, 'attendu X = Z1 = 4500, écart −100, CA / GTP du Z sans les mouvements, totaux au JET');

  -- ----------------------------------------------------- 4. session fermée
  BEGIN
    PERFORM public.pos_record_cash_movement(v_session.id, 'cash_in', 100, 'trop tard', NULL, gen_random_uuid());
    RAISE EXCEPTION 'mouvement accepté sur session fermée';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SESSION_NOT_OPEN' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('closed_session', true, 'SESSION_NOT_OPEN après la clôture');

  -- -------------------------------------------------------- 5. immutabilité
  v_n := 0;
  BEGIN
    UPDATE public.pos_cash_movements SET amount_cents = 1 WHERE client_movement_id = v_client;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NF525:%immutable%' THEN v_n := v_n + 1; ELSE RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.pos_cash_movements WHERE client_movement_id = v_client;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NF525:%immutable%' THEN v_n := v_n + 1; ELSE RAISE; END IF;
  END;
  BEGIN
    TRUNCATE public.pos_cash_movements;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'NF525:%immutable%' THEN v_n := v_n + 1; ELSE RAISE; END IF;
  END;
  IF v_n <> 3 THEN RAISE EXCEPTION 'immutabilité : % refus sur 3', v_n; END IF;
  INSERT INTO pos_test_results VALUES ('immutability', true, 'UPDATE, DELETE et TRUNCATE refusés');
END $$;

SELECT * FROM pos_test_results;
