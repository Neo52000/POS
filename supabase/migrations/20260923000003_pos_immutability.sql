-- =============================================================================
-- POS NF525 — 0003 : immutabilité (triggers) + retrait des droits d'écriture
-- -----------------------------------------------------------------------------
-- Principe (plan A6) : le client n'écrit jamais directement. Toute écriture
-- passe par une RPC SECURITY DEFINER. En plus, des triggers garantissent
-- qu'aucune ligne « comptable » ne peut être modifiée ni supprimée, même par
-- le propriétaire de la base (hors DROP TRIGGER explicite, tracé dans les
-- migrations).
--   * pos_transaction_lines, pos_payments, pos_events : UPDATE et DELETE
--     interdits.
--   * pos_stock_sync (outbox) : DELETE interdit ; UPDATE limité aux colonnes de
--     suivi (status, attempts, last_error, remote_stock_after, done_at) et
--     réservé au service role (Edge Function pos-stock-sync).
--   * pos_transactions : DELETE interdit ; UPDATE limité aux colonnes de
--     signature / Fiskaly / invoice_requested, et une fois signé, seule
--     invoice_requested peut encore changer.
--   * pos_closings : DELETE interdit ; UPDATE limité à fiskaly_closing_id /
--     fiskaly_payload (rapprochement Fiskaly), uniquement depuis NULL.
--   * pos_sessions : DELETE interdit ; UPDATE uniquement open -> closed
--     (colonnes de clôture).
-- Idempotent : CREATE OR REPLACE + DROP TRIGGER IF EXISTS.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pos_forbid_change() : refuse tout UPDATE / DELETE
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_forbid_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'NF525: % is immutable', TG_TABLE_NAME
    USING ERRCODE = 'P0001',
          DETAIL  = format('{"table":"%s","op":"%s"}', TG_TABLE_NAME, TG_OP),
          HINT    = 'Les enregistrements comptables NF525 ne peuvent être ni modifiés ni supprimés.';
END;
$$;
COMMENT ON FUNCTION public.pos_forbid_change() IS 'POS NF525 : trigger BEFORE UPDATE/DELETE qui interdit toute modification (lignes, paiements, événements, et DELETE des autres tables).';

DROP TRIGGER IF EXISTS trg_pos_transaction_lines_immutable ON public.pos_transaction_lines;
CREATE TRIGGER trg_pos_transaction_lines_immutable
  BEFORE UPDATE OR DELETE ON public.pos_transaction_lines
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

DROP TRIGGER IF EXISTS trg_pos_payments_immutable ON public.pos_payments;
CREATE TRIGGER trg_pos_payments_immutable
  BEFORE UPDATE OR DELETE ON public.pos_payments
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

DROP TRIGGER IF EXISTS trg_pos_events_immutable ON public.pos_events;
CREATE TRIGGER trg_pos_events_immutable
  BEFORE UPDATE OR DELETE ON public.pos_events
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

-- DELETE interdit sur transactions, clôtures et sessions (UPDATE géré ci-dessous)
DROP TRIGGER IF EXISTS trg_pos_transactions_no_delete ON public.pos_transactions;
CREATE TRIGGER trg_pos_transactions_no_delete
  BEFORE DELETE ON public.pos_transactions
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

DROP TRIGGER IF EXISTS trg_pos_closings_no_delete ON public.pos_closings;
CREATE TRIGGER trg_pos_closings_no_delete
  BEFORE DELETE ON public.pos_closings
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

DROP TRIGGER IF EXISTS trg_pos_sessions_no_delete ON public.pos_sessions;
CREATE TRIGGER trg_pos_sessions_no_delete
  BEFORE DELETE ON public.pos_sessions
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

DROP TRIGGER IF EXISTS trg_pos_stock_sync_no_delete ON public.pos_stock_sync;
CREATE TRIGGER trg_pos_stock_sync_no_delete
  BEFORE DELETE ON public.pos_stock_sync
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

-- -----------------------------------------------------------------------------
-- pos_transactions_guard_update() : UPDATE limité à la liste blanche
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_transactions_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- colonnes modifiables tant que le ticket n'est pas signé
  c_whitelist CONSTANT text[] := ARRAY[
    'signature_status', 'signature_attempts', 'last_signature_error',
    'fiskaly_record_id', 'fiskaly_signature', 'fiskaly_signed_at', 'fiskaly_payload',
    'invoice_requested'
  ];
  v_old jsonb := to_jsonb(OLD);
  v_new jsonb := to_jsonb(NEW);
BEGIN
  -- 1) aucune colonne hors liste blanche ne peut changer
  IF (v_old - c_whitelist) <> (v_new - c_whitelist) THEN
    RAISE EXCEPTION 'NF525: pos_transactions is immutable (only signature/invoice columns may change)'
      USING ERRCODE = 'P0001',
            DETAIL  = format('{"table":"pos_transactions","id":"%s","ticket_number":%s}', OLD.id, OLD.ticket_number);
  END IF;

  -- 2) une fois signé, seule invoice_requested peut encore changer
  IF OLD.signature_status = 'signed'
     AND (v_old - 'invoice_requested') <> (v_new - 'invoice_requested') THEN
    RAISE EXCEPTION 'NF525: signed pos_transactions can only toggle invoice_requested'
      USING ERRCODE = 'P0001',
            DETAIL  = format('{"table":"pos_transactions","id":"%s","ticket_number":%s}', OLD.id, OLD.ticket_number);
  END IF;

  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_transactions_guard_update() IS 'POS NF525 : trigger BEFORE UPDATE sur pos_transactions ; seules les colonnes de signature Fiskaly et invoice_requested peuvent changer (invoice_requested seulement une fois signé).';

DROP TRIGGER IF EXISTS trg_pos_transactions_guard_update ON public.pos_transactions;
CREATE TRIGGER trg_pos_transactions_guard_update
  BEFORE UPDATE ON public.pos_transactions
  FOR EACH ROW EXECUTE FUNCTION public.pos_transactions_guard_update();

-- -----------------------------------------------------------------------------
-- pos_closings_guard_update() : seul le rapprochement Fiskaly est autorisé
-- (fiskaly_closing_id / fiskaly_payload, et uniquement depuis NULL)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_closings_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  c_whitelist CONSTANT text[] := ARRAY['fiskaly_closing_id', 'fiskaly_payload'];
BEGIN
  IF (to_jsonb(OLD) - c_whitelist) <> (to_jsonb(NEW) - c_whitelist) THEN
    RAISE EXCEPTION 'NF525: pos_closings is immutable (only fiskaly_closing_id/fiskaly_payload may be set)'
      USING ERRCODE = 'P0001',
            DETAIL  = format('{"table":"pos_closings","id":"%s","closing_number":%s}', OLD.id, OLD.closing_number);
  END IF;
  IF (OLD.fiskaly_closing_id IS NOT NULL AND NEW.fiskaly_closing_id IS DISTINCT FROM OLD.fiskaly_closing_id)
     OR (OLD.fiskaly_payload IS NOT NULL AND NEW.fiskaly_payload IS DISTINCT FROM OLD.fiskaly_payload) THEN
    RAISE EXCEPTION 'NF525: pos_closings Fiskaly reconciliation fields can only be set once'
      USING ERRCODE = 'P0001',
            DETAIL  = format('{"table":"pos_closings","id":"%s","closing_number":%s}', OLD.id, OLD.closing_number);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_closings_guard_update() IS 'POS NF525 : trigger BEFORE UPDATE sur pos_closings ; seuls fiskaly_closing_id et fiskaly_payload peuvent être renseignés, une seule fois.';

DROP TRIGGER IF EXISTS trg_pos_closings_guard_update ON public.pos_closings;
CREATE TRIGGER trg_pos_closings_guard_update
  BEFORE UPDATE ON public.pos_closings
  FOR EACH ROW EXECUTE FUNCTION public.pos_closings_guard_update();

-- -----------------------------------------------------------------------------
-- pos_sessions_guard_update() : seule la transition open -> closed est permise
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_sessions_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- colonnes renseignées à la clôture
  c_closing_cols CONSTANT text[] := ARRAY[
    'status', 'closed_by', 'closed_at', 'counted_cash_cents',
    'expected_cash_cents', 'variance_cents', 'closing_id', 'notes'
  ];
BEGIN
  IF OLD.status <> 'open' OR NEW.status <> 'closed' THEN
    RAISE EXCEPTION 'NF525: pos_sessions can only transition from open to closed'
      USING ERRCODE = 'P0001',
            DETAIL  = format('{"table":"pos_sessions","id":"%s","from":"%s","to":"%s"}', OLD.id, OLD.status, NEW.status);
  END IF;
  IF (to_jsonb(OLD) - c_closing_cols) <> (to_jsonb(NEW) - c_closing_cols) THEN
    RAISE EXCEPTION 'NF525: pos_sessions opening data is immutable'
      USING ERRCODE = 'P0001',
            DETAIL  = format('{"table":"pos_sessions","id":"%s"}', OLD.id);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_sessions_guard_update() IS 'POS NF525 : trigger BEFORE UPDATE sur pos_sessions ; seule la clôture (open -> closed) est autorisée.';

DROP TRIGGER IF EXISTS trg_pos_sessions_guard_update ON public.pos_sessions;
CREATE TRIGGER trg_pos_sessions_guard_update
  BEFORE UPDATE ON public.pos_sessions
  FOR EACH ROW EXECUTE FUNCTION public.pos_sessions_guard_update();

-- -----------------------------------------------------------------------------
-- pos_stock_sync_guard_update() : suivi de synchronisation par le service role
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_stock_sync_guard_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  c_whitelist CONSTANT text[] := ARRAY['status', 'attempts', 'last_error', 'remote_stock_after', 'done_at'];
BEGIN
  IF (to_jsonb(OLD) - c_whitelist) <> (to_jsonb(NEW) - c_whitelist) THEN
    RAISE EXCEPTION 'NF525: pos_stock_sync movement is immutable (only sync tracking columns may change)'
      USING ERRCODE = 'P0001',
            DETAIL  = format('{"table":"pos_stock_sync","id":%s}', OLD.id);
  END IF;
  IF NOT public.pos_is_service_role() THEN
    RAISE EXCEPTION 'NF525: pos_stock_sync tracking columns are reserved to the service role'
      USING ERRCODE = '42501',
            DETAIL  = format('{"table":"pos_stock_sync","id":%s}', OLD.id);
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_stock_sync_guard_update() IS 'POS NF525 : trigger BEFORE UPDATE sur pos_stock_sync ; seules les colonnes de suivi changent, et uniquement par le service role.';

DROP TRIGGER IF EXISTS trg_pos_stock_sync_guard_update ON public.pos_stock_sync;
CREATE TRIGGER trg_pos_stock_sync_guard_update
  BEFORE UPDATE ON public.pos_stock_sync
  FOR EACH ROW EXECUTE FUNCTION public.pos_stock_sync_guard_update();

-- =============================================================================
-- Droits : aucune écriture directe pour anon / authenticated.
-- SELECT conservé pour authenticated (filtré par RLS, migration 0006) ;
-- anon n'a aucun accès. service_role conserve les droits par défaut.
-- =============================================================================
REVOKE ALL ON TABLE
  public.pos_registers, public.pos_settings, public.pos_counters, public.pos_sessions,
  public.pos_transactions, public.pos_transaction_lines, public.pos_payments,
  public.pos_stock_sync, public.pos_closings, public.pos_events
FROM anon;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE
  public.pos_registers, public.pos_settings, public.pos_counters, public.pos_sessions,
  public.pos_transactions, public.pos_transaction_lines, public.pos_payments,
  public.pos_stock_sync, public.pos_closings, public.pos_events
FROM authenticated;

GRANT SELECT ON TABLE
  public.pos_registers, public.pos_settings, public.pos_counters, public.pos_sessions,
  public.pos_transactions, public.pos_transaction_lines, public.pos_payments,
  public.pos_stock_sync, public.pos_closings, public.pos_events
TO authenticated;

-- Les fonctions trigger ne sont pas appelables directement
REVOKE EXECUTE ON FUNCTION public.pos_forbid_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_transactions_guard_update() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_closings_guard_update() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_sessions_guard_update() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_stock_sync_guard_update() FROM PUBLIC, anon, authenticated;
