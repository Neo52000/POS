-- =============================================================================
-- POS NF525 — test SQL 03 (projet « Pos ») : vecteurs de hash TS <-> SQL
-- -----------------------------------------------------------------------------
-- Source : packages/core/src/__fixtures__/hash-vectors.json (généré par le TS).
-- Avant exécution, remplacer le placeholder (ligne « v_raw text := $json$...$json$ »
-- ci-dessous, seul endroit où il apparaît) par le contenu JSON du fichier
-- (tableau). Format attendu de chaque vecteur :
--   {
--     "name": "...",
--     "register_code": "TESTVEC",            -- code de caisse utilisé par le TS
--     "ticket_number": 1,                    -- 1, 2, 3... dans l'ordre du fichier
--     "prev_hash": "",                       -- optionnel : sinon hash du vecteur précédent ('' pour le 1er)
--     "payload": { CheckoutPayload SPEC §4 : client_txn_id, kind, business_at,
--                  customer_account_id?, lines[], payments[], change_cents, totals? },
--     "canonical_string": "v1|1|TESTVEC|...", "hash": "<sha256 hex>",
--     "lines_digest": "...", "payments_digest": "..."   -- optionnels (ou sous "expected": {...})
--   }
--
-- Deux niveaux de vérification :
--   A) PUR (sans écriture) : pos_compute_cart + pos_lines_digest_from_json +
--      pos_payments_digest_from_json + pos_build_canonical_txn reproduisent
--      exactement canonical_string et hash de chaque vecteur, en s'enchaînant
--      dans l'ordre du fichier (le 1er avec prev_hash '').
--   B) LIVE : les vecteurs sont insérés via pos_finalize_sale sur une caisse
--      neuve TESTVEC-<aléatoire> (session ouverte pour l'occasion, client_txn_id
--      régénérés). Comme le code de caisse et les client_txn_id diffèrent, on
--      compare pos_canonical_txn(id) à la chaîne attendue reconstruite avec le
--      code/client_txn_id/prev_hash réels : cela prouve que ce qui est stocké
--      (lignes, paiements, totaux, ventilation, business_at) redonne les mêmes
--      lines_digest / payments_digest que le TS, et que pos_verify_chain passe.
--      Les remboursements (kind=refund) sont relus en pointant
--      refund_of_transaction_id vers le ticket live dont le client_txn_id
--      d'origine (dans le fichier) correspond ; sinon ils sont ignorés en LIVE.
-- Rejouable : oui (caisse aléatoire à chaque exécution ; les données restent).
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_raw        text := $json$__VECTORS__$json$;
  v_vectors    jsonb;
  v_vec        jsonb;
  v_exp        jsonb;
  v_payload    jsonb;
  v_idx        int := 0;
  v_prev       text := '';
  v_cart       jsonb;
  v_totals     jsonb;
  v_ld         text;
  v_pd         text;
  v_canon      text;
  v_hash       text;
  v_exp_canon  text;
  v_exp_hash   text;
  v_parts      text[];
  -- live
  v_reg        uuid;
  v_code       text := 'TESTVEC-' || upper(substr(md5(random()::text), 1, 8));
  v_session    uuid;
  v_cashier    uuid := gen_random_uuid();
  v_map        jsonb := '{}'::jsonb;    -- client_txn_id d'origine -> transaction_id live
  v_live_prev  text := '';
  v_res        jsonb;
  v_txn        jsonb;
  v_refund_of  uuid;
  v_live_canon text;
  v_chain      record;
  v_live_n     int := 0;
BEGIN
  IF v_raw !~ '^\s*[\[{]' THEN
    RAISE EXCEPTION 'Placeholder non remplacé : coller le contenu de packages/core/src/__fixtures__/hash-vectors.json dans v_raw';
  END IF;
  v_vectors := v_raw::jsonb;
  IF jsonb_typeof(v_vectors) = 'object' AND v_vectors ? 'vectors' THEN
    v_vectors := v_vectors -> 'vectors';
  END IF;
  IF jsonb_typeof(v_vectors) <> 'array' OR jsonb_array_length(v_vectors) = 0 THEN
    RAISE EXCEPTION 'vecteurs : tableau JSON non vide attendu';
  END IF;

  -- ===================================================== A) vérification pure
  FOR v_vec IN SELECT * FROM jsonb_array_elements(v_vectors) LOOP
    v_idx     := v_idx + 1;
    v_exp     := coalesce(v_vec -> 'expected', '{}'::jsonb) || (v_vec - 'payload' - 'expected');
    v_payload := v_vec -> 'payload';
    v_exp_canon := v_exp ->> 'canonical_string';
    v_exp_hash  := v_exp ->> 'hash';
    IF v_payload IS NULL OR v_exp_canon IS NULL OR v_exp_hash IS NULL THEN
      RAISE EXCEPTION 'vecteur % : payload, canonical_string et hash requis', v_idx;
    END IF;
    IF v_exp ? 'prev_hash' THEN
      v_prev := coalesce(v_exp ->> 'prev_hash', '');
    END IF;

    v_cart   := public.pos_compute_cart(v_payload -> 'lines');
    v_totals := v_cart -> 'totals';
    v_ld     := public.pos_lines_digest_from_json(v_cart -> 'lines');
    v_pd     := public.pos_payments_digest_from_json(v_payload -> 'payments');

    IF v_exp ? 'lines_digest' AND (v_exp ->> 'lines_digest') <> v_ld THEN
      RAISE EXCEPTION 'vecteur % (%) : lines_digest attendu % obtenu %', v_idx, v_vec ->> 'name', v_exp ->> 'lines_digest', v_ld;
    END IF;
    IF v_exp ? 'payments_digest' AND (v_exp ->> 'payments_digest') <> v_pd THEN
      RAISE EXCEPTION 'vecteur % (%) : payments_digest attendu % obtenu %', v_idx, v_vec ->> 'name', v_exp ->> 'payments_digest', v_pd;
    END IF;
    IF v_payload ? 'totals' AND (
         (v_payload -> 'totals' ->> 'total_ttc_cents')::bigint <> (v_totals ->> 'total_ttc_cents')::bigint
      OR (v_payload -> 'totals' ->> 'total_vat_cents')::bigint <> (v_totals ->> 'total_vat_cents')::bigint
      OR (v_payload -> 'totals' ->> 'total_ht_cents')::bigint  <> (v_totals ->> 'total_ht_cents')::bigint) THEN
      RAISE EXCEPTION 'vecteur % (%) : totaux TS % <> SQL %', v_idx, v_vec ->> 'name', v_payload -> 'totals', v_totals;
    END IF;

    v_canon := public.pos_build_canonical_txn(
      coalesce((v_exp ->> 'ticket_number')::bigint, v_idx),
      coalesce(v_exp ->> 'register_code', split_part(v_exp_canon, '|', 3)),
      (v_payload ->> 'client_txn_id')::uuid,
      (v_payload ->> 'business_at')::timestamptz,
      v_payload ->> 'kind',
      (v_totals ->> 'total_ht_cents')::bigint, (v_totals ->> 'total_vat_cents')::bigint, (v_totals ->> 'total_ttc_cents')::bigint,
      v_cart -> 'vat_breakdown',
      nullif(v_payload ->> 'customer_account_id', '')::uuid,
      v_ld, v_pd, v_prev);
    v_hash := public.pos_sha256(v_canon);

    IF v_canon <> v_exp_canon THEN
      RAISE EXCEPTION E'vecteur % (%) : chaîne canonique différente\n  attendu : %\n  obtenu  : %', v_idx, v_vec ->> 'name', v_exp_canon, v_canon;
    END IF;
    IF v_hash <> v_exp_hash THEN
      RAISE EXCEPTION 'vecteur % (%) : hash attendu % obtenu %', v_idx, v_vec ->> 'name', v_exp_hash, v_hash;
    END IF;
    INSERT INTO pos_test_results VALUES ('pure:' || v_idx, true, coalesce(v_vec ->> 'name', '') || ' hash=' || left(v_hash, 12));
    v_prev := v_hash;
  END LOOP;
  INSERT INTO pos_test_results VALUES ('pure_all', true, v_idx || ' vecteurs : canonical_string et hash identiques au TS');

  -- ===================================================== B) vérification live
  INSERT INTO public.pos_registers (code, label) VALUES (v_code, 'Vecteurs de hash (test)') RETURNING id INTO v_reg;
  SELECT id INTO v_session FROM public.pos_open_session(v_reg, 0, v_cashier);

  v_idx := 0;
  FOR v_vec IN SELECT * FROM jsonb_array_elements(v_vectors) LOOP
    v_idx     := v_idx + 1;
    v_exp     := coalesce(v_vec -> 'expected', '{}'::jsonb) || (v_vec - 'payload' - 'expected');
    v_payload := v_vec -> 'payload';
    v_parts   := string_to_array(v_exp ->> 'canonical_string', '|');

    v_refund_of := NULL;
    IF (v_payload ->> 'kind') = 'refund' THEN
      v_refund_of := (v_map ->> coalesce(v_payload ->> 'refund_of_transaction_id', ''))::uuid;
      IF v_refund_of IS NULL THEN
        INSERT INTO pos_test_results VALUES ('live:' || v_idx, true, 'refund ignoré en live (cible inconnue)');
        CONTINUE;
      END IF;
    END IF;

    v_res := public.pos_finalize_sale(v_payload || jsonb_build_object(
      'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_session, 'cashier_id', v_cashier,
      'refund_of_transaction_id', v_refund_of,
      'refund_reason', coalesce(v_payload ->> 'refund_reason', 'test vecteur')));
    v_txn := v_res -> 'transaction';
    v_map := v_map || jsonb_build_object(coalesce(v_payload ->> 'client_txn_id', 'vec' || v_idx), v_txn ->> 'id');
    v_live_n := v_live_n + 1;

    -- chaîne attendue avec les valeurs réelles (code caisse, client_txn_id, n°, prev_hash) et les digests du TS
    v_live_canon := public.pos_build_canonical_txn(
      (v_txn ->> 'ticket_number')::bigint, v_code, (v_txn ->> 'client_txn_id')::uuid, (v_txn ->> 'business_at')::timestamptz,
      v_txn ->> 'kind', v_parts[7]::bigint, v_parts[8]::bigint, v_parts[9]::bigint,
      v_txn -> 'vat_breakdown', nullif(v_parts[11], '')::uuid, v_parts[12], v_parts[13], v_live_prev);
    IF public.pos_canonical_txn((v_txn ->> 'id')::uuid) <> v_live_canon THEN
      RAISE EXCEPTION E'vecteur % (%) live : chaîne relue différente\n  attendu : %\n  obtenu  : %', v_idx, v_vec ->> 'name', v_live_canon, public.pos_canonical_txn((v_txn ->> 'id')::uuid);
    END IF;
    IF public.pos_canonical_vat_breakdown(v_txn -> 'vat_breakdown') <> v_parts[10] THEN
      RAISE EXCEPTION 'vecteur % live : vat_breakdown % <> %', v_idx, public.pos_canonical_vat_breakdown(v_txn -> 'vat_breakdown'), v_parts[10];
    END IF;
    IF (v_txn ->> 'ticket_number')::bigint <> v_live_n THEN
      RAISE EXCEPTION 'vecteur % live : ticket_number % attendu %', v_idx, v_txn ->> 'ticket_number', v_live_n;
    END IF;
    v_live_prev := v_txn ->> 'hash';
    INSERT INTO pos_test_results VALUES ('live:' || v_idx, true, 'ticket ' || (v_txn ->> 'ticket_number') || ' sur ' || v_code);
  END LOOP;

  SELECT * INTO v_chain FROM public.pos_verify_chain(v_reg);
  IF NOT v_chain.ok THEN
    RAISE EXCEPTION 'pos_verify_chain KO sur % : % (ticket %)', v_code, v_chain.reason, v_chain.first_break_ticket;
  END IF;
  INSERT INTO pos_test_results VALUES ('live_all', true, v_live_n || ' tickets insérés sur ' || v_code || ', chaîne vérifiée');
END $$;

SELECT * FROM pos_test_results;
