-- =============================================================================
-- POS NF525 — test SQL 01 (projet « Pos ») : smoke test du schéma
-- -----------------------------------------------------------------------------
-- Exécution : une seule requête multi-statements (MCP execute_sql / psql), en
-- tant qu'opérateur direct (is_pos() vrai hors PostgREST).
-- Vérifie : tables, triggers, fonctions (signatures), RLS, droits, seed, et
-- crée la caisse de test TEST-01 (les autres scripts s'en servent).
-- Rejouable : oui (idempotent, n'écrit que la caisse TEST-01 si absente).
-- Résultat : la table finale liste les étapes ; toute anomalie lève une
-- exception (le message indique l'étape).
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_missing   text;
  v_reg       uuid;
  v_n         int;
  v_expected  text[];
  v_sig       text;
BEGIN
  -- 1. tables
  SELECT string_agg(t, ', ') INTO v_missing
  FROM unnest(ARRAY['pos_user_roles','pos_registers','pos_settings','pos_counters','pos_sessions','pos_transactions',
                    'pos_transaction_lines','pos_payments','pos_stock_sync','pos_closings','pos_events']) t
  WHERE to_regclass('public.' || t) IS NULL;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'tables manquantes : %', v_missing;
  END IF;
  INSERT INTO pos_test_results VALUES ('tables', true, '11 tables pos_*');

  -- 2. vues
  IF to_regclass('public.pos_transactions_to_invoice') IS NULL OR to_regclass('public.pos_daily_summary') IS NULL THEN
    RAISE EXCEPTION 'vues manquantes (pos_transactions_to_invoice, pos_daily_summary)';
  END IF;
  INSERT INTO pos_test_results VALUES ('views', true, 'pos_transactions_to_invoice, pos_daily_summary');
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    RAISE EXCEPTION 'extension pgcrypto absente';
  END IF;
  INSERT INTO pos_test_results VALUES ('extensions', true, 'pgcrypto' ||
    CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN ', pg_cron' ELSE ' (pg_cron absent)' END ||
    CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN ', pg_net' ELSE ' (pg_net absent)' END);

  -- 3. fonctions + signatures exactes
  v_expected := ARRAY[
    'is_pos()',
    'is_pos_admin()',
    'pos_is_service_role()',
    'pos_sha256(p_input text)',
    'pos_canonical_qty(p_qty numeric)',
    'pos_canonical_discount(p_discount numeric)',
    'pos_canonical_rate(p_rate numeric)',
    'pos_canonical_ts(p_ts timestamp with time zone)',
    'pos_canonical_vat_breakdown(p_breakdown jsonb)',
    'pos_lines_digest_from_json(p_lines jsonb)',
    'pos_payments_digest_from_json(p_payments jsonb)',
    'pos_lines_digest(p_transaction_id uuid)',
    'pos_payments_digest(p_transaction_id uuid)',
    'pos_build_canonical_txn(p_ticket_number bigint, p_register_code text, p_client_txn_id uuid, p_business_at timestamp with time zone, p_kind text, p_total_ht_cents bigint, p_total_vat_cents bigint, p_total_ttc_cents bigint, p_vat_breakdown jsonb, p_customer_account_id uuid, p_lines_digest text, p_payments_digest text, p_prev_hash text)',
    'pos_canonical_txn(p_transaction_id uuid)',
    'pos_compute_txn_hash(p_transaction_id uuid)',
    'pos_verify_chain(p_register_id uuid, p_from bigint, p_to bigint)',
    'pos_verify_events_chain(p_register_id uuid)',
    'pos_event_hash(p_id bigint, p_register_id uuid, p_event_type text, p_payload jsonb, p_created_at timestamp with time zone, p_prev_hash text)',
    'pos_compute_cart(p_lines jsonb)',
    'pos_open_session(p_register_id uuid, p_opening_float_cents bigint, p_opened_by uuid)',
    'pos_close_session(p_session_id uuid, p_counted_cash_cents bigint, p_notes text, p_closed_by uuid)',
    'pos_compute_closing(p_register_id uuid, p_period_type text, p_period_start timestamp with time zone, p_period_end timestamp with time zone, p_session_id uuid, p_created_by uuid)',
    'pos_finalize_sale(p_payload jsonb)',
    'pos_log_event(p_event_type text, p_payload jsonb, p_client_at timestamp with time zone, p_register_id uuid, p_session_id uuid)',
    'pos_mark_signature(p_transaction_id uuid, p_status text, p_record_id text, p_signature text, p_payload jsonb, p_error text)',
    'pos_pending_signatures(p_limit integer)',
    'pos_stock_sync_pending(p_limit integer)',
    'pos_stock_sync_mark(p_id bigint, p_status text, p_error text, p_remote_stock_after integer)',
    'pos_mark_closing_synced(p_closing_id uuid, p_fiskaly_closing_id text, p_payload jsonb)',
    'pos_transaction_full(p_transaction_id uuid)',
    'pos_today_transactions(p_register_id uuid, p_date date)'
  ];
  SELECT string_agg(e, E'\n') INTO v_missing
  FROM unnest(v_expected) e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = e
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION E'fonctions manquantes ou signature différente :\n%', v_missing;
  END IF;
  INSERT INTO pos_test_results VALUES ('functions', true, array_length(v_expected, 1) || ' signatures vérifiées');

  -- 4. SECURITY DEFINER + search_path sur les RPC d'écriture
  SELECT string_agg(p.proname, ', ') INTO v_missing
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('pos_finalize_sale','pos_open_session','pos_close_session','pos_compute_closing','pos_log_event',
                      'pos_stock_sync_pending','pos_stock_sync_mark','pos_mark_signature',
                      'pos_pending_signatures','pos_mark_closing_synced','pos_transaction_full','pos_today_transactions',
                      'pos_verify_chain','is_pos','is_pos_admin','pos_is_service_role')
    AND (NOT p.prosecdef OR p.proconfig IS NULL OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'RPC sans SECURITY DEFINER / search_path : %', v_missing;
  END IF;
  INSERT INTO pos_test_results VALUES ('security_definer', true, 'toutes les RPC d''écriture sont SECURITY DEFINER + search_path');

  -- 5. triggers
  SELECT string_agg(t, ', ') INTO v_missing
  FROM unnest(ARRAY['trg_pos_transaction_lines_immutable','trg_pos_payments_immutable','trg_pos_stock_sync_no_delete',
                    'trg_pos_stock_sync_guard_update','trg_pos_events_immutable','trg_pos_transactions_no_delete',
                    'trg_pos_transactions_guard_update','trg_pos_closings_no_delete','trg_pos_closings_guard_update',
                    'trg_pos_sessions_no_delete','trg_pos_sessions_guard_update','trg_pos_events_before_insert',
                    'trg_pos_registers_init_counters','trg_pos_settings_touch']) t
  WHERE NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t AND NOT tgisinternal);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'triggers manquants : %', v_missing;
  END IF;
  -- aucune dépendance vers les objets ma-papeterie
  IF to_regclass('public.products') IS NOT NULL OR to_regclass('public.customer_360') IS NOT NULL THEN
    RAISE EXCEPTION 'la base Pos ne doit pas contenir products / customer_360';
  END IF;
  INSERT INTO pos_test_results VALUES ('triggers', true, '14 triggers ; base Pos sans objets ma-papeterie');

  -- 6. RLS activée partout
  SELECT string_agg(c.relname, ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'pos\_%' AND NOT c.relrowsecurity;
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'RLS désactivée sur : %', v_missing;
  END IF;
  INSERT INTO pos_test_results VALUES ('rls_enabled', true, 'toutes les tables pos_*');

  -- 7. droits : pas d'écriture directe pour authenticated / rien pour anon
  IF has_table_privilege('authenticated', 'public.pos_transactions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.pos_transactions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pos_transactions', 'DELETE')
     OR has_table_privilege('authenticated', 'public.pos_transaction_lines', 'INSERT')
     OR has_table_privilege('authenticated', 'public.pos_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.pos_counters', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.pos_stock_sync', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated a des droits d''écriture directe sur des tables pos_*';
  END IF;
  IF has_table_privilege('anon', 'public.pos_transactions', 'SELECT') THEN
    RAISE EXCEPTION 'anon peut lire pos_transactions';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.pos_transactions', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.pos_settings', 'UPDATE')
     OR NOT has_table_privilege('authenticated', 'public.pos_user_roles', 'INSERT') THEN
    RAISE EXCEPTION 'authenticated devrait pouvoir SELECT pos_transactions, UPDATE pos_settings et INSERT pos_user_roles (RLS admin)';
  END IF;
  INSERT INTO pos_test_results VALUES ('grants', true, 'authenticated: SELECT seulement (+ settings/registers/user_roles admin) ; anon: rien');

  -- 8. seed
  IF NOT EXISTS (SELECT 1 FROM public.pos_registers WHERE code = 'CHAUMONT-01') THEN
    RAISE EXCEPTION 'caisse CHAUMONT-01 absente';
  END IF;
  SELECT string_agg(k, ', ') INTO v_missing
  FROM unnest(ARRAY['legal','ticket_footer','offline_max_txns','offline_max_hours','software']) k
  WHERE NOT EXISTS (SELECT 1 FROM public.pos_settings WHERE key = k);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'pos_settings manquants : %', v_missing;
  END IF;
  INSERT INTO pos_test_results VALUES ('seed', true, 'CHAUMONT-01 + 5 settings');

  -- 9. is_pos() vrai pour l'opérateur direct
  IF NOT public.is_pos() OR NOT public.is_pos_admin() OR NOT public.pos_is_service_role() THEN
    RAISE EXCEPTION 'is_pos() / is_pos_admin() / pos_is_service_role() devraient être vrais pour une connexion directe';
  END IF;
  INSERT INTO pos_test_results VALUES ('is_pos', true, 'session_user=' || session_user);

  -- 10. caisse de test TEST-01 (créée si absente) + compteurs auto
  INSERT INTO public.pos_registers (code, label, fiskaly_env)
  VALUES ('TEST-01', 'Caisse de test SQL (données de test, ne pas utiliser)', 'test')
  ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_reg FROM public.pos_registers WHERE code = 'TEST-01';
  SELECT count(*) INTO v_n FROM public.pos_counters WHERE register_id = v_reg;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'TEST-01 devrait avoir 4 compteurs, trouvé %', v_n;
  END IF;
  SELECT count(*) INTO v_n
  FROM public.pos_registers r
  WHERE NOT EXISTS (SELECT 1 FROM public.pos_counters c WHERE c.register_id = r.id AND c.kind = 'ticket');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% caisse(s) sans compteur ticket', v_n;
  END IF;
  INSERT INTO pos_test_results VALUES ('test_register', true, 'TEST-01 = ' || v_reg || ', compteurs ok');

  -- 11. fonctions canoniques (vecteurs unitaires)
  IF public.pos_canonical_qty(1) <> '1' OR public.pos_canonical_qty(2.500) <> '2.5' OR public.pos_canonical_qty(-1) <> '-1'
     OR public.pos_canonical_qty(0.125) <> '0.125' OR public.pos_canonical_discount(0) <> '0.00'
     OR public.pos_canonical_discount(10) <> '10.00' OR public.pos_canonical_rate(5.5) <> '5.50'
     OR public.pos_canonical_rate(20) <> '20.00' OR public.pos_canonical_rate(0) <> '0.00'
     OR public.pos_canonical_ts('2026-09-23T14:05:07.123Z'::timestamptz) <> '2026-09-23T14:05:07.123Z'
     OR public.pos_sha256('abc') <> 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
     OR public.pos_canonical_vat_breakdown('[{"rate":"20.00","base_ht_cents":2500,"vat_cents":500,"ttc_cents":3000},{"rate":"5.50","base_ht_cents":1000,"vat_cents":55,"ttc_cents":1055}]'::jsonb)
        <> '5.50:1000:55:1055;20.00:2500:500:3000' THEN
    RAISE EXCEPTION 'fonctions canoniques : résultat inattendu';
  END IF;
  INSERT INTO pos_test_results VALUES ('canonical_functions', true, 'qty, discount, rate, ts, sha256, vat_breakdown');

  -- 12. calcul panier SPEC §2 (exemple de la SPEC : 5.50:1000:55:1055 ; 20.00:2500:500:3000)
  SELECT public.pos_compute_cart('[{"line_no":1,"label":"A","qty":1,"unit_price_ttc_cents":1055,"vat_rate":5.5},
                                   {"line_no":2,"label":"B","qty":2,"unit_price_ttc_cents":1500,"vat_rate":20}]'::jsonb) ->> 'totals'
  INTO v_sig;
  IF (v_sig::jsonb ->> 'total_ttc_cents')::bigint <> 4055 OR (v_sig::jsonb ->> 'total_vat_cents')::bigint <> 555
     OR (v_sig::jsonb ->> 'total_ht_cents')::bigint <> 3500 THEN
    RAISE EXCEPTION 'pos_compute_cart : totaux inattendus %', v_sig;
  END IF;
  -- remise 10 % sur 999 -> unit 899 (899.1) ; qty 3 -> 2697 ; HT 20 % -> 2248 (2247.5 arrondi half away)
  SELECT public.pos_compute_cart('[{"line_no":1,"label":"C","qty":3,"unit_price_ttc_cents":999,"vat_rate":20,"discount_percent":10}]'::jsonb) -> 'lines' -> 0
  INTO v_sig;
  IF (v_sig::jsonb ->> 'line_ttc_cents')::bigint <> 2697 OR (v_sig::jsonb ->> 'line_ht_cents')::bigint <> 2248
     OR (v_sig::jsonb ->> 'line_vat_cents')::bigint <> 449 OR (v_sig::jsonb ->> 'unit_price_ht_cents')::bigint <> 833 THEN
    RAISE EXCEPTION 'pos_compute_cart : ligne remisée inattendue %', v_sig;
  END IF;
  INSERT INTO pos_test_results VALUES ('compute_cart', true, 'exemple SPEC + remise/arrondi half away from zero');
END $$;

SELECT * FROM pos_test_results;
