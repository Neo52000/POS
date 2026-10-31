-- =============================================================================
-- POS NF525 — test SQL 18 (projet « Pos ») : hash de clôture v2, ancrage du JET
-- et des archives (0.4.0, lot 6)
-- -----------------------------------------------------------------------------
-- A) Vecteurs figés (packages/core/src/__fixtures__/closing-vectors.json, recopiés
--    ci-dessous) : pos_closing_canonical / pos_closing_hash ≡ @pos/core closing.ts,
--    v1 et v2.
-- B) Caisse éphémère T18-<horodatage>, tout est annulé à la fin : Z1 en v2 (têtes
--    JET), chaîne vérifiée ; falsification d'un événement du JET AVEC recalcul de
--    toute la chaîne d'événements (session_replication_role = replica, propre à
--    la session, annulé) : pos_verify_events_chain ne voit rien, la clôture
--    détecte (JET_HEAD_MISMATCH). Les clôtures v1 existantes restent vérifiables.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_vec     record;
  v_n       int := 0;
  v_reg     uuid;
  v_cashier uuid := gen_random_uuid();
  v_sess    public.pos_sessions;
  v_close   jsonb;
  v_c       public.pos_closings;
  v_chk     record;
  v_ev      record;
  v_prev    text;
  v_forged  bigint;
  v_log     text[] := '{}';
BEGIN
  -- A. vecteurs figés
  FOR v_vec IN
    SELECT * FROM (VALUES
      (1, 1, 'daily', '2026-10-30T23:00:00.000Z'::timestamptz, '2026-10-31T18:42:07.123Z'::timestamptz, 12, 45678, 1234567, NULL, NULL, '', 'v1|closing|1|daily|2026-10-30T23:00:00.000Z|2026-10-31T18:42:07.123Z|12|45678|1234567|', '900f274fd69b57a38614e391c27676a6021cfd80c41cc03ac8eb2d1272dc78d8'),
      (2, 2, 'monthly', '2026-09-30T22:00:00.000Z'::timestamptz, '2026-10-31T23:00:00.000Z'::timestamptz, 340, 987654, 2222221, '10bbd657c28529b5fc6ace9c0248ba5140b07ef30cd606d3c49cc9d5504d792e', 'a78c1be1e33f454618db26c891dc1d2efd8fb24c7cce5d0678ee9a846df11c54', '900f274fd69b57a38614e391c27676a6021cfd80c41cc03ac8eb2d1272dc78d8', 'v2|closing|2|monthly|2026-09-30T22:00:00.000Z|2026-10-31T23:00:00.000Z|340|987654|2222221|10bbd657c28529b5fc6ace9c0248ba5140b07ef30cd606d3c49cc9d5504d792e|a78c1be1e33f454618db26c891dc1d2efd8fb24c7cce5d0678ee9a846df11c54|900f274fd69b57a38614e391c27676a6021cfd80c41cc03ac8eb2d1272dc78d8', 'db91dbcf57ffa5274cc9a18e8c104a02b4cbb99ca0ca33a7f5e61f9b2a08cb29'),
      (2, 3, 'daily', '2026-10-31T23:00:00.000Z'::timestamptz, '2026-11-01T17:00:00.000Z'::timestamptz, 0, 0, 2222221, '10bbd657c28529b5fc6ace9c0248ba5140b07ef30cd606d3c49cc9d5504d792e', NULL, 'db91dbcf57ffa5274cc9a18e8c104a02b4cbb99ca0ca33a7f5e61f9b2a08cb29', 'v2|closing|3|daily|2026-10-31T23:00:00.000Z|2026-11-01T17:00:00.000Z|0|0|2222221|10bbd657c28529b5fc6ace9c0248ba5140b07ef30cd606d3c49cc9d5504d792e||db91dbcf57ffa5274cc9a18e8c104a02b4cbb99ca0ca33a7f5e61f9b2a08cb29', '5131c48c6c3156952381e38a3fd8ed322ce3a70f0c35b65930beb57587db67b3')
    ) AS t(ver, num, ptype, pstart, pend, txn, ttc, gtp, jet, arch, prev, canonical, hash)
  LOOP
    IF public.pos_closing_canonical(v_vec.ver, v_vec.num, v_vec.ptype, v_vec.pstart, v_vec.pend, v_vec.txn,
                                     v_vec.ttc, v_vec.gtp, v_vec.jet, v_vec.arch, v_vec.prev) <> v_vec.canonical
       OR public.pos_closing_hash(v_vec.ver, v_vec.num, v_vec.ptype, v_vec.pstart, v_vec.pend, v_vec.txn,
                                  v_vec.ttc, v_vec.gtp, v_vec.jet, v_vec.arch, v_vec.prev) <> v_vec.hash THEN
      RAISE EXCEPTION 'vecteur de clôture n°% (v%) divergent', v_vec.num, v_vec.ver;
    END IF;
    v_n := v_n + 1;
  END LOOP;
  INSERT INTO pos_test_results VALUES ('vectors', true, v_n || ' vecteurs figés (v1, v2, v2 sans archive) ≡ @pos/core');

  -- B. clôture v2 réelle puis falsification du JET
  BEGIN
    INSERT INTO public.pos_registers (code, label)
    VALUES ('T18-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), 'Caisse éphémère test 18')
    RETURNING id INTO v_reg;
    v_sess := public.pos_open_session(v_reg, 0, v_cashier);
    PERFORM public.pos_finalize_sale(jsonb_build_object('client_txn_id', gen_random_uuid(), 'register_id', v_reg,
      'session_id', v_sess.id, 'kind', 'sale', 'business_at', now(), 'cashier_id', v_cashier,
      'lines', '[{"line_no":1,"label":"Classeur","qty":1,"unit_price_ttc_cents":450,"vat_rate":20}]'::jsonb,
      'payments', '[{"method":"cash","amount_cents":450}]'::jsonb));
    v_close := public.pos_close_session(v_sess.id, 450, 'Z test 18', v_cashier);
    SELECT * INTO v_c FROM public.pos_closings WHERE id = (v_close -> 'closing' ->> 'id')::uuid;
    IF v_c.hash_version <> 2 OR v_c.jet_head_event_id IS NULL
       OR v_c.jet_head_hash <> (SELECT e.hash FROM public.pos_events e WHERE e.id = v_c.jet_head_event_id)
       OR v_c.jet_head_event_id <> (SELECT max(e.id) FROM public.pos_events e WHERE e.register_id = v_reg AND e.event_type <> 'closing'
                                     AND e.event_type <> 'session_close')
       OR v_c.hash <> public.pos_closing_hash(2, v_c.closing_number, v_c.period_type, v_c.period_start, v_c.period_end,
            v_c.txn_count, v_c.total_ttc_cents, v_c.grand_total_perpetual_cents, v_c.jet_head_hash, v_c.archive_head_hash, v_c.prev_hash) THEN
      RAISE EXCEPTION 'Z1 v2 incorrect : %', to_jsonb(v_c);
    END IF;
    SELECT * INTO v_chk FROM public.pos_verify_closings_chain(v_reg);
    IF NOT v_chk.ok THEN RAISE EXCEPTION 'chaîne des clôtures : %', to_jsonb(v_chk); END IF;
    v_log := array_append(v_log, 'z1_v2|Z1 hash_version 2, tête JET = dernier événement avant la clôture, chaîne OK');

    -- falsification « parfaite » : payload de la vente modifié, hash et prev_hash recalculés
    SET LOCAL session_replication_role = replica;
    SELECT e.id INTO v_forged FROM public.pos_events e WHERE e.register_id = v_reg AND e.event_type = 'sale';
    UPDATE public.pos_events SET payload = jsonb_set(payload, '{total_ttc_cents}', '1') WHERE id = v_forged;
    SELECT coalesce(e.prev_hash, '') INTO v_prev FROM public.pos_events e WHERE e.id = v_forged;
    FOR v_ev IN SELECT * FROM public.pos_events e WHERE e.register_id = v_reg AND e.id >= v_forged ORDER BY e.id LOOP
      UPDATE public.pos_events
      SET prev_hash = v_prev,
          hash = public.pos_event_hash(v_ev.id, v_ev.register_id, v_ev.event_type, v_ev.payload, v_ev.created_at, v_prev)
      WHERE id = v_ev.id
      RETURNING hash INTO v_prev;
    END LOOP;
    SET LOCAL session_replication_role = origin;
    SELECT * INTO v_chk FROM public.pos_verify_events_chain(v_reg);
    IF NOT v_chk.ok THEN RAISE EXCEPTION 'la falsification devait être invisible pour la chaîne du JET seule'; END IF;
    SELECT * INTO v_chk FROM public.pos_verify_closings_chain(v_reg);
    IF v_chk.ok OR v_chk.reason <> 'JET_HEAD_MISMATCH' OR v_chk.first_break_number <> v_c.closing_number THEN
      RAISE EXCEPTION 'falsification du JET non détectée par la clôture : %', to_jsonb(v_chk);
    END IF;
    v_log := array_append(v_log, 'jet_forgery_detected|JET réécrit et rechaîné : pos_verify_events_chain OK, pos_verify_closings_chain → JET_HEAD_MISMATCH');

    RAISE EXCEPTION 'T18_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'T18_ROLLBACK' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results
  SELECT split_part(l, '|', 1), true, split_part(l, '|', 2) FROM unnest(v_log) AS l;
  INSERT INTO pos_test_results VALUES ('rollback', true, 'caisse éphémère annulée : aucune trace en base');
END;
$$;

SELECT * FROM pos_test_results;
