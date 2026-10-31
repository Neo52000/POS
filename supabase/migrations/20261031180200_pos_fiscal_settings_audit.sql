-- =============================================================================
-- POS NF525 — 0.4.0 lot 3 : paramétrage fiscal tracé (projet Pos)
-- -----------------------------------------------------------------------------
-- 1. Plus aucune écriture directe de `authenticated` sur pos_settings et
--    pos_registers (REVOKE INSERT/UPDATE, policies d'écriture supprimées).
-- 2. RPC SECURITY DEFINER pos_admin_set_setting / pos_admin_update_register :
--    is_pos_admin(), motif obligatoire (10 caractères minimum), listes blanches.
-- 3. Triggers AFTER INSERT OR UPDATE : événement JET settings_change /
--    register_change (ancienne valeur, nouvelle valeur, auteur, motif), quel que
--    soit le chemin (RPC, service_role, migration). pos_events.register_id est
--    NULLABLE, mais les événements globaux ne sont ni archivés par caisse ni
--    ancrés dans les clôtures : un changement de pos_settings est donc journalisé
--    sur CHAQUE caisse active (événement global seulement s'il n'y en a aucune).
-- 4. Garde-fous (BEFORE, tous chemins) : code de caisse immuable ; passage
--    fiskaly_env live → test interdit dès qu'une transaction live existe ;
--    clock_tolerance.offline_hours ≤ 72, online_minutes ≤ 10 ; DELETE interdit
--    sur pos_settings et pos_registers (une suppression échapperait au JET).
-- Hash v1, numérotation et clôtures inchangés. Idempotent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Droits
-- -----------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.pos_settings, public.pos_registers FROM authenticated, anon;
DROP POLICY IF EXISTS pos_registers_admin_insert ON public.pos_registers;
DROP POLICY IF EXISTS pos_registers_admin_update ON public.pos_registers;
DROP POLICY IF EXISTS pos_settings_admin_insert  ON public.pos_settings;
DROP POLICY IF EXISTS pos_settings_admin_update  ON public.pos_settings;

-- -----------------------------------------------------------------------------
-- Contexte de l'auteur (motif posé par les RPC, rôle d'appel)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_change_actor()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'user_id', auth.uid(),
    'role', coalesce(nullif(auth.jwt() ->> 'role', ''), session_user::text),
    'via', coalesce(nullif(current_setting('pos.change_via', true), ''), 'direct'),
    'reason', nullif(current_setting('pos.change_reason', true), ''));
$$;
COMMENT ON FUNCTION public.pos_change_actor() IS
  'POS NF525 : auteur d''un changement de paramétrage {user_id, role, via (rpc|direct), reason} pour le JET.';
REVOKE EXECUTE ON FUNCTION public.pos_change_actor() FROM PUBLIC, anon, authenticated;

-- Vrai si la caisse a enregistré au moins une transaction en mode live : depuis le dernier
-- passage à live tracé au JET (register_change), ou depuis l'origine si ce passage est
-- antérieur à la traçabilité (prudence).
CREATE OR REPLACE FUNCTION public.pos_register_has_live_txn(p_register_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_since timestamptz;
BEGIN
  SELECT max(e.created_at) INTO v_since
  FROM public.pos_events e
  WHERE e.register_id = p_register_id AND e.event_type = 'register_change'
    AND e.payload -> 'new' ->> 'fiskaly_env' = 'live'
    AND coalesce(e.payload -> 'old' ->> 'fiskaly_env', '') <> 'live';
  RETURN EXISTS (
    SELECT 1 FROM public.pos_transactions t
    WHERE t.register_id = p_register_id AND t.received_at >= coalesce(v_since, '-infinity'::timestamptz));
END;
$$;
COMMENT ON FUNCTION public.pos_register_has_live_txn(uuid) IS
  'POS NF525 : vrai si une transaction a été enregistrée depuis le passage de la caisse en live (origine si ce passage n''est pas tracé).';
REVOKE EXECUTE ON FUNCTION public.pos_register_has_live_txn(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_register_has_live_txn(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Garde-fous
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_settings_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_online  numeric;
  v_offline numeric;
  v_future  numeric;
BEGIN
  IF NEW.key = 'clock_tolerance' THEN
    IF jsonb_typeof(NEW.value) <> 'object' THEN
      PERFORM public.pos_error('VALIDATION', '{"key":"clock_tolerance","reason":"object expected"}'::jsonb);
    END IF;
    BEGIN
      v_online  := (NEW.value ->> 'online_minutes')::numeric;
      v_offline := (NEW.value ->> 'offline_hours')::numeric;
      v_future  := (NEW.value ->> 'future_minutes')::numeric;
    EXCEPTION WHEN invalid_text_representation THEN
      PERFORM public.pos_error('VALIDATION', '{"key":"clock_tolerance","reason":"numbers expected"}'::jsonb);
    END;
    IF v_online IS NULL OR v_online <> trunc(v_online) OR v_online < 1 OR v_online > 10 THEN
      PERFORM public.pos_error('CLOCK_TOLERANCE_OUT_OF_RANGE', jsonb_build_object(
        'field', 'online_minutes', 'max', 10, 'value', NEW.value -> 'online_minutes'));
    END IF;
    IF v_offline IS NULL OR v_offline <> trunc(v_offline) OR v_offline < 1 OR v_offline > 72 THEN
      PERFORM public.pos_error('CLOCK_TOLERANCE_OUT_OF_RANGE', jsonb_build_object(
        'field', 'offline_hours', 'max', 72, 'value', NEW.value -> 'offline_hours'));
    END IF;
    IF v_future IS NOT NULL AND (v_future <> trunc(v_future) OR v_future < 0 OR v_future > 10) THEN
      PERFORM public.pos_error('CLOCK_TOLERANCE_OUT_OF_RANGE', jsonb_build_object(
        'field', 'future_minutes', 'max', 10, 'value', NEW.value -> 'future_minutes'));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_settings_guard() IS
  'POS NF525 : trigger BEFORE INSERT/UPDATE sur pos_settings ; clock_tolerance plafonnée (online_minutes ≤ 10, offline_hours ≤ 72, future_minutes ≤ 10).';
REVOKE EXECUTE ON FUNCTION public.pos_settings_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pos_settings_guard ON public.pos_settings;
CREATE TRIGGER trg_pos_settings_guard
  BEFORE INSERT OR UPDATE ON public.pos_settings
  FOR EACH ROW EXECUTE FUNCTION public.pos_settings_guard();

CREATE OR REPLACE FUNCTION public.pos_registers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    PERFORM public.pos_error('REGISTER_CODE_IMMUTABLE', jsonb_build_object(
      'register_id', OLD.id, 'code', OLD.code, 'requested', NEW.code));
  END IF;
  IF OLD.fiskaly_env = 'live' AND NEW.fiskaly_env <> 'live'
     AND public.pos_register_has_live_txn(OLD.id) THEN
    PERFORM public.pos_error('REGISTER_LIVE_LOCKED', jsonb_build_object(
      'register_id', OLD.id, 'code', OLD.code,
      'reason', 'live -> test forbidden once a live transaction exists'));
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_registers_guard() IS
  'POS NF525 : trigger BEFORE UPDATE sur pos_registers ; code immuable (REGISTER_CODE_IMMUTABLE), live → test interdit après une transaction live (REGISTER_LIVE_LOCKED).';
REVOKE EXECUTE ON FUNCTION public.pos_registers_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pos_registers_guard ON public.pos_registers;
CREATE TRIGGER trg_pos_registers_guard
  BEFORE UPDATE ON public.pos_registers
  FOR EACH ROW EXECUTE FUNCTION public.pos_registers_guard();

DROP TRIGGER IF EXISTS trg_pos_settings_no_delete ON public.pos_settings;
CREATE TRIGGER trg_pos_settings_no_delete
  BEFORE DELETE ON public.pos_settings
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

DROP TRIGGER IF EXISTS trg_pos_registers_no_delete ON public.pos_registers;
CREATE TRIGGER trg_pos_registers_no_delete
  BEFORE DELETE ON public.pos_registers
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

-- -----------------------------------------------------------------------------
-- 3. Journalisation JET (AFTER : la ligne est valide, tous chemins confondus)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_settings_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_old     jsonb := CASE WHEN TG_OP = 'UPDATE' THEN OLD.value END;
  v_payload jsonb;
  v_reg     record;
  v_n       int := 0;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.value IS NOT DISTINCT FROM NEW.value THEN
    RETURN NULL;
  END IF;
  v_payload := jsonb_build_object('key', NEW.key, 'op', lower(TG_OP), 'old', v_old, 'new', NEW.value)
               || jsonb_build_object('actor', public.pos_change_actor());
  FOR v_reg IN SELECT r.id FROM public.pos_registers r WHERE r.is_active ORDER BY r.code LOOP
    PERFORM public.pos_insert_event(v_reg.id, NULL, auth.uid(), 'settings_change', v_payload);
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN
    PERFORM public.pos_insert_event(NULL, NULL, auth.uid(), 'settings_change', v_payload);
  END IF;
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION public.pos_settings_audit() IS
  'POS NF525 : trigger AFTER INSERT/UPDATE sur pos_settings ; JET settings_change {key, op, old, new, actor} sur chaque caisse active.';
REVOKE EXECUTE ON FUNCTION public.pos_settings_audit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pos_settings_jet ON public.pos_settings;
CREATE TRIGGER trg_pos_settings_jet
  AFTER INSERT OR UPDATE ON public.pos_settings
  FOR EACH ROW EXECUTE FUNCTION public.pos_settings_audit();

CREATE OR REPLACE FUNCTION public.pos_registers_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_old     jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  v_new     jsonb := to_jsonb(NEW);
  v_changed text[];
BEGIN
  SELECT coalesce(array_agg(k ORDER BY k), '{}') INTO v_changed
  FROM jsonb_object_keys(v_new) k
  WHERE v_old IS NULL OR v_old -> k IS DISTINCT FROM v_new -> k;
  IF TG_OP = 'UPDATE' AND cardinality(v_changed) = 0 THEN
    RETURN NULL;
  END IF;
  PERFORM public.pos_insert_event(NEW.id, NULL, auth.uid(), 'register_change',
    jsonb_build_object('register_id', NEW.id, 'code', NEW.code, 'op', lower(TG_OP),
                       'changed', to_jsonb(v_changed), 'old', v_old, 'new', v_new,
                       'actor', public.pos_change_actor()));
  RETURN NULL;
END;
$$;
COMMENT ON FUNCTION public.pos_registers_audit() IS
  'POS NF525 : trigger AFTER INSERT/UPDATE sur pos_registers ; JET register_change {changed, old, new, actor} sur la caisse.';
REVOKE EXECUTE ON FUNCTION public.pos_registers_audit() FROM PUBLIC, anon, authenticated;

-- Nom postérieur à trg_pos_registers_init_counters (ordre alphabétique) : le compteur
-- « event » de la caisse existe quand l'événement d'insertion est écrit.
DROP TRIGGER IF EXISTS trg_pos_registers_jet ON public.pos_registers;
CREATE TRIGGER trg_pos_registers_jet
  AFTER INSERT OR UPDATE ON public.pos_registers
  FOR EACH ROW EXECUTE FUNCTION public.pos_registers_audit();

-- -----------------------------------------------------------------------------
-- 2. RPC d'administration
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_admin_require(p_reason text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF NOT public.is_pos_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE';
  END IF;
  IF char_length(v_reason) < 10 THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_reason","reason":"10 characters minimum"}'::jsonb);
  END IF;
  RETURN v_reason;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pos_admin_require(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pos_admin_set_setting(p_key text, p_value jsonb, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  c_keys CONSTANT text[] := ARRAY['legal', 'ticket_footer', 'offline_max_txns', 'offline_max_hours', 'clock_tolerance'];
  v_reason text := public.pos_admin_require(p_reason);
  v_row    public.pos_settings;
BEGIN
  IF p_key IS NULL OR NOT (p_key = ANY (c_keys)) THEN
    PERFORM public.pos_error('VALIDATION', jsonb_build_object('field', 'p_key', 'reason', 'not allowed', 'allowed', to_jsonb(c_keys)));
  END IF;
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_value","reason":"required"}'::jsonb);
  END IF;
  IF p_key IN ('offline_max_txns', 'offline_max_hours')
     AND (jsonb_typeof(p_value) <> 'number' OR (p_value #>> '{}')::numeric <= 0
          OR (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric)) THEN
    PERFORM public.pos_error('VALIDATION', jsonb_build_object('field', 'p_value', 'reason', 'positive integer expected', 'key', p_key));
  END IF;
  IF p_key IN ('legal', 'ticket_footer') AND jsonb_typeof(p_value) <> 'object' THEN
    PERFORM public.pos_error('VALIDATION', jsonb_build_object('field', 'p_value', 'reason', 'object expected', 'key', p_key));
  END IF;

  PERFORM set_config('pos.change_reason', v_reason, true);
  PERFORM set_config('pos.change_via', 'rpc', true);
  INSERT INTO public.pos_settings (key, value) VALUES (p_key, p_value)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  RETURNING * INTO v_row;
  PERFORM set_config('pos.change_reason', '', true);
  PERFORM set_config('pos.change_via', '', true);
  RETURN to_jsonb(v_row);
END;
$$;
COMMENT ON FUNCTION public.pos_admin_set_setting(text, jsonb, text) IS
  'POS NF525 (admin) : modifie un paramètre (liste blanche : legal, ticket_footer, offline_max_txns, offline_max_hours, clock_tolerance), motif ≥ 10 caractères ; JET settings_change par trigger.';
REVOKE EXECUTE ON FUNCTION public.pos_admin_set_setting(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_admin_set_setting(text, jsonb, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_admin_update_register(p_register_id uuid, p_patch jsonb, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  c_cols CONSTANT text[] := ARRAY['label', 'is_active', 'fiskaly_env', 'fiskaly_system_id'];
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
  'POS NF525 (admin) : modifie une caisse (liste blanche : label, is_active, fiskaly_env, fiskaly_system_id ; code immuable), motif ≥ 10 caractères ; JET register_change par trigger.';
REVOKE EXECUTE ON FUNCTION public.pos_admin_update_register(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_admin_update_register(uuid, jsonb, text) TO authenticated, service_role;
