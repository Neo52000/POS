-- =============================================================================
-- POS NF525 — 0.4.0 lot 6 : ancrage du JET et des archives dans la clôture
-- (projet Pos)
-- -----------------------------------------------------------------------------
-- Hash de clôture v2 (nouvelles clôtures) :
--   SHA-256("v2|closing|numéro|type|début|fin|nb tickets|total TTC|GTP|
--            tête du JET|hash de la dernière archive|prev_hash")
--   tête du JET = hash du dernier événement de la caisse créé avant la fin de
--   période ; dernière archive = archive de la caisse la plus récente créée avant
--   la fin de période ; '' si aucun.
-- Colonnes pos_closings : hash_version (1 pour l'existant, inchangé ; 2 ensuite),
-- jet_head_event_id / jet_head_hash, archive_head_id / archive_head_hash.
-- pos_verify_closings_chain accepte v1 et v2 ; pour v2, vérifie en plus que les
-- têtes stockées sont toujours le hash de l'événement / de l'archive référencés
-- (JET_HEAD_MISMATCH / ARCHIVE_HEAD_MISMATCH) : une falsification du JET, même
-- avec la chaîne d'événements recalculée, est détectée par la clôture.
-- Miroir TypeScript : @pos/core closing.ts (vecteurs closing-vectors.json).
-- Hash ticket v1, numérotation et agrégats de clôture inchangés. Idempotent.
-- =============================================================================

ALTER TABLE public.pos_closings
  ADD COLUMN IF NOT EXISTS hash_version      smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS jet_head_event_id bigint,
  ADD COLUMN IF NOT EXISTS jet_head_hash     text,
  ADD COLUMN IF NOT EXISTS archive_head_id   uuid,
  ADD COLUMN IF NOT EXISTS archive_head_hash text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_closings_hash_version_check') THEN
    ALTER TABLE public.pos_closings ADD CONSTRAINT pos_closings_hash_version_check CHECK (hash_version IN (1, 2));
  END IF;
END $$;
COMMENT ON COLUMN public.pos_closings.hash_version IS 'POS NF525 : version de la formule de hash de clôture (1 : jusqu''à 0.3.0 ; 2 : têtes JET et archive incluses).';
COMMENT ON COLUMN public.pos_closings.jet_head_hash IS 'POS NF525 (v2) : hash du dernier événement JET de la caisse avant la fin de période (jet_head_event_id).';
COMMENT ON COLUMN public.pos_closings.archive_head_hash IS 'POS NF525 (v2) : hash de la dernière archive de la caisse avant la fin de période (archive_head_id).';

-- -----------------------------------------------------------------------------
-- Formule de hash de clôture, v1 et v2 (≡ @pos/core closingCanonical)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_closing_canonical(
  p_version        int,
  p_number         bigint,
  p_period_type    text,
  p_period_start   timestamptz,
  p_period_end     timestamptz,
  p_txn_count      int,
  p_total_ttc      bigint,
  p_gtp            bigint,
  p_jet_head_hash  text,
  p_archive_hash   text,
  p_prev_hash      text
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF p_version = 1 THEN
    RETURN 'v1|closing|' || p_number || '|' || p_period_type
        || '|' || public.pos_canonical_ts(p_period_start) || '|' || public.pos_canonical_ts(p_period_end)
        || '|' || p_txn_count || '|' || p_total_ttc || '|' || p_gtp || '|' || coalesce(p_prev_hash, '');
  ELSIF p_version = 2 THEN
    RETURN 'v2|closing|' || p_number || '|' || p_period_type
        || '|' || public.pos_canonical_ts(p_period_start) || '|' || public.pos_canonical_ts(p_period_end)
        || '|' || p_txn_count || '|' || p_total_ttc || '|' || p_gtp
        || '|' || coalesce(p_jet_head_hash, '') || '|' || coalesce(p_archive_hash, '')
        || '|' || coalesce(p_prev_hash, '');
  END IF;
  RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION', DETAIL = format('{"field":"hash_version","value":%s}', coalesce(p_version::text, 'null'));
END;
$$;
COMMENT ON FUNCTION public.pos_closing_canonical(int, bigint, text, timestamptz, timestamptz, int, bigint, bigint, text, text, text) IS
  'POS NF525 : chaîne canonique d''une clôture (v1 : …|GTP|prev ; v2 : …|GTP|tête JET|tête archive|prev).';

CREATE OR REPLACE FUNCTION public.pos_closing_hash(
  p_version        int,
  p_number         bigint,
  p_period_type    text,
  p_period_start   timestamptz,
  p_period_end     timestamptz,
  p_txn_count      int,
  p_total_ttc      bigint,
  p_gtp            bigint,
  p_jet_head_hash  text,
  p_archive_hash   text,
  p_prev_hash      text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.pos_sha256(public.pos_closing_canonical(p_version, p_number, p_period_type, p_period_start,
    p_period_end, p_txn_count, p_total_ttc, p_gtp, p_jet_head_hash, p_archive_hash, p_prev_hash));
$$;
COMMENT ON FUNCTION public.pos_closing_hash(int, bigint, text, timestamptz, timestamptz, int, bigint, bigint, text, text, text) IS
  'POS NF525 : SHA-256 de pos_closing_canonical (hash de clôture v1 ou v2).';
REVOKE EXECUTE ON FUNCTION
  public.pos_closing_canonical(int, bigint, text, timestamptz, timestamptz, int, bigint, bigint, text, text, text),
  public.pos_closing_hash(int, bigint, text, timestamptz, timestamptz, int, bigint, bigint, text, text, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.pos_closing_canonical(int, bigint, text, timestamptz, timestamptz, int, bigint, bigint, text, text, text),
  public.pos_closing_hash(int, bigint, text, timestamptz, timestamptz, int, bigint, bigint, text, text, text)
TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pos_compute_closing : hash v2 (reste identique à 20261031180400_pos_offline_refs.sql)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_compute_closing(
  p_register_id  uuid,
  p_period_type  text,
  p_period_start timestamptz,
  p_period_end   timestamptz,
  p_session_id   uuid DEFAULT NULL,
  p_created_by   uuid DEFAULT auth.uid()
)
RETURNS public.pos_closings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_existing   public.pos_closings;
  v_closing    public.pos_closings;
  v_ids        uuid[];
  v_txn_count  int := 0;
  v_first      bigint;
  v_last       bigint;
  v_ht         bigint := 0;
  v_vat        bigint := 0;
  v_ttc        bigint := 0;
  v_refunds    bigint := 0;
  v_vat_bd     jsonb := '[]'::jsonb;
  v_pay_bd     jsonb := '[]'::jsonb;
  v_grand      bigint := 0;
  v_number     bigint;
  v_prev_hash  text;
  v_hash       text;
  v_gaps       jsonb;
  v_jet_id     bigint;
  v_jet_hash   text;
  v_arch_id    uuid;
  v_arch_hash  text;
BEGIN
  PERFORM public.pos_require_pos();
  IF p_period_type NOT IN ('daily', 'monthly', 'annual') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_period_type","reason":"daily|monthly|annual"}'::jsonb);
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end <= p_period_start THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"period","reason":"period_end must be after period_start"}'::jsonb);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pos_closing:' || p_register_id::text));

  -- Idempotence : une clôture existe déjà pour (caisse, type, début de période)
  SELECT * INTO v_existing
  FROM public.pos_closings c
  WHERE c.register_id = p_register_id AND c.period_type = p_period_type AND c.period_start = p_period_start;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  IF p_period_type = 'daily' THEN
    -- Tickets de la période : par session si fournie, sinon par business_at dans [start, end)
    SELECT array_agg(t.id) INTO v_ids
    FROM public.pos_transactions t
    WHERE t.register_id = p_register_id
      AND (
        (p_session_id IS NOT NULL AND t.session_id = p_session_id)
        OR (p_session_id IS NULL AND t.business_at >= p_period_start AND t.business_at < p_period_end)
      );

    SELECT count(*)::int, min(t.ticket_number), max(t.ticket_number),
           coalesce(sum(t.total_ht_cents), 0)::bigint,
           coalesce(sum(t.total_vat_cents), 0)::bigint,
           coalesce(sum(t.total_ttc_cents), 0)::bigint,
           coalesce(sum(t.total_ttc_cents) FILTER (WHERE t.kind = 'refund'), 0)::bigint
    INTO v_txn_count, v_first, v_last, v_ht, v_vat, v_ttc, v_refunds
    FROM public.pos_transactions t
    WHERE t.id = ANY (coalesce(v_ids, '{}'::uuid[]));

    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'rate', public.pos_canonical_rate(g.rate), 'base_ht_cents', g.ht, 'vat_cents', g.vat, 'ttc_cents', g.ttc
           ) ORDER BY g.rate), '[]'::jsonb)
    INTO v_vat_bd
    FROM (
      SELECT (e ->> 'rate')::numeric AS rate,
             sum((e ->> 'base_ht_cents')::bigint)::bigint AS ht,
             sum((e ->> 'vat_cents')::bigint)::bigint     AS vat,
             sum((e ->> 'ttc_cents')::bigint)::bigint     AS ttc
      FROM public.pos_transactions t
      CROSS JOIN LATERAL jsonb_array_elements(t.vat_breakdown) e
      WHERE t.id = ANY (coalesce(v_ids, '{}'::uuid[]))
      GROUP BY 1
    ) g;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'method', s.method, 'amount_cents', s.amount, 'count', s.cnt
           ) ORDER BY s.method), '[]'::jsonb)
    INTO v_pay_bd
    FROM (
      SELECT p.method, sum(p.amount_cents)::bigint AS amount, count(*)::int AS cnt
      FROM public.pos_payments p
      WHERE p.transaction_id = ANY (coalesce(v_ids, '{}'::uuid[]))
      GROUP BY p.method
    ) s;

    -- Grand total perpétuel : dernier GTP daily de la caisse + TTC net de la période
    SELECT coalesce(c.grand_total_perpetual_cents, 0) INTO v_grand
    FROM public.pos_closings c
    WHERE c.register_id = p_register_id AND c.period_type = 'daily'
    ORDER BY c.closing_number DESC
    LIMIT 1;
    v_grand := coalesce(v_grand, 0) + v_ttc;

  ELSE
    -- Mensuel / annuel : agrège les clôtures daily dont period_start est dans [start, end)
    SELECT coalesce(sum(c.txn_count), 0)::int,
           min(c.first_ticket_number), max(c.last_ticket_number),
           coalesce(sum(c.total_ht_cents), 0)::bigint,
           coalesce(sum(c.total_vat_cents), 0)::bigint,
           coalesce(sum(c.total_ttc_cents), 0)::bigint,
           coalesce(sum(c.refunds_ttc_cents), 0)::bigint
    INTO v_txn_count, v_first, v_last, v_ht, v_vat, v_ttc, v_refunds
    FROM public.pos_closings c
    WHERE c.register_id = p_register_id AND c.period_type = 'daily'
      AND c.period_start >= p_period_start AND c.period_start < p_period_end;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'rate', public.pos_canonical_rate(g.rate), 'base_ht_cents', g.ht, 'vat_cents', g.vat, 'ttc_cents', g.ttc
           ) ORDER BY g.rate), '[]'::jsonb)
    INTO v_vat_bd
    FROM (
      SELECT (e ->> 'rate')::numeric AS rate,
             sum((e ->> 'base_ht_cents')::bigint)::bigint AS ht,
             sum((e ->> 'vat_cents')::bigint)::bigint     AS vat,
             sum((e ->> 'ttc_cents')::bigint)::bigint     AS ttc
      FROM public.pos_closings c
      CROSS JOIN LATERAL jsonb_array_elements(c.vat_breakdown) e
      WHERE c.register_id = p_register_id AND c.period_type = 'daily'
        AND c.period_start >= p_period_start AND c.period_start < p_period_end
      GROUP BY 1
    ) g;

    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'method', s.method, 'amount_cents', s.amount, 'count', s.cnt
           ) ORDER BY s.method), '[]'::jsonb)
    INTO v_pay_bd
    FROM (
      SELECT (e ->> 'method') AS method,
             sum((e ->> 'amount_cents')::bigint)::bigint AS amount,
             sum((e ->> 'count')::int)::int              AS cnt
      FROM public.pos_closings c
      CROSS JOIN LATERAL jsonb_array_elements(c.payments_breakdown) e
      WHERE c.register_id = p_register_id AND c.period_type = 'daily'
        AND c.period_start >= p_period_start AND c.period_start < p_period_end
      GROUP BY 1
    ) s;

    -- GTP à la fin de la période = dernier GTP daily commencé avant period_end
    SELECT coalesce(c.grand_total_perpetual_cents, 0) INTO v_grand
    FROM public.pos_closings c
    WHERE c.register_id = p_register_id AND c.period_type = 'daily' AND c.period_start < p_period_end
    ORDER BY c.closing_number DESC
    LIMIT 1;
    v_grand := coalesce(v_grand, 0);
  END IF;

  -- 0.4.0 lot 5 : trous de numérotation hors ligne non résolus (Z1). Journalisés
  -- (offline_gap, detected_by = closing) avant la clôture, puis figés dans offline_gaps.
  IF p_period_type = 'daily' THEN
    v_gaps := public.pos_offline_gaps_summary(p_register_id);
    IF (v_gaps ->> 'count')::int > 0 THEN
      PERFORM public.pos_insert_event(p_register_id, p_session_id, p_created_by, 'offline_gap',
        jsonb_build_object('detected_by', 'closing', 'count', (v_gaps ->> 'count')::int, 'days', v_gaps -> 'days'));
    END IF;
  END IF;

  -- Numéro de clôture continu
  UPDATE public.pos_counters
  SET value = value + 1
  WHERE register_id = p_register_id AND kind = 'closing'
  RETURNING value INTO v_number;
  IF v_number IS NULL THEN
    PERFORM public.pos_error('REGISTER_NOT_FOUND', jsonb_build_object('register_id', p_register_id, 'reason', 'missing counter'));
  END IF;

  SELECT c.hash INTO v_prev_hash
  FROM public.pos_closings c
  WHERE c.register_id = p_register_id
  ORDER BY c.closing_number DESC
  LIMIT 1;
  v_prev_hash := coalesce(v_prev_hash, '');

  -- 0.4.0 lot 6 : têtes du JET (dernier événement de la caisse avant la fin de période,
  -- y compris offline_gap ci-dessus) et des archives, ancrées dans le hash v2.
  SELECT e.id, e.hash INTO v_jet_id, v_jet_hash
  FROM public.pos_events e
  WHERE e.register_id = p_register_id AND e.created_at < p_period_end
  ORDER BY e.id DESC
  LIMIT 1;
  SELECT a.id, a.hash INTO v_arch_id, v_arch_hash
  FROM public.pos_archives a
  WHERE a.register_id = p_register_id AND a.created_at < p_period_end
  ORDER BY a.period_start DESC, a.created_at DESC
  LIMIT 1;

  v_hash := public.pos_closing_hash(2, v_number, p_period_type, p_period_start, p_period_end,
                                    v_txn_count, v_ttc, v_grand, v_jet_hash, v_arch_hash, v_prev_hash);

  INSERT INTO public.pos_closings (
    register_id, closing_number, period_type, period_start, period_end, session_id,
    txn_count, first_ticket_number, last_ticket_number,
    total_ht_cents, total_vat_cents, total_ttc_cents, vat_breakdown, payments_breakdown,
    refunds_ttc_cents, grand_total_perpetual_cents, prev_hash, hash, created_by, offline_gaps,
    hash_version, jet_head_event_id, jet_head_hash, archive_head_id, archive_head_hash
  ) VALUES (
    p_register_id, v_number, p_period_type, p_period_start, p_period_end, p_session_id,
    v_txn_count, v_first, v_last,
    v_ht, v_vat, v_ttc, v_vat_bd, v_pay_bd,
    v_refunds, v_grand, v_prev_hash, v_hash, p_created_by, v_gaps,
    2, v_jet_id, v_jet_hash, v_arch_id, v_arch_hash
  )
  RETURNING * INTO v_closing;

  PERFORM public.pos_insert_event(p_register_id, p_session_id, p_created_by, 'closing',
    jsonb_build_object('closing_id', v_closing.id, 'closing_number', v_number, 'period_type', p_period_type,
                       'period_start', public.pos_canonical_ts(p_period_start), 'period_end', public.pos_canonical_ts(p_period_end),
                       'txn_count', v_txn_count, 'total_ttc_cents', v_ttc, 'grand_total_perpetual_cents', v_grand)
    || CASE WHEN v_gaps IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('offline_gaps_unresolved', (v_gaps ->> 'count')::int) END
    || jsonb_build_object('hash_version', 2, 'hash', v_hash,
                          'jet_head_event_id', v_jet_id, 'jet_head_hash', v_jet_hash,
                          'archive_head_id', v_arch_id, 'archive_head_hash', v_arch_hash));

  RETURN v_closing;
END;
$$;

COMMENT ON FUNCTION public.pos_compute_closing(uuid, text, timestamptz, timestamptz, uuid, uuid) IS
  'POS NF525 : crée (ou renvoie si déjà présente) une clôture daily (tickets de la session ou de [start,end)), monthly/annual (agrégat des daily), avec grand total perpétuel, numéro continu et hash v2 chaîné (têtes JET et archive) ; Z1 : trous hors ligne non résolus.';

-- -----------------------------------------------------------------------------
-- pos_verify_closings_chain : v1 et v2, têtes JET / archive contrôlées
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_verify_closings_chain(p_register_id uuid)
RETURNS TABLE (ok boolean, checked int, first_break_number bigint, reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  c          record;
  v_expected bigint := 1;
  v_prev     text := '';
  v_hash     text;
  v_head     text;
BEGIN
  PERFORM public.pos_require_pos();
  checked := 0;
  FOR c IN
    SELECT * FROM public.pos_closings WHERE register_id = p_register_id ORDER BY closing_number
  LOOP
    IF c.closing_number <> v_expected THEN
      ok := false; first_break_number := c.closing_number;
      reason := 'CLOSING_GAP: expected ' || v_expected || ', found ' || c.closing_number;
      RETURN NEXT; RETURN;
    END IF;
    IF c.prev_hash IS DISTINCT FROM v_prev THEN
      ok := false; first_break_number := c.closing_number; reason := 'PREV_HASH_MISMATCH';
      RETURN NEXT; RETURN;
    END IF;
    IF c.hash_version NOT IN (1, 2) THEN
      ok := false; first_break_number := c.closing_number; reason := 'UNKNOWN_HASH_VERSION';
      RETURN NEXT; RETURN;
    END IF;
    v_hash := public.pos_closing_hash(c.hash_version, c.closing_number, c.period_type, c.period_start, c.period_end,
                                      c.txn_count, c.total_ttc_cents, c.grand_total_perpetual_cents,
                                      c.jet_head_hash, c.archive_head_hash, c.prev_hash);
    IF v_hash <> c.hash THEN
      ok := false; first_break_number := c.closing_number; reason := 'HASH_MISMATCH';
      RETURN NEXT; RETURN;
    END IF;
    IF c.hash_version = 2 THEN
      IF c.jet_head_event_id IS NOT NULL OR c.jet_head_hash IS NOT NULL THEN
        SELECT e.hash INTO v_head FROM public.pos_events e
        WHERE e.id = c.jet_head_event_id AND e.register_id = p_register_id;
        IF v_head IS DISTINCT FROM c.jet_head_hash THEN
          ok := false; first_break_number := c.closing_number; reason := 'JET_HEAD_MISMATCH';
          RETURN NEXT; RETURN;
        END IF;
      END IF;
      IF c.archive_head_id IS NOT NULL OR c.archive_head_hash IS NOT NULL THEN
        SELECT a.hash INTO v_head FROM public.pos_archives a
        WHERE a.id = c.archive_head_id AND a.register_id = p_register_id;
        IF v_head IS DISTINCT FROM c.archive_head_hash THEN
          ok := false; first_break_number := c.closing_number; reason := 'ARCHIVE_HEAD_MISMATCH';
          RETURN NEXT; RETURN;
        END IF;
      END IF;
    END IF;
    v_prev := c.hash;
    v_expected := v_expected + 1;
    checked := checked + 1;
  END LOOP;
  ok := true; first_break_number := NULL; reason := NULL;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.pos_verify_closings_chain(uuid) IS
  'POS NF525 : vérifie la chaîne des clôtures d''une caisse (numéros continus, prev_hash, hash v1 ou v2 recalculé ; v2 : têtes JET et archive toujours égales au hash de l''élément référencé).';
REVOKE ALL ON FUNCTION public.pos_verify_closings_chain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_verify_closings_chain(uuid) TO authenticated, service_role;
