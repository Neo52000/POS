-- =============================================================================
-- POS NF525 — test SQL 14 (projet « Pos ») : clôture Z journalière garantie
-- (0.4.0, lot 2)
-- -----------------------------------------------------------------------------
-- Caisse éphémère T14-<horodatage>, tout est annulé à la fin (sous-bloc). Une
-- session « de la veille » est simulée par insertion directe (opened_at = début
-- du jour Europe/Paris − 2 h, numéro pris au compteur +1) : aucune RPC ne permet
-- d'antidater une ouverture.
-- Vérifie : vente en ligne et remboursement refusés (SESSION_STALE) ; vente hors
-- ligne vers la session périmée refusée ; pos_flag_stale_sessions journalise
-- session_stale une seule fois par jour ; Z1 de la session périmée ; vente sans
-- session refusée (SESSION_NOT_OPEN) ; nouvelle session : vente acceptée et vente
-- hors ligne rattachée (offline_reattached).
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_reg       uuid;
  v_cashier   uuid := gen_random_uuid();
  v_day_start timestamptz;
  v_num       bigint;
  v_stale     uuid;
  v_new       public.pos_sessions;
  v_res       jsonb;
  v_close     jsonb;
  v_n         int;
  v_offline   jsonb;
  v_log       text[] := '{}';
  v_sale      jsonb := '{"kind":"sale","lines":[{"line_no":1,"label":"Gomme","qty":1,"unit_price_ttc_cents":150,"vat_rate":20}],"payments":[{"method":"cash","amount_cents":150}]}';
BEGIN
  BEGIN
    SELECT b.period_start INTO v_day_start FROM public.pos_period_bounds('daily', now()) b;
    INSERT INTO public.pos_registers (code, label)
    VALUES ('T14-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), 'Caisse éphémère test 14')
    RETURNING id INTO v_reg;
    UPDATE public.pos_counters SET value = value + 1
    WHERE register_id = v_reg AND kind = 'session' RETURNING value INTO v_num;
    INSERT INTO public.pos_sessions (register_id, session_number, opened_by, opened_at, opening_float_cents, status)
    VALUES (v_reg, v_num, v_cashier, v_day_start - interval '2 hours', 0, 'open')
    RETURNING id INTO v_stale;

    -- 1. vente en ligne refusée
    BEGIN
      PERFORM public.pos_finalize_sale(v_sale || jsonb_build_object('client_txn_id', gen_random_uuid(),
        'register_id', v_reg, 'session_id', v_stale, 'business_at', now(), 'cashier_id', v_cashier));
      RAISE EXCEPTION 'SESSION_STALE attendu (vente en ligne)';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'SESSION_STALE' THEN RAISE; END IF;
    END;
    -- remboursement (différé, CB captée) également refusé
    BEGIN
      PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(),
        'register_id', v_reg, 'session_id', v_stale, 'kind', 'refund', 'business_at', now(),
        'refund_of_transaction_id', gen_random_uuid(), 'refund_reason', 'test 14', 'cashier_id', v_cashier,
        'deferred_capture', true,
        'lines', '[{"line_no":1,"label":"Gomme","qty":-1,"unit_price_ttc_cents":150,"vat_rate":20}]'::jsonb,
        'payments', '[{"method":"cb","amount_cents":-150}]'::jsonb));
      RAISE EXCEPTION 'SESSION_STALE attendu (remboursement)';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'SESSION_STALE' THEN RAISE; END IF;
    END;
    v_log := array_append(v_log, 'online_refused|vente et remboursement refusés sur session de la veille (SESSION_STALE)');

    -- 2. vente hors ligne vers la session périmée refusée
    v_offline := v_sale || jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
      'session_id', v_stale, 'business_at', now() - interval '5 minutes', 'cashier_id', v_cashier,
      'offline_queued', true, 'provisional_ref', 'OFF-T14-' || to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') || '-001');
    BEGIN
      PERFORM public.pos_finalize_sale(v_offline);
      RAISE EXCEPTION 'SESSION_STALE attendu (rejeu hors ligne)';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'SESSION_STALE' THEN RAISE; END IF;
    END;
    v_log := array_append(v_log, 'offline_refused|rejeu hors ligne vers une session périmée refusé');

    -- 3. JET session_stale, idempotent
    PERFORM public.pos_flag_stale_sessions();
    PERFORM public.pos_flag_stale_sessions();
    SELECT count(*) INTO v_n FROM public.pos_events
    WHERE register_id = v_reg AND event_type = 'session_stale' AND session_id = v_stale
      AND payload ->> 'session_id' = v_stale::text AND payload ? 'opened_at';
    IF v_n <> 1 THEN RAISE EXCEPTION 'session_stale : 1 événement attendu, % trouvés', v_n; END IF;
    v_log := array_append(v_log, 'jet_session_stale|1 événement session_stale (session_id, opened_at) après 2 passages');

    -- 4. Z1 de la veille, puis sans session : SESSION_NOT_OPEN
    v_close := public.pos_close_session(v_stale, 0, 'Z de la veille (test 14)', v_cashier);
    IF (v_close -> 'closing' ->> 'period_type') <> 'daily' THEN RAISE EXCEPTION 'Z1 absent : %', v_close; END IF;
    BEGIN
      PERFORM public.pos_finalize_sale(v_offline);
      RAISE EXCEPTION 'SESSION_NOT_OPEN attendu';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'SESSION_NOT_OPEN' THEN RAISE; END IF;
    END;
    v_log := array_append(v_log, 'z_then_no_session|Z1 n°' || (v_close -> 'closing' ->> 'closing_number') || ' établi ; sans session : SESSION_NOT_OPEN');

    -- 5. nouvelle session : vente acceptée, vente hors ligne rattachée
    v_new := public.pos_open_session(v_reg, 0, v_cashier);
    v_res := public.pos_finalize_sale(v_sale || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'register_id', v_reg, 'session_id', v_new.id, 'business_at', now(), 'cashier_id', v_cashier));
    IF (v_res -> 'transaction' ->> 'session_id')::uuid <> v_new.id THEN RAISE EXCEPTION 'vente : session inattendue'; END IF;
    v_res := public.pos_finalize_sale(v_offline);
    IF (v_res -> 'transaction' ->> 'session_id')::uuid <> v_new.id
       OR NOT EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'offline_reattached'
                      AND payload ->> 'original_session_id' = v_stale::text) THEN
      RAISE EXCEPTION 'rejeu hors ligne non rattaché : %', v_res;
    END IF;
    v_log := array_append(v_log, 'new_session_ok|vente acceptée ; vente hors ligne rattachée à la nouvelle session');

    RAISE EXCEPTION 'T14_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'T14_ROLLBACK' THEN RAISE; END IF;
  END;

  INSERT INTO pos_test_results
  SELECT split_part(l, '|', 1), true, split_part(l, '|', 2) FROM unnest(v_log) AS l;
  INSERT INTO pos_test_results VALUES ('rollback', true, 'caisse éphémère annulée : aucune trace en base');
END;
$$;

SELECT * FROM pos_test_results;
