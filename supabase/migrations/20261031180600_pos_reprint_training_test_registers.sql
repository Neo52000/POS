-- =============================================================================
-- POS NF525 — 0.4.0 lot 7 : duplicatas, mode formation, caisses d'essai
-- (projet Pos)
-- -----------------------------------------------------------------------------
-- 1. pos_reprint(p_transaction_id, p_training) : journalise SYNCHRONEMENT le
--    JET `reprint` et renvoie le numéro de duplicata (rang de la réimpression
--    pour ce ticket, réimpressions antérieures tracées comprises). La PWA
--    n'imprime « DUPLICATA n°X » qu'après ce succès (refus hors ligne).
-- 2. pos_log_event : `training_mode_start` réservé à is_pos_admin()
--    (FORBIDDEN_ROLE) ; `training_sale` exige payload.training = true et
--    n'accepte ni ticket_number ni hash (vente de formation : aucun numéro
--    fiscal). Le reste est identique à 20260923195205_pos_rpc.sql.
-- 3. pos_registers.is_test : caisse d'essai (TEST-01, T08-*, TESTVEC-*,
--    TEST-10), signalée par verify-chain et les rapports ; modifiable par
--    pos_admin_update_register (tracé). Le marquage ci-dessous est journalisé
--    (register_change) avec son motif.
-- Hash v1, numérotation et clôtures inchangés. Idempotent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3. Caisses d'essai
-- -----------------------------------------------------------------------------
ALTER TABLE public.pos_registers ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.pos_registers.is_test IS 'POS NF525 : caisse d''essai (tests SQL, recette) : signalée par verify-chain et les rapports, jamais une caisse d''exploitation.';

DO $$
BEGIN
  PERFORM set_config('pos.change_reason', 'Marquage des caisses d''essai (migration 0.4.0 lot 7)', true);
  PERFORM set_config('pos.change_via', 'migration', true);
  UPDATE public.pos_registers
  SET is_test = true
  WHERE NOT is_test
    AND (code = 'TEST-01' OR code = 'TEST-10' OR code LIKE 'T08-%' OR code LIKE 'TESTVEC-%');
  PERFORM set_config('pos.change_reason', '', true);
  PERFORM set_config('pos.change_via', '', true);
END $$;

CREATE OR REPLACE FUNCTION public.pos_admin_update_register(p_register_id uuid, p_patch jsonb, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  c_cols CONSTANT text[] := ARRAY['label', 'is_active', 'is_test', 'fiskaly_env', 'fiskaly_system_id'];
  v_reason text := public.pos_admin_require(p_reason);
  v_cur    public.pos_registers;
  v_row    public.pos_registers;
  v_bad    text[];
BEGIN
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_patch","reason":"non-empty object expected"}'::jsonb);
  END IF;
  IF p_patch ? 'code' THEN
    PERFORM public.pos_error('REGISTER_CODE_IMMUTABLE', jsonb_build_object('register_id', p_register_id));
  END IF;
  SELECT array_agg(k ORDER BY k) INTO v_bad FROM jsonb_object_keys(p_patch) k WHERE NOT (k = ANY (c_cols));
  IF v_bad IS NOT NULL THEN
    PERFORM public.pos_error('VALIDATION', jsonb_build_object('field', 'p_patch', 'reason', 'columns not allowed',
      'columns', to_jsonb(v_bad), 'allowed', to_jsonb(c_cols)));
  END IF;
  IF p_patch ? 'label' AND (jsonb_typeof(p_patch -> 'label') <> 'string' OR btrim(p_patch ->> 'label') = '') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"label","reason":"non-empty string"}'::jsonb);
  END IF;
  IF p_patch ? 'is_active' AND jsonb_typeof(p_patch -> 'is_active') <> 'boolean' THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"is_active","reason":"boolean"}'::jsonb);
  END IF;
  IF p_patch ? 'is_test' AND jsonb_typeof(p_patch -> 'is_test') <> 'boolean' THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"is_test","reason":"boolean"}'::jsonb);
  END IF;
  IF p_patch ? 'fiskaly_env' AND coalesce(p_patch ->> 'fiskaly_env', '') NOT IN ('test', 'live') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"fiskaly_env","reason":"test|live"}'::jsonb);
  END IF;
  IF p_patch ? 'fiskaly_system_id' AND jsonb_typeof(p_patch -> 'fiskaly_system_id') NOT IN ('string', 'null') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"fiskaly_system_id","reason":"string or null"}'::jsonb);
  END IF;

  SELECT * INTO v_cur FROM public.pos_registers r WHERE r.id = p_register_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.pos_error('REGISTER_NOT_FOUND', jsonb_build_object('register_id', p_register_id));
  END IF;

  PERFORM set_config('pos.change_reason', v_reason, true);
  PERFORM set_config('pos.change_via', 'rpc', true);
  UPDATE public.pos_registers r
  SET label             = CASE WHEN p_patch ? 'label' THEN btrim(p_patch ->> 'label') ELSE r.label END,
      is_active         = CASE WHEN p_patch ? 'is_active' THEN (p_patch ->> 'is_active')::boolean ELSE r.is_active END,
      is_test           = CASE WHEN p_patch ? 'is_test' THEN (p_patch ->> 'is_test')::boolean ELSE r.is_test END,
      fiskaly_env       = CASE WHEN p_patch ? 'fiskaly_env' THEN p_patch ->> 'fiskaly_env' ELSE r.fiskaly_env END,
      fiskaly_system_id = CASE WHEN p_patch ? 'fiskaly_system_id' THEN p_patch ->> 'fiskaly_system_id' ELSE r.fiskaly_system_id END
  WHERE r.id = p_register_id
  RETURNING * INTO v_row;
  PERFORM set_config('pos.change_reason', '', true);
  PERFORM set_config('pos.change_via', '', true);
  RETURN to_jsonb(v_row);
END;
$$;
COMMENT ON FUNCTION public.pos_admin_update_register(uuid, jsonb, text) IS
  'POS NF525 (admin) : modifie une caisse (liste blanche : label, is_active, is_test, fiskaly_env, fiskaly_system_id ; code immuable), motif ≥ 10 caractères ; JET register_change par trigger.';
REVOKE EXECUTE ON FUNCTION public.pos_admin_update_register(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_admin_update_register(uuid, jsonb, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 1. Duplicata journalisé de façon synchrone
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_reprint(p_transaction_id uuid, p_training boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_txn     public.pos_transactions;
  v_rank    int;
  v_session uuid;
  v_event   bigint;
BEGIN
  PERFORM public.pos_require_pos();
  SELECT * INTO v_txn FROM public.pos_transactions t WHERE t.id = p_transaction_id;
  IF NOT FOUND THEN
    PERFORM public.pos_error('TRANSACTION_NOT_FOUND', jsonb_build_object('transaction_id', p_transaction_id));
  END IF;
  -- Sérialise les réimpressions d'un même ticket : rangs uniques et continus.
  PERFORM pg_advisory_xact_lock(hashtext('pos_reprint:' || p_transaction_id::text));
  SELECT count(*) + 1 INTO v_rank
  FROM public.pos_events e
  WHERE e.register_id = v_txn.register_id AND e.event_type = 'reprint'
    AND e.payload ->> 'transaction_id' = p_transaction_id::text
    AND coalesce(e.payload ->> 'document', 'ticket') = 'ticket';
  SELECT s.id INTO v_session FROM public.pos_sessions s WHERE s.register_id = v_txn.register_id AND s.status = 'open';
  v_event := public.pos_insert_event(v_txn.register_id, v_session, auth.uid(), 'reprint',
    jsonb_build_object('document', 'ticket', 'transaction_id', v_txn.id, 'ticket_number', v_txn.ticket_number,
                       'duplicate_number', v_rank, 'synchronous', true)
    || CASE WHEN coalesce(p_training, false) THEN '{"training":true}'::jsonb ELSE '{}'::jsonb END);
  RETURN jsonb_build_object('duplicate_number', v_rank, 'event_id', v_event,
                            'transaction_id', v_txn.id, 'ticket_number', v_txn.ticket_number);
END;
$$;
COMMENT ON FUNCTION public.pos_reprint(uuid, boolean) IS
  'POS NF525 : réimpression d''un ticket ; journalise le JET reprint (synchrone) et renvoie {duplicate_number, event_id, transaction_id, ticket_number}. Le duplicata n''est imprimé qu''après ce succès.';
REVOKE EXECUTE ON FUNCTION public.pos_reprint(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_reprint(uuid, boolean) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. pos_log_event : formation réservée à l'admin, vente de formation sans numéro
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_log_event(
  p_event_type  text,
  p_payload     jsonb DEFAULT '{}'::jsonb,
  p_client_at   timestamptz DEFAULT NULL,
  p_register_id uuid DEFAULT NULL,
  p_session_id  uuid DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_require_pos();
  IF p_event_type IS NULL OR btrim(p_event_type) = '' THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_event_type","reason":"required"}'::jsonb);
  END IF;
  -- 0.4.0 lot 7 : activation du mode formation réservée à un administrateur.
  IF p_event_type = 'training_mode_start' AND NOT public.is_pos_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE', DETAIL = '{"event_type":"training_mode_start","reason":"admin only"}';
  END IF;
  -- Vente de formation : drapeau obligatoire, aucun numéro ni empreinte fiscaux.
  IF p_event_type = 'training_sale'
     AND (coalesce(p_payload ->> 'training', '') <> 'true'
          OR p_payload ? 'ticket_number' OR p_payload ? 'hash' OR p_payload ? 'transaction_id') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_payload","reason":"training_sale requires training=true and no fiscal number"}'::jsonb);
  END IF;
  RETURN public.pos_insert_event(
    p_register_id, p_session_id,
    coalesce(auth.uid(), (p_payload ->> 'user_id')::uuid),
    p_event_type, coalesce(p_payload, '{}'::jsonb), p_client_at);
END;
$$;
COMMENT ON FUNCTION public.pos_log_event(text, jsonb, timestamptz, uuid, uuid) IS
  'POS NF525 : journalise un événement (login, logout, sale_abandoned, line_deleted, price_override, drawer_opened, offline_enter/exit, training_mode_start (admin), training_sale (training=true, sans numéro fiscal)...). Retourne l''id.';
REVOKE EXECUTE ON FUNCTION public.pos_log_event(text, jsonb, timestamptz, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_log_event(text, jsonb, timestamptz, uuid, uuid) TO authenticated, service_role;
