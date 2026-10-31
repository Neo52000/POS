-- =============================================================================
-- POS NF525 — test SQL 17 (projet « Pos ») : file hors ligne vérifiable
-- (0.4.0, lot 5)
-- -----------------------------------------------------------------------------
-- Caisse éphémère T17-<horodatage>, tout est annulé à la fin (sous-bloc).
-- Vérifie : inscription des références OFF-… ; trou détecté au rejeu (JET
-- offline_gap, numéros manquants) ; chaînage local tracé au JET de la vente et
-- maillon manquant détecté ; fin de file déclarée par offline_exit
-- (last_seq_by_day) ; abandon tracé qui résout un numéro ; références invalide
-- et en double journalisées ; Z1 : offline_gaps figé, JET offline_gap
-- (detected_by = closing) et compteur dans l'événement closing ; hash v1 du
-- ticket inchangé par le chaînage (vérifié par pos_verify_chain).
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_code    text := 'T17-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
  v_reg     uuid;
  v_cashier uuid := gen_random_uuid();
  v_sess    public.pos_sessions;
  v_day     text := to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYYMMDD');
  v_base    jsonb;
  v_res     jsonb;
  v_ev      jsonb;
  v_gaps    int[];
  v_close   jsonb;
  v_n       int;
  v_chk     record;
  v_log     text[] := '{}';
  v_h1      text := encode(extensions.digest('h1', 'sha256'), 'hex');
  v_h2      text := encode(extensions.digest('h2', 'sha256'), 'hex');
  v_h3      text := encode(extensions.digest('h3', 'sha256'), 'hex');
  v_h4      text := encode(extensions.digest('h4', 'sha256'), 'hex');
BEGIN
  BEGIN
    INSERT INTO public.pos_registers (code, label) VALUES (v_code, 'Caisse éphémère test 17') RETURNING id INTO v_reg;
    v_sess := public.pos_open_session(v_reg, 0, v_cashier);
    v_base := jsonb_build_object('kind', 'sale', 'register_id', v_reg, 'session_id', v_sess.id, 'cashier_id', v_cashier,
      'offline_queued', true, 'business_at', now() - interval '10 minutes',
      'lines', '[{"line_no":1,"label":"Crayon","qty":1,"unit_price_ttc_cents":120,"vat_rate":20}]'::jsonb,
      'payments', '[{"method":"cash","amount_cents":120}]'::jsonb);

    -- 1. OFF-…-001 (premier maillon) puis OFF-…-003 : trou n°2
    v_res := public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'provisional_ref', 'OFF-' || v_code || '-' || v_day || '-001', 'offline_chain_prev', '', 'offline_chain_hash', v_h1));
    IF EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'offline_gap') THEN
      RAISE EXCEPTION 'offline_gap inattendu après le n°1';
    END IF;
    SELECT payload INTO v_ev FROM public.pos_events WHERE register_id = v_reg AND event_type = 'sale' ORDER BY id DESC LIMIT 1;
    IF v_ev ->> 'offline_chain_hash' <> v_h1 THEN RAISE EXCEPTION 'chaînage absent du JET de la vente : %', v_ev; END IF;
    v_res := public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'provisional_ref', 'OFF-' || v_code || '-' || v_day || '-003', 'offline_chain_prev', v_h2, 'offline_chain_hash', v_h3));
    SELECT payload INTO v_ev FROM public.pos_events WHERE register_id = v_reg AND event_type = 'offline_gap' ORDER BY id DESC LIMIT 1;
    IF v_ev IS NULL OR v_ev -> 'missing' <> '[2]'::jsonb OR v_ev ->> 'detected_by' <> 'replay' THEN
      RAISE EXCEPTION 'offline_gap au rejeu incorrect : %', v_ev;
    END IF;
    SELECT count(*) INTO v_n FROM public.pos_offline_chain_breaks(v_reg);
    IF v_n <> 1 THEN RAISE EXCEPTION 'maillon manquant non détecté (% rupture)', v_n; END IF;
    v_log := array_append(v_log, 'gap_on_replay|n°1 puis n°3 : JET offline_gap missing=[2] ; chaînage au JET, 1 maillon manquant');

    -- 2. fin de file déclarée (offline_exit) : n°4 et n°5 attribués, jamais reçus
    PERFORM public.pos_log_event('offline_exit', jsonb_build_object('last_seq_by_day', jsonb_build_object(v_day, 5)), now(), v_reg, v_sess.id);
    SELECT g.missing INTO v_gaps FROM public.pos_offline_gaps(v_reg) g;
    IF v_gaps <> ARRAY[2, 4, 5] THEN RAISE EXCEPTION 'trous attendus {2,4,5}, obtenus %', v_gaps; END IF;
    v_log := array_append(v_log, 'tail_deletion|offline_exit last_seq=5 : trous {2,4,5} (suppression en fin de file)');

    -- 3. abandon tracé du n°4 : résolu
    PERFORM public.pos_log_event('offline_sale_abandoned', jsonb_build_object('client_txn_id', gen_random_uuid(),
      'provisional_ref', 'OFF-' || v_code || '-' || v_day || '-004', 'reason', 'Vente ressaisie en ligne (test 17)',
      'payload', jsonb_build_object('offline_chain_prev', v_h3, 'offline_chain_hash', v_h4)), now(), v_reg, v_sess.id);
    SELECT g.missing INTO v_gaps FROM public.pos_offline_gaps(v_reg) g;
    IF v_gaps <> ARRAY[2, 5] THEN RAISE EXCEPTION 'après abandon : trous attendus {2,5}, obtenus %', v_gaps; END IF;
    v_log := array_append(v_log, 'abandon_resolves|abandon tracé du n°4 : trous {2,5}');

    -- 4. références invalide et en double
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'provisional_ref', 'OFF-AUTRE-CAISSE-' || v_day || '-009'));
    PERFORM public.pos_finalize_sale(v_base || jsonb_build_object('client_txn_id', gen_random_uuid(),
      'provisional_ref', 'OFF-' || v_code || '-' || v_day || '-001'));
    IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'offline_ref_invalid')
       OR NOT EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'offline_ref_duplicate') THEN
      RAISE EXCEPTION 'offline_ref_invalid / offline_ref_duplicate absents';
    END IF;
    v_log := array_append(v_log, 'invalid_duplicate|ventes enregistrées, JET offline_ref_invalid et offline_ref_duplicate');

    -- 5. Z1 : trous non résolus figés et journalisés
    v_close := public.pos_close_session(v_sess.id, 480, 'Z test 17', v_cashier);
    IF (v_close -> 'closing' -> 'offline_gaps' ->> 'count')::int <> 2
       OR (v_close -> 'closing' -> 'offline_gaps' ->> 'chain_breaks')::int <> 1 THEN
      RAISE EXCEPTION 'Z1 offline_gaps incorrect : %', v_close -> 'closing' -> 'offline_gaps';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'offline_gap'
                   AND payload ->> 'detected_by' = 'closing' AND (payload ->> 'count')::int = 2)
       OR NOT EXISTS (SELECT 1 FROM public.pos_events WHERE register_id = v_reg AND event_type = 'closing'
                      AND (payload ->> 'offline_gaps_unresolved')::int = 2) THEN
      RAISE EXCEPTION 'JET de clôture sans les trous non résolus';
    END IF;
    v_log := array_append(v_log, 'z1_mentions_gaps|Z1 : offline_gaps.count = 2, chain_breaks = 1 ; JET offline_gap (closing) et closing');

    -- 6. hash v1 des tickets et JET intacts
    SELECT * INTO v_chk FROM public.pos_verify_chain(v_reg);
    IF NOT v_chk.ok OR v_chk.checked <> 4 THEN RAISE EXCEPTION 'pos_verify_chain : %', to_jsonb(v_chk); END IF;
    SELECT * INTO v_chk FROM public.pos_verify_events_chain(v_reg);
    IF NOT v_chk.ok THEN RAISE EXCEPTION 'pos_verify_events_chain : %', to_jsonb(v_chk); END IF;
    v_log := array_append(v_log, 'chains_ok|4 tickets v1 et JET vérifiés');

    RAISE EXCEPTION 'T17_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'T17_ROLLBACK' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results
  SELECT split_part(l, '|', 1), true, split_part(l, '|', 2) FROM unnest(v_log) AS l;
  INSERT INTO pos_test_results VALUES ('rollback', true, 'caisse éphémère annulée : aucune trace en base');
END;
$$;

SELECT * FROM pos_test_results;
