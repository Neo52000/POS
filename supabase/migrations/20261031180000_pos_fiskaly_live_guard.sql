-- =============================================================================
-- POS NF525 — 0.4.0 lot 1 : signature Fiskaly sans repli silencieux (projet Pos)
-- -----------------------------------------------------------------------------
-- Défense en base : pos_mark_signature refuse de passer à `signed` un ticket
-- d'une caisse `live` dont la signature provient du client simulé (mock) :
-- payload {"mock": true} ou {"mode": "mock"}, ou identifiant d'enregistrement
-- « mock-… ». Erreur explicite FISKALY_MOCK_FOR_LIVE_REGISTER ; le ticket reste
-- pending_signature (rejoué par pos-sign-pending une fois Fiskaly configuré).
-- Côté Edge Functions, getFiskalyClient(caisse) lève FISKALY_NOT_CONFIGURED
-- (`_shared/fiskaly/config.ts`) : le mock n'est jamais servi à une caisse live.
-- Hash v1, numérotation et clôtures inchangés. Idempotent (CREATE OR REPLACE).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pos_signature_is_mock(p_record_id text, p_payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT coalesce(p_record_id, '') LIKE 'mock-%'
      OR (jsonb_typeof(p_payload) = 'object'
          AND (lower(coalesce(p_payload ->> 'mock', '')) = 'true'
               OR lower(coalesce(p_payload ->> 'mode', '')) = 'mock'));
$$;
COMMENT ON FUNCTION public.pos_signature_is_mock(text, jsonb) IS
  'POS NF525 : vrai si une signature provient du client Fiskaly simulé (record « mock-… », payload mock=true ou mode=mock).';
REVOKE EXECUTE ON FUNCTION public.pos_signature_is_mock(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_signature_is_mock(text, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_mark_signature(
  p_transaction_id uuid,
  p_status         text,
  p_record_id      text,
  p_signature      text,
  p_payload        jsonb,
  p_error          text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_txn public.pos_transactions;
  v_env text;
BEGIN
  PERFORM public.pos_require_service_role();
  IF p_status IS NULL OR p_status NOT IN ('pending_signature', 'signed', 'failed') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_status","reason":"pending_signature|signed|failed"}'::jsonb);
  END IF;

  SELECT * INTO v_txn FROM public.pos_transactions t WHERE t.id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.pos_error('TRANSACTION_NOT_FOUND', jsonb_build_object('transaction_id', p_transaction_id));
  END IF;
  IF v_txn.signature_status = 'signed' THEN
    -- déjà signé : immuable, on ignore (idempotence du cron)
    RETURN;
  END IF;

  -- Lot 1 (0.4.0) : jamais de signature simulée sur une caisse live.
  SELECT r.fiskaly_env INTO v_env FROM public.pos_registers r WHERE r.id = v_txn.register_id;
  IF p_status = 'signed' AND v_env = 'live' AND public.pos_signature_is_mock(p_record_id, p_payload) THEN
    PERFORM public.pos_error('FISKALY_MOCK_FOR_LIVE_REGISTER', jsonb_build_object(
      'transaction_id', p_transaction_id, 'ticket_number', v_txn.ticket_number,
      'register_id', v_txn.register_id, 'record_id', p_record_id));
  END IF;

  UPDATE public.pos_transactions t
  SET signature_status     = p_status,
      signature_attempts   = t.signature_attempts + 1,
      last_signature_error = CASE WHEN p_status = 'signed' THEN NULL ELSE coalesce(p_error, t.last_signature_error) END,
      fiskaly_record_id    = coalesce(p_record_id, t.fiskaly_record_id),
      fiskaly_signature    = coalesce(p_signature, t.fiskaly_signature),
      fiskaly_payload      = coalesce(p_payload, t.fiskaly_payload),
      fiskaly_signed_at    = CASE WHEN p_status = 'signed' THEN now() ELSE t.fiskaly_signed_at END
  WHERE t.id = p_transaction_id;

  IF p_status <> 'signed' THEN
    PERFORM public.pos_insert_event(v_txn.register_id, v_txn.session_id, NULL, 'signature_failed',
      jsonb_build_object('transaction_id', p_transaction_id, 'ticket_number', v_txn.ticket_number,
                         'status', p_status, 'attempt', v_txn.signature_attempts + 1, 'error', p_error));
  END IF;
END;
$$;
COMMENT ON FUNCTION public.pos_mark_signature(uuid, text, text, text, jsonb, text) IS
  'POS NF525 (service role) : résultat d''une tentative de signature Fiskaly ; refuse une signature mock pour une caisse live (FISKALY_MOCK_FOR_LIVE_REGISTER) ; incrémente signature_attempts, fiskaly_signed_at = now() si signed ; journalise signature_failed sinon.';
REVOKE EXECUTE ON FUNCTION public.pos_mark_signature(uuid, text, text, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_mark_signature(uuid, text, text, text, jsonb, text) TO authenticated, service_role;
