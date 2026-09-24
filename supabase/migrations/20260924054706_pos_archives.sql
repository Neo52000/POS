-- =============================================================================
-- POS NF525 — lot 5 : archivage périodique (projet Pos)
-- -----------------------------------------------------------------------------
-- Une archive = PARTITION CONTIGUË par caisse : tickets de numéro > dernier
-- ticket archivé et reçus avant la fin de période, événements JET d'id >
-- dernier archivé, clôtures de numéro > dernière archivée (même borne). Les
-- archives successives couvrent donc tout l'historique sans trou ni doublon,
-- et chaque archive se vérifie seule (chaîne interne + ancre = dernier hash de
-- l'archive précédente).
--   * table pos_archives (immuable, chaînée : prev_hash/hash)
--   * pos_archive_data(register, start, end)       -> jsonb (service / admin)
--   * pos_register_archive(...)                    -> jsonb (service)
--   * pos_verify_archives_chain(register)
--   * bucket Storage privé pos-archives (lecture admin POS, écriture service)
--   * cron pos-export-archive le 1er du mois à 04:00 UTC
-- Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_archives (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id         uuid        NOT NULL REFERENCES public.pos_registers (id),
  period_start        timestamptz NOT NULL,
  period_end          timestamptz NOT NULL,
  storage_path        text        NOT NULL,
  manifest            jsonb       NOT NULL,
  manifest_sha256     text        NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  last_ticket_number  bigint,
  last_event_id       bigint,
  last_closing_number bigint,
  prev_hash           text        NOT NULL,
  hash                text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (register_id, period_start),
  CHECK (period_end > period_start)
);
CREATE INDEX IF NOT EXISTS pos_archives_register_idx ON public.pos_archives (register_id, period_start DESC);
COMMENT ON TABLE public.pos_archives IS
  'POS NF525 : archives périodiques (ZIP dans le bucket pos-archives), partition contiguë par caisse, chaînées (prev_hash/hash). Immuable.';

DROP TRIGGER IF EXISTS trg_pos_archives_immutable ON public.pos_archives;
CREATE TRIGGER trg_pos_archives_immutable
  BEFORE UPDATE OR DELETE ON public.pos_archives
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();

ALTER TABLE public.pos_archives ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pos_archives_select ON public.pos_archives;
CREATE POLICY pos_archives_select ON public.pos_archives
  FOR SELECT TO authenticated USING (public.is_pos());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.pos_archives FROM anon, authenticated;
GRANT SELECT ON public.pos_archives TO authenticated;

-- -----------------------------------------------------------------------------
-- pos_archive_data : contenu d'une archive (lecture seule)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_archive_data(p_register_id uuid, p_period_start timestamptz, p_period_end timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_reg      public.pos_registers;
  v_prev     public.pos_archives;
  v_from_t   bigint;
  v_from_e   bigint;
  v_from_c   bigint;
  v_txns     jsonb;
  v_events   jsonb;
  v_closings jsonb;
  v_anchor   text;
  v_heads    jsonb;
BEGIN
  IF NOT public.is_pos_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE';
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start THEN
    PERFORM public.pos_error('VALIDATION', '{"reason":"period_start < period_end required"}'::jsonb);
  END IF;
  IF p_period_end > clock_timestamp() THEN
    PERFORM public.pos_error('PERIOD_NOT_ENDED', jsonb_build_object('period_end', p_period_end, 'server_now', clock_timestamp()));
  END IF;
  SELECT * INTO v_reg FROM public.pos_registers WHERE id = p_register_id;
  IF NOT FOUND THEN
    PERFORM public.pos_error('REGISTER_NOT_FOUND', jsonb_build_object('register_id', p_register_id));
  END IF;

  SELECT * INTO v_prev FROM public.pos_archives a
  WHERE a.register_id = p_register_id AND a.period_start < p_period_start
  ORDER BY a.period_start DESC LIMIT 1;
  v_from_t := coalesce(v_prev.last_ticket_number, 0);
  v_from_e := coalesce(v_prev.last_event_id, 0);
  v_from_c := coalesce(v_prev.last_closing_number, 0);

  SELECT coalesce(jsonb_agg(
           to_jsonb(t)
           || jsonb_build_object(
                'lines',    (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.line_no), '[]'::jsonb)
                             FROM public.pos_transaction_lines l WHERE l.transaction_id = t.id),
                'payments', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at, p.id), '[]'::jsonb)
                             FROM public.pos_payments p WHERE p.transaction_id = t.id))
           ORDER BY t.ticket_number), '[]'::jsonb)
  INTO v_txns
  FROM public.pos_transactions t
  WHERE t.register_id = p_register_id AND t.ticket_number > v_from_t AND t.received_at < p_period_end;

  SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]'::jsonb) INTO v_events
  FROM public.pos_events e
  WHERE e.register_id = p_register_id AND e.id > v_from_e AND e.created_at < p_period_end;

  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.closing_number), '[]'::jsonb) INTO v_closings
  FROM public.pos_closings c
  WHERE c.register_id = p_register_id AND c.closing_number > v_from_c AND c.created_at < p_period_end;

  SELECT t.hash INTO v_anchor FROM public.pos_transactions t
  WHERE t.register_id = p_register_id AND t.ticket_number = v_from_t;

  v_heads := jsonb_build_object(
    'anchor_ticket_number', v_from_t,
    'anchor_ticket_hash',   coalesce(v_anchor, ''),
    'last_ticket_number',   (v_txns -> -1 ->> 'ticket_number')::bigint,
    'last_ticket_hash',     v_txns -> -1 ->> 'hash',
    'last_event_id',        (v_events -> -1 ->> 'id')::bigint,
    'last_event_hash',      v_events -> -1 ->> 'hash',
    'last_closing_number',  (v_closings -> -1 ->> 'closing_number')::bigint,
    'last_closing_hash',    v_closings -> -1 ->> 'hash');

  RETURN jsonb_build_object(
    'register',     jsonb_build_object('id', v_reg.id, 'code', v_reg.code, 'label', v_reg.label),
    'period_start', p_period_start,
    'period_end',   p_period_end,
    'transactions', v_txns,
    'events',       v_events,
    'closings',     v_closings,
    'chain_heads',  v_heads,
    'previous_archive', CASE WHEN v_prev.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_prev.id, 'period_start', v_prev.period_start, 'hash', v_prev.hash,
      'manifest_sha256', v_prev.manifest_sha256, 'last_ticket_number', v_prev.last_ticket_number,
      'last_event_id', v_prev.last_event_id, 'last_closing_number', v_prev.last_closing_number) END,
    'software', coalesce((SELECT s.value FROM public.pos_settings s WHERE s.key = 'software'), '{}'::jsonb));
END;
$$;
COMMENT ON FUNCTION public.pos_archive_data(uuid, timestamptz, timestamptz) IS
  'POS NF525 : données d''une archive (partition contiguë après la dernière archive, reçues avant period_end) : transactions + lignes + paiements, JET, clôtures, têtes de chaîne, archive précédente. Admin / service.';
REVOKE ALL ON FUNCTION public.pos_archive_data(uuid, timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_archive_data(uuid, timestamptz, timestamptz) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pos_register_archive : enregistre une archive déposée dans le bucket
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_register_archive(
  p_register_id uuid, p_period_start timestamptz, p_period_end timestamptz,
  p_storage_path text, p_manifest jsonb, p_manifest_sha256 text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_reg      public.pos_registers;
  v_existing public.pos_archives;
  v_prev     public.pos_archives;
  v_row      public.pos_archives;
  v_heads    jsonb;
  v_last_t   bigint;
  v_last_e   bigint;
  v_last_c   bigint;
  v_prev_h   text;
BEGIN
  IF NOT public.is_pos_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE';
  END IF;
  IF p_period_end > clock_timestamp() THEN
    PERFORM public.pos_error('PERIOD_NOT_ENDED', jsonb_build_object('period_end', p_period_end));
  END IF;
  IF nullif(btrim(coalesce(p_storage_path, '')), '') IS NULL OR p_manifest IS NULL
     OR coalesce(p_manifest_sha256, '') !~ '^[0-9a-f]{64}$' THEN
    PERFORM public.pos_error('VALIDATION', '{"reason":"storage_path, manifest and manifest_sha256 (hex) are required"}'::jsonb);
  END IF;
  SELECT * INTO v_reg FROM public.pos_registers WHERE id = p_register_id;
  IF NOT FOUND THEN
    PERFORM public.pos_error('REGISTER_NOT_FOUND', jsonb_build_object('register_id', p_register_id));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pos_archive:' || p_register_id::text));

  SELECT * INTO v_existing FROM public.pos_archives WHERE register_id = p_register_id AND period_start = p_period_start;
  IF FOUND THEN
    RETURN jsonb_build_object('archive', to_jsonb(v_existing), 'already_exists', true);
  END IF;

  SELECT * INTO v_prev FROM public.pos_archives a
  WHERE a.register_id = p_register_id ORDER BY a.period_start DESC LIMIT 1;
  IF FOUND AND v_prev.period_start > p_period_start THEN
    PERFORM public.pos_error('VALIDATION', jsonb_build_object('reason', 'archives must be registered in chronological order',
      'last_period_start', v_prev.period_start));
  END IF;

  v_heads  := p_manifest -> 'chain_heads';
  IF v_heads IS NULL OR jsonb_typeof(v_heads) <> 'object'
     OR NOT (v_heads ? 'last_ticket_number' AND v_heads ? 'last_event_id' AND v_heads ? 'last_closing_number') THEN
    PERFORM public.pos_error('VALIDATION', '{"reason":"manifest.chain_heads with last_ticket_number, last_event_id, last_closing_number required"}'::jsonb);
  END IF;
  v_last_t := coalesce((v_heads ->> 'last_ticket_number')::bigint, v_prev.last_ticket_number);
  v_last_e := coalesce((v_heads ->> 'last_event_id')::bigint, v_prev.last_event_id);
  v_last_c := coalesce((v_heads ->> 'last_closing_number')::bigint, v_prev.last_closing_number);
  IF v_last_t IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.pos_transactions t WHERE t.register_id = p_register_id AND t.ticket_number = v_last_t
         AND (v_heads ->> 'last_ticket_number' IS NULL OR t.hash = v_heads ->> 'last_ticket_hash')) THEN
    PERFORM public.pos_error('VALIDATION', jsonb_build_object('reason', 'last_ticket_number/hash unknown', 'last_ticket_number', v_last_t));
  END IF;
  IF v_last_t < coalesce(v_prev.last_ticket_number, 0) OR v_last_e < coalesce(v_prev.last_event_id, 0)
     OR v_last_c < coalesce(v_prev.last_closing_number, 0) THEN
    PERFORM public.pos_error('VALIDATION', '{"reason":"chain heads must not go backwards"}'::jsonb);
  END IF;

  v_prev_h := coalesce(v_prev.hash, '');
  INSERT INTO public.pos_archives (
    register_id, period_start, period_end, storage_path, manifest, manifest_sha256,
    last_ticket_number, last_event_id, last_closing_number, prev_hash, hash
  ) VALUES (
    p_register_id, p_period_start, p_period_end, p_storage_path, p_manifest, p_manifest_sha256,
    v_last_t, v_last_e, v_last_c, v_prev_h,
    public.pos_sha256('v1|archive|' || v_reg.code || '|' || public.pos_canonical_ts(p_period_start)
      || '|' || public.pos_canonical_ts(p_period_end) || '|' || p_manifest_sha256 || '|' || v_prev_h)
  ) RETURNING * INTO v_row;

  PERFORM public.pos_insert_event(p_register_id, NULL, auth.uid(), 'archive',
    jsonb_build_object('archive_id', v_row.id, 'period_start', public.pos_canonical_ts(p_period_start),
                       'period_end', public.pos_canonical_ts(p_period_end), 'storage_path', p_storage_path,
                       'manifest_sha256', p_manifest_sha256, 'hash', v_row.hash));

  RETURN jsonb_build_object('archive', to_jsonb(v_row), 'already_exists', false);
END;
$$;
COMMENT ON FUNCTION public.pos_register_archive(uuid, timestamptz, timestamptz, text, jsonb, text) IS
  'POS NF525 : enregistre une archive (idempotent par caisse + début de période), chaînage v1|archive|code|start|end|manifest_sha256|prev_hash, événement JET archive.';
REVOKE ALL ON FUNCTION public.pos_register_archive(uuid, timestamptz, timestamptz, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_register_archive(uuid, timestamptz, timestamptz, text, jsonb, text) TO service_role;

-- -----------------------------------------------------------------------------
-- pos_verify_archives_chain
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_verify_archives_chain(p_register_id uuid)
RETURNS TABLE (ok boolean, checked int, first_break_id uuid, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  a      record;
  v_code text;
  v_prev text := '';
BEGIN
  PERFORM public.pos_require_pos();
  SELECT code INTO v_code FROM public.pos_registers WHERE id = p_register_id;
  checked := 0;
  FOR a IN SELECT * FROM public.pos_archives WHERE register_id = p_register_id ORDER BY period_start LOOP
    IF a.prev_hash IS DISTINCT FROM v_prev THEN
      ok := false; first_break_id := a.id; reason := 'PREV_HASH_MISMATCH'; RETURN NEXT; RETURN;
    END IF;
    IF a.hash <> public.pos_sha256('v1|archive|' || v_code || '|' || public.pos_canonical_ts(a.period_start)
         || '|' || public.pos_canonical_ts(a.period_end) || '|' || a.manifest_sha256 || '|' || a.prev_hash) THEN
      ok := false; first_break_id := a.id; reason := 'HASH_MISMATCH'; RETURN NEXT; RETURN;
    END IF;
    v_prev := a.hash;
    checked := checked + 1;
  END LOOP;
  ok := true; first_break_id := NULL; reason := NULL;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.pos_verify_archives_chain(uuid) IS 'POS NF525 : vérifie la chaîne des archives d''une caisse (prev_hash, hash recalculé).';
REVOKE ALL ON FUNCTION public.pos_verify_archives_chain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_verify_archives_chain(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Bucket Storage privé pos-archives
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('pos-archives', 'pos-archives', false, 104857600, ARRAY['application/zip'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS pos_archives_admin_read ON storage.objects;
CREATE POLICY pos_archives_admin_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'pos-archives' AND public.is_pos_admin());

-- -----------------------------------------------------------------------------
-- Cron : archive du mois précédent, le 1er à 04:00 UTC (après pos-closing-monthly)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron absent : job pos-export-archive non planifié';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pos-export-archive') THEN
    PERFORM cron.unschedule('pos-export-archive');
  END IF;
  PERFORM cron.schedule('pos-export-archive', '0 4 1 * *',
    format('SELECT public.pos_cron_call(%L, %L::jsonb)', 'pos-export-archive', '{"source":"pg_cron"}'));
END $$;
