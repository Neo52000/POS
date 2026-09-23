-- =============================================================================
-- POS NF525 — test SQL 04 (projet « Pos ») : immutabilité
-- -----------------------------------------------------------------------------
-- Écrit sur la caisse TEST-01 (vente + session + clôture de test, conservées).
-- Rejouable : oui. Vérifie que tout UPDATE/DELETE interdit lève 'NF525: ...'
-- et que les seules mises à jour tolérées (signature, invoice_requested,
-- rapprochement Fiskaly des clôtures, clôture de session, suivi de
-- synchronisation de l'outbox stock par le service role) passent.
-- =============================================================================
CREATE TEMP TABLE IF NOT EXISTS pos_test_results (step text, ok boolean, detail text);
TRUNCATE pos_test_results;

-- Helper temporaire : exécute p_sql et exige une erreur 'NF525: ...'
CREATE OR REPLACE FUNCTION pg_temp.expect_nf525(p_step text, p_sql text)
RETURNS void
LANGUAGE plpgsql
AS $f$
BEGIN
  BEGIN
    EXECUTE p_sql;
    RAISE EXCEPTION 'aucune erreur';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'NF525:%' THEN
      RAISE EXCEPTION '% : erreur NF525 attendue, obtenu : %', p_step, SQLERRM;
    END IF;
  END;
  INSERT INTO pos_test_results VALUES (p_step, true, 'refusé : NF525');
END;
$f$;

DO $$
DECLARE
  v_reg      uuid;
  v_session  uuid;
  v_cashier  uuid := gen_random_uuid();
  v_res      jsonb;
  v_txn_id   uuid;
  v_line_id  uuid;
  v_pay_id   uuid;
  v_event_id bigint;
  v_closing  uuid;
  v_sync_id  bigint;

BEGIN
  -- ---------------------------------------------------------------- setup
  INSERT INTO public.pos_registers (code, label) VALUES ('TEST-01', 'Caisse de test SQL') ON CONFLICT (code) DO NOTHING;
  SELECT id INTO v_reg FROM public.pos_registers WHERE code = 'TEST-01';
  SELECT id INTO v_session FROM public.pos_sessions WHERE register_id = v_reg AND status = 'open';
  IF v_session IS NULL THEN
    SELECT id INTO v_session FROM public.pos_open_session(v_reg, 0, v_cashier);
  END IF;

  v_res := public.pos_finalize_sale(jsonb_build_object(
    'client_txn_id', gen_random_uuid(), 'register_id', v_reg, 'session_id', v_session, 'kind', 'sale',
    'business_at', now(), 'cashier_id', v_cashier, 'invoice_requested', false,
    'lines', '[{"line_no":1,"product_id":"10000000-0000-0000-0000-000000000001","label":"Immutable","qty":1,"unit_price_ttc_cents":1200,"vat_rate":20}]'::jsonb,
    'payments', '[{"method":"cb","amount_cents":1200}]'::jsonb, 'change_cents', 0));
  v_txn_id := (v_res ->> 'transaction_id')::uuid;
  SELECT id INTO v_line_id FROM public.pos_transaction_lines WHERE transaction_id = v_txn_id LIMIT 1;
  SELECT id INTO v_pay_id  FROM public.pos_payments WHERE transaction_id = v_txn_id LIMIT 1;
  SELECT max(id) INTO v_event_id FROM public.pos_events WHERE register_id = v_reg;
  INSERT INTO pos_test_results VALUES ('setup', true, 'ticket ' || (v_res -> 'transaction' ->> 'ticket_number') || ' sur TEST-01');

  -- ------------------------------------------------------ lignes / paiements
  PERFORM pg_temp.expect_nf525('lines_update', format('UPDATE public.pos_transaction_lines SET label = %L WHERE id = %L', 'x', v_line_id));
  PERFORM pg_temp.expect_nf525('lines_delete', format('DELETE FROM public.pos_transaction_lines WHERE id = %L', v_line_id));
  PERFORM pg_temp.expect_nf525('payments_update', format('UPDATE public.pos_payments SET amount_cents = 1 WHERE id = %L', v_pay_id));
  PERFORM pg_temp.expect_nf525('payments_delete', format('DELETE FROM public.pos_payments WHERE id = %L', v_pay_id));

  -- ------------------------------------------------------------ événements
  PERFORM pg_temp.expect_nf525('events_update', format('UPDATE public.pos_events SET payload = %L WHERE id = %s', '{}', v_event_id));
  PERFORM pg_temp.expect_nf525('events_delete', format('DELETE FROM public.pos_events WHERE id = %s', v_event_id));

  -- ------------------------------------------------------- outbox stock
  SELECT id INTO v_sync_id FROM public.pos_stock_sync WHERE transaction_id = v_txn_id;
  PERFORM pg_temp.expect_nf525('stock_sync_update_delta', format('UPDATE public.pos_stock_sync SET qty_delta = 0 WHERE id = %s', v_sync_id));
  PERFORM pg_temp.expect_nf525('stock_sync_update_key', format('UPDATE public.pos_stock_sync SET idempotency_key = %L WHERE id = %s', 'x', v_sync_id));
  PERFORM pg_temp.expect_nf525('stock_sync_delete', format('DELETE FROM public.pos_stock_sync WHERE id = %s', v_sync_id));
  PERFORM public.pos_stock_sync_mark(v_sync_id, 'failed', 'timeout', NULL);
  PERFORM public.pos_stock_sync_mark(v_sync_id, 'done', NULL, 42);
  IF NOT EXISTS (SELECT 1 FROM public.pos_stock_sync WHERE id = v_sync_id AND status = 'done' AND attempts = 2
                 AND remote_stock_after = 42 AND done_at IS NOT NULL AND last_error IS NULL) THEN
    RAISE EXCEPTION 'pos_stock_sync_mark : suivi inattendu';
  END IF;
  INSERT INTO pos_test_results VALUES ('stock_sync_mark', true, 'failed puis done (attempts=2, remote_stock_after=42)');

  -- ---------------------------------------------------------- transactions
  PERFORM pg_temp.expect_nf525('txn_update_total', format('UPDATE public.pos_transactions SET total_ttc_cents = total_ttc_cents + 1, total_ht_cents = total_ht_cents + 1 WHERE id = %L', v_txn_id));
  PERFORM pg_temp.expect_nf525('txn_update_hash', format('UPDATE public.pos_transactions SET hash = %L WHERE id = %L', repeat('0', 64), v_txn_id));
  PERFORM pg_temp.expect_nf525('txn_update_ticket', format('UPDATE public.pos_transactions SET ticket_number = ticket_number + 1000 WHERE id = %L', v_txn_id));
  PERFORM pg_temp.expect_nf525('txn_delete', format('DELETE FROM public.pos_transactions WHERE id = %L', v_txn_id));

  -- mise à jour autorisée : signature (via RPC service role) + invoice_requested
  PERFORM public.pos_mark_signature(v_txn_id, 'failed', NULL, NULL, NULL, 'mock timeout');
  IF (SELECT signature_attempts FROM public.pos_transactions WHERE id = v_txn_id) <> 1
     OR (SELECT signature_status FROM public.pos_transactions WHERE id = v_txn_id) <> 'failed' THEN
    RAISE EXCEPTION 'pos_mark_signature(failed) : attempts/status inattendus';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_events WHERE event_type = 'signature_failed' AND (payload ->> 'transaction_id')::uuid = v_txn_id) THEN
    RAISE EXCEPTION 'événement signature_failed absent';
  END IF;
  PERFORM public.pos_mark_signature(v_txn_id, 'signed', 'rec_123', 'sig_abc', '{"mock":true}'::jsonb, NULL);
  IF (SELECT signature_attempts FROM public.pos_transactions WHERE id = v_txn_id) <> 2
     OR (SELECT signature_status FROM public.pos_transactions WHERE id = v_txn_id) <> 'signed'
     OR (SELECT fiskaly_signed_at FROM public.pos_transactions WHERE id = v_txn_id) IS NULL
     OR (SELECT last_signature_error FROM public.pos_transactions WHERE id = v_txn_id) IS NOT NULL THEN
    RAISE EXCEPTION 'pos_mark_signature(signed) : colonnes inattendues';
  END IF;
  INSERT INTO pos_test_results VALUES ('txn_signature_update', true, 'failed (attempts=1, JET) puis signed (attempts=2, signed_at)');

  UPDATE public.pos_transactions SET invoice_requested = true WHERE id = v_txn_id;
  INSERT INTO pos_test_results VALUES ('txn_invoice_requested_after_signed', true, 'autorisé');

  -- une fois signé : plus rien d'autre
  PERFORM pg_temp.expect_nf525('txn_signed_status_update', format('UPDATE public.pos_transactions SET signature_status = %L WHERE id = %L', 'failed', v_txn_id));
  PERFORM pg_temp.expect_nf525('txn_signed_fiskaly_update', format('UPDATE public.pos_transactions SET fiskaly_signature = %L WHERE id = %L', 'other', v_txn_id));
  PERFORM public.pos_mark_signature(v_txn_id, 'failed', NULL, NULL, NULL, 'late');   -- no-op silencieux
  IF (SELECT signature_attempts FROM public.pos_transactions WHERE id = v_txn_id) <> 2 THEN
    RAISE EXCEPTION 'pos_mark_signature sur un ticket signé devrait être un no-op';
  END IF;
  INSERT INTO pos_test_results VALUES ('txn_signed_mark_noop', true, 'pos_mark_signature ignoré une fois signé');

  -- ----------------------------------------------------------- sessions
  PERFORM pg_temp.expect_nf525('session_update_opening', format('UPDATE public.pos_sessions SET opening_float_cents = opening_float_cents + 1 WHERE id = %L', v_session));
  PERFORM pg_temp.expect_nf525('session_delete', format('DELETE FROM public.pos_sessions WHERE id = %L', v_session));

  -- clôture (autorisée) puis toute autre modification refusée
  v_res := public.pos_close_session(v_session, 0, 'test immutabilité', v_cashier);
  v_closing := (v_res -> 'closing' ->> 'id')::uuid;
  INSERT INTO pos_test_results VALUES ('session_close_allowed', true, 'open -> closed, clôture ' || (v_res -> 'closing' ->> 'closing_number'));
  PERFORM pg_temp.expect_nf525('session_reopen', format('UPDATE public.pos_sessions SET status = %L WHERE id = %L', 'open', v_session));
  PERFORM pg_temp.expect_nf525('session_closed_update', format('UPDATE public.pos_sessions SET notes = %L WHERE id = %L', 'x', v_session));

  -- ----------------------------------------------------------- clôtures
  PERFORM pg_temp.expect_nf525('closing_update_total', format('UPDATE public.pos_closings SET total_ttc_cents = total_ttc_cents + 1 WHERE id = %L', v_closing));
  PERFORM pg_temp.expect_nf525('closing_delete', format('DELETE FROM public.pos_closings WHERE id = %L', v_closing));
  PERFORM public.pos_mark_closing_synced(v_closing, 'fk_closing_1', '{"mock":true}'::jsonb);
  IF (SELECT fiskaly_closing_id FROM public.pos_closings WHERE id = v_closing) <> 'fk_closing_1' THEN
    RAISE EXCEPTION 'pos_mark_closing_synced non appliqué';
  END IF;
  PERFORM public.pos_mark_closing_synced(v_closing, 'fk_closing_2', NULL);  -- no-op
  IF (SELECT fiskaly_closing_id FROM public.pos_closings WHERE id = v_closing) <> 'fk_closing_1' THEN
    RAISE EXCEPTION 'pos_mark_closing_synced devrait être un no-op la 2e fois';
  END IF;
  PERFORM pg_temp.expect_nf525('closing_fiskaly_reset', format('UPDATE public.pos_closings SET fiskaly_closing_id = %L WHERE id = %L', 'fk_closing_3', v_closing));
  INSERT INTO pos_test_results VALUES ('closing_sync_once', true, 'rapprochement Fiskaly une seule fois');

  -- ---------------------------------------------------------- chaîne finale
  IF NOT (SELECT ok FROM public.pos_verify_chain(v_reg)) THEN
    RAISE EXCEPTION 'chaîne TEST-01 rompue';
  END IF;
  INSERT INTO pos_test_results VALUES ('verify_chain', true, 'chaîne TEST-01 intacte');
END $$;

SELECT * FROM pos_test_results;
