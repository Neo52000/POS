-- =============================================================================
-- POS NF525 — test SQL 08 (projet « Pos ») : clôtures mensuelles / annuelle et
-- archives (lot 5)
-- -----------------------------------------------------------------------------
-- Crée une caisse jetable T08-<horodatage> (rejouable sans collision ; données
-- conservées : immutabilité). Élargit la tolérance d'horloge DANS la transaction
-- de test pour simuler novembre et décembre 2025, puis la restaure.
-- Vérifie : pos_period_bounds (Europe/Paris, heure d'été), Z journaliers par
-- date, mensuels, annuel (totaux, nombre de tickets, grand total perpétuel),
-- pos_verify_closings_chain, pos_archive_data (partition contiguë, ancre,
-- PERIOD_NOT_ENDED), pos_register_archive (hash, idempotence, JET archive),
-- seconde archive contiguë, pos_verify_archives_chain, immutabilité.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_code     text := 'T08-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
  v_reg      uuid;
  v_cashier  uuid := gen_random_uuid();
  v_session  public.pos_sessions;
  v_tol_old  jsonb;
  v_d        uuid;
  v_res      jsonb;
  v_c        public.pos_closings;
  v_nov      public.pos_closings;
  v_dec      public.pos_closings;
  v_year     public.pos_closings;
  v_b        record;
  v_day      date;
  v_verify   record;
  v_data     jsonb;
  v_manifest jsonb;
  v_sha      text;
  v_arch     jsonb;
  v_arch2    jsonb;
  v_end1     timestamptz;
  v_end2     timestamptz;
BEGIN
  -- ---------------------------------------------------------- 0. bornes
  SELECT * INTO v_b FROM public.pos_period_bounds('daily', '2026-03-29 12:00+00');
  IF v_b.period_end - v_b.period_start <> interval '23 hours'
     OR v_b.period_start <> '2026-03-28 23:00+00' THEN
    RAISE EXCEPTION 'pos_period_bounds daily (heure d''été) incorrect : %', v_b;
  END IF;
  SELECT * INTO v_b FROM public.pos_period_bounds('monthly', '2025-11-30 23:30+00');   -- 1er déc. 00:30 Paris
  IF v_b.period_start <> '2025-11-30 23:00+00' OR v_b.period_end <> '2025-12-31 23:00+00' THEN
    RAISE EXCEPTION 'pos_period_bounds monthly incorrect : %', v_b;
  END IF;
  INSERT INTO pos_test_results VALUES ('period_bounds', true, 'jour de 23 h (heure d''été) ; mois Europe/Paris');

  -- ---------------------------------------------------------- setup
  INSERT INTO public.pos_registers (code, label) VALUES (v_code, 'Caisse jetable test 08') RETURNING id INTO v_reg;
  SELECT value INTO v_tol_old FROM public.pos_settings WHERE key = 'clock_tolerance';
  UPDATE public.pos_settings SET value = '{"online_minutes":600000,"offline_hours":72,"future_minutes":5}'::jsonb
  WHERE key = 'clock_tolerance';
  v_session := public.pos_open_session(v_reg, 0, v_cashier);

  -- ------------------------------------------------ 1. ventes simulées
  PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_session.id, 'kind', 'sale', 'business_at', '2025-11-03 10:00 Europe/Paris'::timestamptz, 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"A","qty":1,"unit_price_ttc_cents":1000,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cash","amount_cents":1000}]'::jsonb));
  PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_session.id, 'kind', 'sale', 'business_at', '2025-11-03 15:00 Europe/Paris'::timestamptz, 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"B","qty":1,"unit_price_ttc_cents":2500,"vat_rate":5.5}]'::jsonb,
    'payments', '[{"method":"cb","amount_cents":2500}]'::jsonb));
  PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_session.id, 'kind', 'sale', 'business_at', '2025-11-20 11:00 Europe/Paris'::timestamptz, 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"C","qty":1,"unit_price_ttc_cents":4000,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cheque","amount_cents":4000,"reference":"CHQ-1"}]'::jsonb));
  v_res := public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_session.id, 'kind', 'sale', 'business_at', '2025-12-05 09:30 Europe/Paris'::timestamptz, 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"D","qty":1,"unit_price_ttc_cents":3000,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cb","amount_cents":3000}]'::jsonb));
  v_d := (v_res ->> 'transaction_id')::uuid;
  PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_session.id, 'kind', 'sale', 'business_at', '2025-12-05 17:45 Europe/Paris'::timestamptz, 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"E","qty":1,"unit_price_ttc_cents":1200,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cash","amount_cents":1200}]'::jsonb));
  PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_session.id, 'kind', 'refund', 'refund_of_transaction_id', v_d, 'refund_reason', 'retour client test 08',
    'business_at', '2025-12-10 10:00 Europe/Paris'::timestamptz, 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"D","qty":-1,"unit_price_ttc_cents":3000,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cb","amount_cents":-3000}]'::jsonb));
  UPDATE public.pos_settings SET value = v_tol_old WHERE key = 'clock_tolerance';
  INSERT INTO pos_test_results VALUES ('sales', true, v_code || ' : nov. 7500 (3 tickets), déc. 4200 - 3000 (3 tickets)');

  -- ------------------------------------------------ 2. Z journaliers par date
  FOREACH v_day IN ARRAY ARRAY['2025-11-03', '2025-11-20', '2025-12-05', '2025-12-10']::date[] LOOP
    SELECT * INTO v_b FROM public.pos_period_bounds('daily', (v_day::text || ' 12:00 Europe/Paris')::timestamptz);
    v_c := public.pos_compute_closing(v_reg, 'daily', v_b.period_start, v_b.period_end, NULL, v_cashier);
  END LOOP;
  IF v_c.grand_total_perpetual_cents <> 8700 THEN
    RAISE EXCEPTION 'grand total perpétuel après le 10/12 : attendu 8700, obtenu %', v_c.grand_total_perpetual_cents;
  END IF;
  INSERT INTO pos_test_results VALUES ('daily', true, '4 Z journaliers, GTP 8700');

  -- ------------------------------------------------ 3. mensuels + annuel
  SELECT * INTO v_b FROM public.pos_period_bounds('monthly', '2025-11-15 12:00 Europe/Paris');
  v_nov := public.pos_compute_closing(v_reg, 'monthly', v_b.period_start, v_b.period_end, NULL, v_cashier);
  SELECT * INTO v_b FROM public.pos_period_bounds('monthly', '2025-12-15 12:00 Europe/Paris');
  v_dec := public.pos_compute_closing(v_reg, 'monthly', v_b.period_start, v_b.period_end, NULL, v_cashier);
  SELECT * INTO v_b FROM public.pos_period_bounds('annual', '2025-06-15 12:00 Europe/Paris');
  v_year := public.pos_compute_closing(v_reg, 'annual', v_b.period_start, v_b.period_end, NULL, v_cashier);
  IF v_nov.txn_count <> 3 OR v_nov.total_ttc_cents <> 7500 OR v_nov.grand_total_perpetual_cents <> 7500 THEN
    RAISE EXCEPTION 'mensuel novembre incorrect : %', to_jsonb(v_nov);
  END IF;
  IF v_dec.txn_count <> 3 OR v_dec.total_ttc_cents <> 1200 OR abs(v_dec.refunds_ttc_cents) <> 3000
     OR v_dec.grand_total_perpetual_cents <> 8700 THEN
    RAISE EXCEPTION 'mensuel décembre incorrect : %', to_jsonb(v_dec);
  END IF;
  IF v_year.txn_count <> 6 OR v_year.total_ttc_cents <> 8700 OR v_year.grand_total_perpetual_cents <> 8700
     OR v_year.total_ht_cents + v_year.total_vat_cents <> v_year.total_ttc_cents THEN
    RAISE EXCEPTION 'annuel 2025 incorrect : %', to_jsonb(v_year);
  END IF;
  INSERT INTO pos_test_results VALUES ('monthly_annual', true, 'nov. 7500 / déc. 1200 (remb. 3000) / 2025 : 8700, GTP 8700');

  -- ------------------------------------------------ 4. chaîne des clôtures
  SELECT * INTO v_verify FROM public.pos_verify_closings_chain(v_reg);
  IF NOT v_verify.ok OR v_verify.checked <> 7 THEN
    RAISE EXCEPTION 'pos_verify_closings_chain : %', to_jsonb(v_verify);
  END IF;
  INSERT INTO pos_test_results VALUES ('closings_chain', true, '7 clôtures chaînées vérifiées');

  -- ------------------------------------------------ 5. archives
  BEGIN
    PERFORM public.pos_archive_data(v_reg, now(), now() + interval '1 day');
    RAISE EXCEPTION 'PERIOD_NOT_ENDED attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'PERIOD_NOT_ENDED' THEN RAISE; END IF;
  END;
  PERFORM pg_sleep(0.05);
  v_end1 := clock_timestamp();
  v_data := public.pos_archive_data(v_reg, v_end1 - interval '1 year', v_end1);
  IF jsonb_array_length(v_data -> 'transactions') <> 6 OR (v_data -> 'chain_heads' ->> 'anchor_ticket_hash') <> ''
     OR (v_data -> 'chain_heads' ->> 'last_ticket_number')::bigint <> 6
     OR jsonb_array_length(v_data -> 'closings') <> 7
     OR jsonb_array_length(v_data -> 'transactions' -> 0 -> 'lines') <> 1
     OR v_data -> 'previous_archive' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'pos_archive_data (1) incorrect : heads %', v_data -> 'chain_heads';
  END IF;
  v_manifest := jsonb_build_object('format', 'pos-archive/v1', 'register_code', v_code, 'chain_heads', v_data -> 'chain_heads');
  v_sha := public.pos_sha256(v_manifest::text);
  v_arch := public.pos_register_archive(v_reg, v_end1 - interval '1 year', v_end1, v_code || '/test-1.zip', v_manifest, v_sha);
  IF (v_arch ->> 'already_exists')::boolean OR v_arch -> 'archive' ->> 'prev_hash' <> ''
     OR v_arch -> 'archive' ->> 'hash' <> public.pos_sha256('v1|archive|' || v_code || '|'
          || public.pos_canonical_ts(v_end1 - interval '1 year') || '|' || public.pos_canonical_ts(v_end1) || '|' || v_sha || '|')
     OR (v_arch -> 'archive' ->> 'last_ticket_number')::bigint <> 6 THEN
    RAISE EXCEPTION 'pos_register_archive (1) incorrect : %', v_arch;
  END IF;
  IF NOT (public.pos_register_archive(v_reg, v_end1 - interval '1 year', v_end1, v_code || '/test-1.zip', v_manifest, v_sha) ->> 'already_exists')::boolean THEN
    RAISE EXCEPTION 'pos_register_archive non idempotent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'archive'
                 AND payload ->> 'archive_id' = v_arch -> 'archive' ->> 'id') THEN
    RAISE EXCEPTION 'événement JET archive absent';
  END IF;
  INSERT INTO pos_test_results VALUES ('archive_1', true, '6 tickets, 7 clôtures, ancre vide, hash v1, idempotent, JET archive');

  -- seconde archive : une vente de plus, partition contiguë
  PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
    'session_id', v_session.id, 'kind', 'sale', 'business_at', now(), 'cashier_id', v_cashier,
    'lines', '[{"line_no":1,"label":"F","qty":1,"unit_price_ttc_cents":500,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cash","amount_cents":500}]'::jsonb));
  PERFORM pg_sleep(0.05);
  v_end2 := clock_timestamp();
  v_data := public.pos_archive_data(v_reg, v_end1, v_end2);
  IF jsonb_array_length(v_data -> 'transactions') <> 1
     OR (v_data -> 'transactions' -> 0 ->> 'ticket_number')::bigint <> 7
     OR (v_data -> 'chain_heads' ->> 'anchor_ticket_number')::bigint <> 6
     OR (v_data -> 'chain_heads' ->> 'anchor_ticket_hash') <> (v_data -> 'transactions' -> 0 ->> 'prev_hash')
     OR jsonb_array_length(v_data -> 'closings') <> 0
     OR v_data -> 'previous_archive' ->> 'id' <> v_arch -> 'archive' ->> 'id' THEN
    RAISE EXCEPTION 'pos_archive_data (2) non contiguë : heads %', v_data -> 'chain_heads';
  END IF;
  v_manifest := jsonb_build_object('format', 'pos-archive/v1', 'register_code', v_code, 'chain_heads', v_data -> 'chain_heads');
  v_sha := public.pos_sha256(v_manifest::text);
  v_arch2 := public.pos_register_archive(v_reg, v_end1, v_end2, v_code || '/test-2.zip', v_manifest, v_sha);
  IF v_arch2 -> 'archive' ->> 'prev_hash' <> v_arch -> 'archive' ->> 'hash'
     OR (v_arch2 -> 'archive' ->> 'last_closing_number')::bigint <> 7
     OR (v_arch2 -> 'archive' ->> 'last_ticket_number')::bigint <> 7 THEN
    RAISE EXCEPTION 'pos_register_archive (2) incorrect : %', v_arch2;
  END IF;
  SELECT * INTO v_verify FROM public.pos_verify_archives_chain(v_reg);
  IF NOT v_verify.ok OR v_verify.checked <> 2 THEN
    RAISE EXCEPTION 'pos_verify_archives_chain : %', to_jsonb(v_verify);
  END IF;
  INSERT INTO pos_test_results VALUES ('archive_2', true, 'ticket 7 seul, ancre = hash du ticket 6, chaîne de 2 archives OK');

  -- ------------------------------------------------ 6. immutabilité
  BEGIN
    UPDATE public.pos_archives SET storage_path = 'x' WHERE register_id = v_reg;
    RAISE EXCEPTION 'UPDATE pos_archives aurait dû échouer';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'NF525:%' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('archives_immutable', true, 'UPDATE refusé (NF525)');
END $$;

SELECT * FROM pos_test_results;
