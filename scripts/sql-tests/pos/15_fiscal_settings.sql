-- =============================================================================
-- POS NF525 — test SQL 15 (projet « Pos ») : paramétrage fiscal tracé
-- (0.4.0, lot 3)
-- -----------------------------------------------------------------------------
-- Caisses éphémères T15-<horodatage> ; tout est annulé à la fin (sous-bloc).
-- Vérifie : INSERT/UPDATE directs refusés à `authenticated` ; RPC sans motif,
-- clé ou colonne hors liste blanche refusées ; code de caisse immuable (RPC et
-- UPDATE direct) ; register_change au JET avec old/new/motif ; live → test
-- autorisé sans transaction puis refusé après une vente ; DELETE de paramètre
-- refusé ; clock_tolerance plafonnée (offline_hours 72, online_minutes 10), y
-- compris en UPDATE direct par le propriétaire.
-- settings_change (journalisé sur CHAQUE caisse active, donc CHAUMONT-01) n'est
-- exercé qu'en base locale : `PGOPTIONS='-c pos.test_local=on' psql …`. Sur le
-- projet Pos il est ignoré (règle : aucun essai sur CHAUMONT-01).
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_ts      text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
  v_reg     uuid;
  v_live    uuid;
  v_cashier uuid := gen_random_uuid();
  v_sess    public.pos_sessions;
  v_ev      jsonb;
  v_n       int;
  v_log     text[] := '{}';
  v_local   boolean := coalesce(current_setting('pos.test_local', true), '') = 'on';
  v_old_max jsonb;
BEGIN
  BEGIN
    INSERT INTO public.pos_registers (code, label) VALUES ('T15-' || v_ts, 'Caisse éphémère test 15') RETURNING id INTO v_reg;

    -- 1. écritures directes refusées à authenticated
    FOR v_n IN 1..4 LOOP
      BEGIN
        EXECUTE 'SET LOCAL ROLE authenticated';
        CASE v_n
          WHEN 1 THEN UPDATE public.pos_settings SET value = '100'::jsonb WHERE key = 'offline_max_txns';
          WHEN 2 THEN INSERT INTO public.pos_settings (key, value) VALUES ('t15', '1'::jsonb);
          WHEN 3 THEN UPDATE public.pos_registers SET label = 'pirate' WHERE id = v_reg;
          ELSE INSERT INTO public.pos_registers (code, label) VALUES ('T15-PIRATE-' || v_ts, 'pirate');
        END CASE;
        RAISE EXCEPTION 'écriture directe acceptée (cas %)', v_n;
      EXCEPTION WHEN insufficient_privilege THEN NULL;
      END;
    END LOOP;
    EXECUTE 'RESET ROLE';
    v_log := array_append(v_log, 'direct_write_refused|INSERT/UPDATE directs refusés (pos_settings, pos_registers)');

    -- 2. RPC : motif obligatoire, listes blanches, code immuable
    BEGIN
      PERFORM public.pos_admin_update_register(v_reg, '{"label":"Nouveau libellé"}'::jsonb, 'court');
      RAISE EXCEPTION 'motif court accepté';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM public.pos_admin_set_setting('offline_max_txns', '60'::jsonb, NULL);
      RAISE EXCEPTION 'motif absent accepté';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM public.pos_admin_set_setting('software', '{"version":"9.9.9"}'::jsonb, 'motif assez long');
      RAISE EXCEPTION 'clé software acceptée';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM public.pos_admin_update_register(v_reg, '{"created_at":"2020-01-01"}'::jsonb, 'motif assez long');
      RAISE EXCEPTION 'colonne hors liste blanche acceptée';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
    END;
    BEGIN
      PERFORM public.pos_admin_update_register(v_reg, '{"code":"AUTRE"}'::jsonb, 'motif assez long');
      RAISE EXCEPTION 'changement de code accepté (RPC)';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'REGISTER_CODE_IMMUTABLE' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE public.pos_registers SET code = 'AUTRE-' || v_ts WHERE id = v_reg;
      RAISE EXCEPTION 'changement de code accepté (UPDATE direct)';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'REGISTER_CODE_IMMUTABLE' THEN RAISE; END IF;
    END;
    v_log := array_append(v_log, 'rpc_guards|motif < 10 car., clé software, colonne inconnue, code (RPC et direct) refusés');

    -- 3. register_change : old / new / motif
    PERFORM public.pos_admin_update_register(v_reg, '{"label":"Libellé modifié test 15"}'::jsonb, 'Renommage de la caisse de test');
    SELECT payload INTO v_ev FROM public.pos_events
    WHERE register_id = v_reg AND event_type = 'register_change' AND payload ->> 'op' = 'update'
    ORDER BY id DESC LIMIT 1;
    IF v_ev IS NULL OR v_ev -> 'old' ->> 'label' <> 'Caisse éphémère test 15'
       OR v_ev -> 'new' ->> 'label' <> 'Libellé modifié test 15'
       OR v_ev -> 'actor' ->> 'reason' <> 'Renommage de la caisse de test'
       OR v_ev -> 'actor' ->> 'via' <> 'rpc' OR NOT (v_ev -> 'changed') ? 'label' THEN
      RAISE EXCEPTION 'register_change incomplet : %', v_ev;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'register_change'
                   AND payload ->> 'op' = 'insert' AND payload -> 'old' = 'null'::jsonb) THEN
      RAISE EXCEPTION 'register_change de création absent';
    END IF;
    v_log := array_append(v_log, 'register_change|JET register_change : old/new label, motif, via rpc ; création tracée');

    -- 4. live → test : libre sans transaction, refusé après une vente
    INSERT INTO public.pos_registers (code, label, fiskaly_env) VALUES ('T15-LIVE-' || v_ts, 'Live éphémère test 15', 'live') RETURNING id INTO v_live;
    PERFORM public.pos_admin_update_register(v_live, '{"fiskaly_env":"test"}'::jsonb, 'Retour en test avant mise en service');
    PERFORM public.pos_admin_update_register(v_live, '{"fiskaly_env":"live"}'::jsonb, 'Mise en service (test 15 éphémère)');
    v_sess := public.pos_open_session(v_live, 0, v_cashier);
    PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_live,
      'session_id', v_sess.id, 'kind', 'sale', 'business_at', now(), 'cashier_id', v_cashier,
      'lines', '[{"line_no":1,"label":"Règle","qty":1,"unit_price_ttc_cents":300,"vat_rate":20}]'::jsonb,
      'payments', '[{"method":"cash","amount_cents":300}]'::jsonb));
    BEGIN
      PERFORM public.pos_admin_update_register(v_live, '{"fiskaly_env":"test"}'::jsonb, 'Tentative de retour en test');
      RAISE EXCEPTION 'live -> test accepté après une transaction live';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'REGISTER_LIVE_LOCKED' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE public.pos_registers SET fiskaly_env = 'test' WHERE id = v_live;
      RAISE EXCEPTION 'live -> test accepté (UPDATE direct)';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'REGISTER_LIVE_LOCKED' THEN RAISE; END IF;
    END;
    v_log := array_append(v_log, 'live_lock|live → test libre sans transaction, refusé (RPC et direct) après une vente live');

    -- 5. DELETE de paramètre refusé
    BEGIN
      DELETE FROM public.pos_settings WHERE key = 'clock_tolerance';
      RAISE EXCEPTION 'DELETE pos_settings accepté';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NF525:%' THEN RAISE; END IF;
    END;
    v_log := array_append(v_log, 'settings_no_delete|DELETE pos_settings refusé (NF525)');

    -- 6. clock_tolerance plafonnée, tous chemins (RPC et UPDATE direct)
    BEGIN
      PERFORM public.pos_admin_set_setting('clock_tolerance', '{"online_minutes":10,"offline_hours":73,"future_minutes":5}'::jsonb, 'Relève exceptionnelle de la tolérance');
      RAISE EXCEPTION 'offline_hours 73 accepté';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'CLOCK_TOLERANCE_OUT_OF_RANGE' THEN RAISE; END IF;
    END;
    BEGIN
      UPDATE public.pos_settings SET value = '{"online_minutes":600000,"offline_hours":72,"future_minutes":5}'::jsonb
      WHERE key = 'clock_tolerance';
      RAISE EXCEPTION 'online_minutes 600000 accepté (UPDATE direct)';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM <> 'CLOCK_TOLERANCE_OUT_OF_RANGE' THEN RAISE; END IF;
    END;
    v_log := array_append(v_log, 'clock_tolerance_caps|offline_hours > 72 et online_minutes > 10 refusés (RPC et direct)');

    -- 7. settings_change (base locale uniquement)
    IF v_local THEN
      SELECT value INTO v_old_max FROM public.pos_settings WHERE key = 'offline_max_txns';
      PERFORM public.pos_admin_set_setting('offline_max_txns', to_jsonb((v_old_max #>> '{}')::int + 1), 'Augmentation de la limite hors ligne');
      SELECT count(*) INTO v_n FROM public.pos_events e
      WHERE e.event_type = 'settings_change' AND e.payload ->> 'key' = 'offline_max_txns'
        AND e.payload -> 'old' = v_old_max AND (e.payload ->> 'new')::int = (v_old_max #>> '{}')::int + 1
        AND e.payload -> 'actor' ->> 'reason' = 'Augmentation de la limite hors ligne'
        AND e.created_at = now();
      IF v_n <> (SELECT count(*) FROM public.pos_registers WHERE is_active) THEN
        RAISE EXCEPTION 'settings_change : % événement(s) pour % caisse(s) active(s)', v_n,
          (SELECT count(*) FROM public.pos_registers WHERE is_active);
      END IF;
      v_log := array_append(v_log, 'settings_change|JET settings_change old/new/motif sur chacune des ' || v_n || ' caisses actives');
    ELSE
      v_log := array_append(v_log, 'settings_change|ignoré hors base locale (journalisé sur CHAUMONT-01) : PGOPTIONS=''-c pos.test_local=on''');
    END IF;

    RAISE EXCEPTION 'T15_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'T15_ROLLBACK' THEN RAISE; END IF;
  END;

  INSERT INTO pos_test_results
  SELECT split_part(l, '|', 1), true, split_part(l, '|', 2) FROM unnest(v_log) AS l;
  INSERT INTO pos_test_results VALUES ('rollback', true, 'caisses éphémères annulées : aucune trace en base');
END;
$$;

SELECT * FROM pos_test_results;
