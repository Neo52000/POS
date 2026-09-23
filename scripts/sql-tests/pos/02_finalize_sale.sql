-- =============================================================================
-- POS NF525 — test SQL 02 (projet « Pos ») : pos_finalize_sale
-- -----------------------------------------------------------------------------
-- Écrit sur la caisse TEST-01 (créée si absente ; les tickets de test restent
-- en base : immutabilité NF525). Rejouable : client_txn_id aléatoires.
-- Vérifie : recalcul serveur, numérotation continue, chaînage, idempotence,
-- TOTALS_MISMATCH, PAYMENTS_MISMATCH, SESSION_NOT_OPEN, VALIDATION,
-- business_date Europe/Paris, snapshot client (payload), quote_number, JET,
-- outbox pos_stock_sync.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_reg        uuid;
  v_session    uuid;
  v_cashier    uuid := gen_random_uuid();
  v_last       bigint;
  v_res        jsonb;
  v_res2       jsonb;
  v_txn        jsonb;
  v_base       jsonb;
  v_lines      jsonb;
  v_chain      record;
  v_code       text;
  v_detail     text;
  v_n          int;
BEGIN
  -- ---------------------------------------------------------------- setup
  INSERT INTO public.pos_registers (code, label) VALUES ('TEST-01', 'Caisse de test SQL') ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_reg FROM public.pos_registers WHERE code = 'TEST-01';
  SELECT id INTO v_session FROM public.pos_sessions WHERE register_id = v_reg AND status = 'open';
  IF v_session IS NULL THEN
    SELECT id INTO v_session FROM public.pos_open_session(v_reg, 10000, v_cashier);
  END IF;
  SELECT coalesce(max(ticket_number), 0) INTO v_last FROM public.pos_transactions WHERE register_id = v_reg;

  v_lines := '[{"line_no":1,"ean":"3329680123456","label":"Cahier 96p","qty":2,"unit_price_ttc_cents":1000,"vat_rate":20,"discount_percent":0},
               {"line_no":2,"label":"Livre","qty":1,"unit_price_ttc_cents":1055,"vat_rate":5.5,"discount_percent":0},
               {"line_no":3,"label":"Stylo remisé","qty":3,"unit_price_ttc_cents":999,"vat_rate":20,"discount_percent":10}]'::jsonb;
  -- attendu : 2000 (HT 1667, TVA 333) + 1055 (HT 1000, TVA 55) + 2697 (HT 2248, TVA 449) = 5752 TTC ; TVA 837 ; HT 4915
  v_base := jsonb_build_object(
    'register_id', v_reg, 'session_id', v_session, 'kind', 'sale',
    'business_at', '2026-09-23T22:30:00.123Z',      -- 00:30 le 24/09 à Paris -> business_date 2026-09-24
    'offline_queued', false, 'invoice_requested', true, 'cashier_id', v_cashier,
    'lines', v_lines,
    'payments', '[{"method":"cash","amount_cents":5000},{"method":"cb","amount_cents":1000}]'::jsonb,
    'change_cents', 248,
    'totals', '{"total_ht_cents":4915,"total_vat_cents":837,"total_ttc_cents":5752}'::jsonb,
    'app_version', 'sql-test');

  -- ------------------------------------------------------- 1. vente OK
  v_res := public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid()));
  v_txn := v_res -> 'transaction';
  IF (v_res ->> 'idempotent_replay')::boolean THEN RAISE EXCEPTION 'replay inattendu'; END IF;
  IF (v_txn ->> 'ticket_number')::bigint <> v_last + 1 THEN
    RAISE EXCEPTION 'numérotation : attendu %, obtenu %', v_last + 1, v_txn ->> 'ticket_number';
  END IF;
  IF (v_txn ->> 'total_ttc_cents')::bigint <> 5752 OR (v_txn ->> 'total_vat_cents')::bigint <> 837 OR (v_txn ->> 'total_ht_cents')::bigint <> 4915 THEN
    RAISE EXCEPTION 'totaux : %', v_txn -> 'total_ttc_cents';
  END IF;
  IF (v_txn ->> 'tendered_cents')::bigint <> 6000 OR (v_txn ->> 'change_cents')::bigint <> 248 THEN
    RAISE EXCEPTION 'tendered/change inattendus';
  END IF;
  IF (v_txn ->> 'business_date') <> '2026-09-24' THEN
    RAISE EXCEPTION 'business_date Europe/Paris attendue 2026-09-24, obtenu %', v_txn ->> 'business_date';
  END IF;
  IF public.pos_canonical_vat_breakdown(v_txn -> 'vat_breakdown') <> '5.50:1000:55:1055;20.00:3915:782:4697' THEN
    RAISE EXCEPTION 'vat_breakdown inattendu : %', public.pos_canonical_vat_breakdown(v_txn -> 'vat_breakdown');
  END IF;
  IF jsonb_array_length(v_res -> 'lines') <> 3 OR jsonb_array_length(v_res -> 'payments') <> 2 THEN
    RAISE EXCEPTION 'lignes/paiements manquants';
  END IF;
  IF (v_txn ->> 'hash') <> public.pos_compute_txn_hash((v_txn ->> 'id')::uuid) THEN
    RAISE EXCEPTION 'hash stocké <> hash recalculé';
  END IF;
  IF (v_txn ->> 'signature_status') <> 'pending_signature' OR (v_txn ->> 'cashier_id')::uuid <> v_cashier THEN
    RAISE EXCEPTION 'statut signature / caissier inattendu';
  END IF;
  INSERT INTO pos_test_results VALUES ('sale_ok', true, 'ticket ' || (v_txn ->> 'ticket_number') || ' : 5752 TTC, hash ' || left(v_txn ->> 'hash', 12));

  -- ------------------------------------------------------- 2. idempotence
  v_res2 := public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', v_txn ->> 'client_txn_id', 'lines', '[]'::jsonb));
  IF NOT (v_res2 ->> 'idempotent_replay')::boolean OR (v_res2 -> 'transaction' ->> 'id') <> (v_txn ->> 'id') THEN
    RAISE EXCEPTION 'idempotence : la relecture devrait renvoyer le ticket existant';
  END IF;
  SELECT count(*) INTO v_n FROM public.pos_transactions WHERE register_id = v_reg AND ticket_number > v_last;
  IF v_n <> 1 THEN RAISE EXCEPTION 'idempotence : % tickets créés au lieu de 1', v_n; END IF;
  INSERT INTO pos_test_results VALUES ('idempotent_replay', true, 'même client_txn_id -> même ticket, aucun nouveau numéro');

  -- ------------------------------------------------------ 3. 2e vente chaînée
  v_res2 := public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(), 'business_at', '2026-09-23T10:00:00.000Z'));
  IF (v_res2 -> 'transaction' ->> 'prev_hash') <> (v_txn ->> 'hash') THEN
    RAISE EXCEPTION 'prev_hash du ticket suivant <> hash précédent';
  END IF;
  IF (v_res2 -> 'transaction' ->> 'ticket_number')::bigint <> v_last + 2 THEN
    RAISE EXCEPTION 'numérotation continue rompue';
  END IF;
  INSERT INTO pos_test_results VALUES ('chain_link', true, 'prev_hash = hash(n-1), ticket ' || (v_res2 -> 'transaction' ->> 'ticket_number'));

  -- ------------------------------------------------------- 4. TOTALS_MISMATCH
  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'totals', '{"total_ht_cents":4915,"total_vat_cents":837,"total_ttc_cents":5753}'::jsonb));
    RAISE EXCEPTION 'TOTALS_MISMATCH attendu';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
    IF SQLERRM <> 'TOTALS_MISMATCH' THEN RAISE; END IF;
    IF (v_detail::jsonb -> 'expected' ->> 'total_ttc_cents')::bigint <> 5752 THEN RAISE EXCEPTION 'DETAIL TOTALS_MISMATCH inattendu : %', v_detail; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('totals_mismatch', true, 'TOTALS_MISMATCH + DETAIL {expected, received}');

  -- ------------------------------------------------------ 5. PAYMENTS_MISMATCH
  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(), 'change_cents', 0));
    RAISE EXCEPTION 'PAYMENTS_MISMATCH attendu (somme)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'PAYMENTS_MISMATCH' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'payments', '[{"method":"cb","amount_cents":6000}]'::jsonb));
    RAISE EXCEPTION 'PAYMENTS_MISMATCH attendu (rendu sans espèces)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'PAYMENTS_MISMATCH' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'payments', '[{"method":"cheque","amount_cents":6000}]'::jsonb));
    RAISE EXCEPTION 'VALIDATION attendu (chèque sans référence)';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('payments_mismatch', true, 'somme, rendu sans cash, chèque sans référence');

  -- ------------------------------------------------------- 6. SESSION_NOT_OPEN
  BEGIN
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(), 'session_id', gen_random_uuid()));
    RAISE EXCEPTION 'SESSION_NOT_OPEN attendu';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SESSION_NOT_OPEN' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results VALUES ('session_not_open', true, 'session inconnue -> SESSION_NOT_OPEN');

  -- ----------------------------------------------- 7. aucun trou après erreurs
  SELECT max(ticket_number) INTO v_n FROM public.pos_transactions WHERE register_id = v_reg;
  IF v_n <> v_last + 2 THEN RAISE EXCEPTION 'le compteur a laissé un trou : max=%', v_n; END IF;
  IF (SELECT value FROM public.pos_counters WHERE register_id = v_reg AND kind = 'ticket') <> v_last + 2 THEN
    RAISE EXCEPTION 'pos_counters.ticket désynchronisé';
  END IF;
  INSERT INTO pos_test_results VALUES ('no_gap_after_errors', true, 'compteur = max(ticket_number) = ' || v_n);

  -- ------------------------------------------------------ 8. snapshot client (payload)
  v_res2 := public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
    'customer_account_id', '20000000-0000-0000-0000-000000000001', 'quote_id', gen_random_uuid(), 'quote_number', 'DV-2026-0001',
    'customer_snapshot', '{"display_name":"Mairie de Chaumont","company_name":"Mairie de Chaumont","siret":"21520121300019","vat_number":null}'::jsonb));
  IF (v_res2 -> 'transaction' ->> 'customer_account_id') <> '20000000-0000-0000-0000-000000000001'
     OR (v_res2 -> 'transaction' -> 'customer_snapshot' ->> 'siret') <> '21520121300019'
     OR v_res2 -> 'transaction' -> 'customer_snapshot' ? 'vat_number'
     OR (v_res2 -> 'transaction' ->> 'quote_number') <> 'DV-2026-0001' THEN
    RAISE EXCEPTION 'customer_snapshot / quote_number non stockés : %', v_res2 -> 'transaction';
  END IF;
  IF (public.pos_transaction_full((v_res2 ->> 'transaction_id')::uuid) ->> 'quote_number') <> 'DV-2026-0001' THEN
    RAISE EXCEPTION 'pos_transaction_full.quote_number absent';
  END IF;
  INSERT INTO pos_test_results VALUES ('customer_snapshot', true, 'snapshot du payload stocké (nulls retirés), quote_number ok');

  -- ------------------------------------------------------ 8b. outbox stock
  v_res2 := public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
    'lines', '[{"line_no":1,"product_id":"10000000-0000-0000-0000-000000000001","label":"Avec stock","qty":2,"unit_price_ttc_cents":1000,"vat_rate":20},
               {"line_no":2,"label":"Sans product_id","qty":1,"unit_price_ttc_cents":1055,"vat_rate":5.5},
               {"line_no":3,"product_id":"10000000-0000-0000-0000-000000000002","label":"Fraction 0.4","qty":0.4,"unit_price_ttc_cents":1000,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cb","amount_cents":3455}]'::jsonb, 'change_cents', 0, 'totals', NULL));
  SELECT count(*) INTO v_n FROM public.pos_stock_sync WHERE transaction_id = (v_res2 ->> 'transaction_id')::uuid;
  IF v_n <> 1 THEN RAISE EXCEPTION 'outbox : 1 ligne attendue (product_id + qty entière), trouvé %', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_stock_sync
                 WHERE transaction_id = (v_res2 ->> 'transaction_id')::uuid AND product_id = '10000000-0000-0000-0000-000000000001'
                   AND qty_delta = -2 AND status = 'pending' AND attempts = 0
                   AND idempotency_key = (v_res2 ->> 'transaction_id') || ':1') THEN
    RAISE EXCEPTION 'outbox : ligne incorrecte';
  END IF;
  INSERT INTO pos_test_results VALUES ('stock_outbox', true, 'pos_stock_sync : qty_delta -2, clé transaction_id:line_no, pending ; lignes sans product_id / qty arrondie à 0 ignorées');

  -- ------------------------------------------------------- 9. chaîne + JET
  SELECT * INTO v_chain FROM public.pos_verify_chain(v_reg);
  IF NOT v_chain.ok THEN RAISE EXCEPTION 'pos_verify_chain KO : % (ticket %)', v_chain.reason, v_chain.first_break_ticket; END IF;
  INSERT INTO pos_test_results VALUES ('verify_chain', true, v_chain.checked || ' tickets vérifiés sur TEST-01');
  SELECT * INTO v_chain FROM public.pos_verify_events_chain(v_reg);
  IF NOT v_chain.ok THEN RAISE EXCEPTION 'pos_verify_events_chain KO : %', v_chain.reason; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'sale'
                 AND (payload ->> 'transaction_id')::uuid = (v_txn ->> 'id')::uuid) THEN
    RAISE EXCEPTION 'événement sale absent du JET';
  END IF;
  INSERT INTO pos_test_results VALUES ('events_chain', true, v_chain.checked || ' événements vérifiés');

  -- ------------------------------------------------------ 10. lecture ticket
  v_res2 := public.pos_transaction_full((v_txn ->> 'id')::uuid);
  IF v_res2 -> 'settings' -> 'legal' IS NULL OR (v_res2 -> 'register' ->> 'code') <> 'TEST-01'
     OR v_res2 ->> 'cashier_name' IS NULL OR jsonb_array_length(v_res2 -> 'lines') <> 3 THEN
    RAISE EXCEPTION 'pos_transaction_full incomplet : %', v_res2 - 'lines' - 'payments' - 'transaction';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_today_transactions(v_reg, '2026-09-24'::date) t WHERE t.id = (v_txn ->> 'id')::uuid) THEN
    RAISE EXCEPTION 'pos_today_transactions ne renvoie pas le ticket du 24/09';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_transactions_to_invoice v WHERE v.transaction_id = (v_txn ->> 'id')::uuid) THEN
    RAISE EXCEPTION 'pos_transactions_to_invoice ne liste pas la vente invoice_requested';
  END IF;
  INSERT INTO pos_test_results VALUES ('read_functions', true, 'pos_transaction_full, pos_today_transactions, pos_transactions_to_invoice');
END $$;

SELECT * FROM pos_test_results;
