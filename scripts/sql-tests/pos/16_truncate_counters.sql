-- =============================================================================
-- POS NF525 — test SQL 16 (projet « Pos ») : TRUNCATE interdit, compteurs
-- monotones (0.4.0, lot 4)
-- -----------------------------------------------------------------------------
-- Chaque tentative a lieu dans un sous-bloc annulé : même si un garde-fou
-- manquait, le TRUNCATE serait annulé (TRUNCATE est transactionnel). Prend un
-- verrou exclusif très bref sur chaque table : à lancer hors heures d'ouverture.
-- Caisse éphémère T16-<horodatage> pour les compteurs, annulée à la fin.
-- Vérifie : trigger BEFORE TRUNCATE présent et effectif (TRUNCATE … CASCADE
-- refusé « NF525 ») sur chaque table ; aucun droit TRUNCATE pour service_role /
-- authenticated / anon ; TRUNCATE en service_role refusé ; compteur : -1, +2,
-- changement de type et DELETE refusés, +1 accepté.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

DO $$
DECLARE
  v_tables text[] := ARRAY[
    'pos_transactions', 'pos_transaction_lines', 'pos_payments', 'pos_events', 'pos_closings',
    'pos_sessions', 'pos_archives', 'pos_counters', 'pos_stock_sync',
    'pos_order_settlements', 'pos_document_settlements', 'pos_transaction_passage_contacts',
    'pos_settings', 'pos_registers'];
  v_t      text;
  v_n      int := 0;
  v_reg    uuid;
  v_val    bigint;
  v_log    text[] := '{}';
  v_case   int;
BEGIN
  -- 1. triggers + droits
  FOREACH v_t IN ARRAY v_tables LOOP
    CONTINUE WHEN to_regclass('public.' || v_t) IS NULL;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = ('public.' || v_t)::regclass
                   AND NOT tg.tgisinternal AND (tg.tgtype & 32) <> 0) THEN
      RAISE EXCEPTION 'trigger BEFORE TRUNCATE absent sur %', v_t;
    END IF;
    IF has_table_privilege('service_role', 'public.' || v_t, 'TRUNCATE')
       OR has_table_privilege('authenticated', 'public.' || v_t, 'TRUNCATE')
       OR has_table_privilege('anon', 'public.' || v_t, 'TRUNCATE') THEN
      RAISE EXCEPTION 'droit TRUNCATE encore accordé sur %', v_t;
    END IF;
    -- 2. effectivité (CASCADE : les tables référencées sont aussi couvertes)
    BEGIN
      EXECUTE format('TRUNCATE public.%I CASCADE', v_t);
      RAISE EXCEPTION 'TRUNCATE accepté sur %', v_t;
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM NOT LIKE 'NF525: % is immutable' THEN RAISE; END IF;
    END;
    v_n := v_n + 1;
  END LOOP;
  INSERT INTO pos_test_results VALUES ('truncate_owner', true, v_n || ' tables : TRUNCATE … CASCADE refusé (NF525), aucun droit TRUNCATE applicatif');

  -- 3. service_role : refusé par les droits avant même le trigger
  BEGIN
    EXECUTE 'SET LOCAL ROLE service_role';
    TRUNCATE public.pos_events CASCADE;
    RAISE EXCEPTION 'TRUNCATE accepté pour service_role';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  INSERT INTO pos_test_results VALUES ('truncate_service_role', true, 'TRUNCATE pos_events en service_role : permission refusée');

  -- 4. compteurs
  BEGIN
    INSERT INTO public.pos_registers (code, label)
    VALUES ('T16-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'), 'Caisse éphémère test 16')
    RETURNING id INTO v_reg;
    FOR v_case IN 1..4 LOOP
      BEGIN
        CASE v_case
          WHEN 1 THEN UPDATE public.pos_counters SET value = value - 1 WHERE register_id = v_reg AND kind = 'ticket';
          WHEN 2 THEN UPDATE public.pos_counters SET value = value + 2 WHERE register_id = v_reg AND kind = 'ticket';
          WHEN 3 THEN UPDATE public.pos_counters SET kind = 'closing', value = value + 1 WHERE register_id = v_reg AND kind = 'session';
          ELSE DELETE FROM public.pos_counters WHERE register_id = v_reg AND kind = 'ticket';
        END CASE;
        RAISE EXCEPTION 'modification de compteur acceptée (cas %)', v_case;
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE 'NF525:%' THEN RAISE; END IF;
      END;
    END LOOP;
    UPDATE public.pos_counters SET value = value + 1 WHERE register_id = v_reg AND kind = 'ticket' RETURNING value INTO v_val;
    IF v_val <> 1 THEN RAISE EXCEPTION 'incrément +1 inattendu : %', v_val; END IF;
    v_log := array_append(v_log, 'counters|décrément, saut +2, changement de type et DELETE refusés ; +1 accepté');
    RAISE EXCEPTION 'T16_ROLLBACK';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'T16_ROLLBACK' THEN RAISE; END IF;
  END;
  INSERT INTO pos_test_results
  SELECT split_part(l, '|', 1), true, split_part(l, '|', 2) FROM unnest(v_log) AS l;
  INSERT INTO pos_test_results VALUES ('rollback', true, 'caisse éphémère annulée : aucune trace en base');
END;
$$;

SELECT * FROM pos_test_results;
