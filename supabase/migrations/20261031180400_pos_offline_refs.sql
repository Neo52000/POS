-- =============================================================================
-- POS NF525 — 0.4.0 lot 5 : file hors ligne vérifiable (projet Pos)
-- -----------------------------------------------------------------------------
-- 1. pos_offline_refs : une ligne par référence provisoire reçue
--    (OFF-<caisse>-<AAAAMMJJ>-<nnn>), vente rejouée (`sale`) ou élément abandonné
--    et tracé (`abandoned`, JET offline_sale_abandoned). Unicité
--    (caisse, jour, numéro) et client_txn_id. Immuable (UPDATE/DELETE/TRUNCATE).
-- 2. pos_finalize_sale : inscrit la référence ; si le numéro dépasse le maximum
--    connu du jour + 1 → JET offline_gap (numéros manquants). Le chaînage local
--    de la file (offline_chain_prev / offline_chain_hash, SHA-256 calculés par la
--    PWA) part dans le payload de l'événement JET de la vente, jamais dans le
--    hash ticket v1. Reste identique à 20261031180100_pos_session_stale.sql.
-- 3. Trigger AFTER INSERT sur pos_events (offline_sale_abandoned) : la
--    référence abandonnée est inscrite (le trou est résolu, avec sa trace).
-- 4. Fin de file : l'événement offline_exit porte last_seq_by_day
--    {"AAAAMMJJ": n} (dernier numéro attribué par le poste) ; les numéros
--    déclarés mais jamais reçus sont des trous (suppression en fin de file).
-- 5. pos_offline_gaps(caisse) / pos_offline_gaps_summary(caisse) : trous non
--    résolus ; pos_offline_chain_breaks(caisse) : maillons manquants du chaînage.
-- 6. pos_compute_closing (Z1, daily) : JET offline_gap (detected_by = closing)
--    et colonne pos_closings.offline_gaps {count, days, chain_breaks}, aussi
--    dans l'événement JET closing. Hash de clôture inchangé (v1).
-- Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_offline_refs (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  register_id     uuid        NOT NULL REFERENCES public.pos_registers (id),
  business_day    date        NOT NULL,
  seq             int         NOT NULL CHECK (seq > 0),
  provisional_ref text        NOT NULL,
  client_txn_id   uuid        NOT NULL UNIQUE,
  transaction_id  uuid        REFERENCES public.pos_transactions (id),
  source          text        NOT NULL CHECK (source IN ('sale', 'abandoned')),
  chain_prev      text,
  chain_hash      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (register_id, business_day, seq)
);
COMMENT ON TABLE public.pos_offline_refs IS 'POS NF525 : références provisoires hors ligne reçues (vente rejouée ou abandon tracé), base de la détection des trous (offline_gap). Immuable.';
ALTER TABLE public.pos_offline_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_offline_refs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.pos_offline_refs FROM authenticated, service_role;
GRANT SELECT ON public.pos_offline_refs TO authenticated, service_role;
DROP POLICY IF EXISTS pos_offline_refs_select ON public.pos_offline_refs;
CREATE POLICY pos_offline_refs_select ON public.pos_offline_refs FOR SELECT TO authenticated USING (public.is_pos());

DROP TRIGGER IF EXISTS trg_pos_offline_refs_immutable ON public.pos_offline_refs;
CREATE TRIGGER trg_pos_offline_refs_immutable
  BEFORE UPDATE OR DELETE ON public.pos_offline_refs
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();
DROP TRIGGER IF EXISTS trg_pos_offline_refs_no_truncate ON public.pos_offline_refs;
CREATE TRIGGER trg_pos_offline_refs_no_truncate
  BEFORE TRUNCATE ON public.pos_offline_refs
  FOR EACH STATEMENT EXECUTE FUNCTION public.pos_forbid_truncate();

ALTER TABLE public.pos_closings ADD COLUMN IF NOT EXISTS offline_gaps jsonb;
COMMENT ON COLUMN public.pos_closings.offline_gaps IS 'POS NF525 (Z1) : trous de numérotation hors ligne non résolus à la clôture {count, days:[{business_day, missing}], chain_breaks}.';

-- -----------------------------------------------------------------------------
-- Analyse d'une référence provisoire
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_parse_provisional_ref(p_ref text)
RETURNS TABLE (register_code text, business_day date, seq int)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_m text[];
BEGIN
  v_m := regexp_match(coalesce(p_ref, ''), '^OFF-(.+)-([0-9]{8})-([0-9]{1,6})$');
  IF v_m IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    register_code := v_m[1];
    business_day  := to_date(v_m[2], 'YYYYMMDD');
    seq           := v_m[3]::int;
    IF to_char(business_day, 'YYYYMMDD') <> v_m[2] OR seq < 1 THEN
      RETURN;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.pos_parse_provisional_ref(text) IS 'POS NF525 : OFF-<caisse>-<AAAAMMJJ>-<nnn> → (register_code, business_day, seq) ; aucune ligne si invalide.';
GRANT EXECUTE ON FUNCTION public.pos_parse_provisional_ref(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Inscription d'une référence reçue (vente rejouée ou abandon tracé)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_offline_ref_record(
  p_register_id    uuid,
  p_session_id     uuid,
  p_ref            text,
  p_client_txn_id  uuid,
  p_transaction_id uuid,
  p_source         text,
  p_chain_prev     text,
  p_chain_hash     text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_code text;
  v_p    record;
  v_max  int;
  v_id   bigint;
BEGIN
  SELECT r.code INTO v_code FROM public.pos_registers r WHERE r.id = p_register_id;
  SELECT * INTO v_p FROM public.pos_parse_provisional_ref(p_ref);
  IF v_p.seq IS NULL OR v_p.register_code IS DISTINCT FROM v_code OR p_client_txn_id IS NULL THEN
    PERFORM public.pos_insert_event(p_register_id, p_session_id, NULL, 'offline_ref_invalid',
      jsonb_build_object('provisional_ref', p_ref, 'client_txn_id', p_client_txn_id,
                         'transaction_id', p_transaction_id, 'source', p_source, 'register_code', v_code));
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_offline_refs o WHERE o.client_txn_id = p_client_txn_id) THEN
    RETURN;  -- déjà inscrite (idempotent)
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pos_offline_refs:' || p_register_id::text || ':' || v_p.business_day::text));
  SELECT max(o.seq) INTO v_max FROM public.pos_offline_refs o
  WHERE o.register_id = p_register_id AND o.business_day = v_p.business_day;

  INSERT INTO public.pos_offline_refs (register_id, business_day, seq, provisional_ref, client_txn_id,
                                       transaction_id, source, chain_prev, chain_hash)
  VALUES (p_register_id, v_p.business_day, v_p.seq, p_ref, p_client_txn_id, p_transaction_id, p_source,
          nullif(p_chain_prev, ''), nullif(p_chain_hash, ''))
  ON CONFLICT (register_id, business_day, seq) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    PERFORM public.pos_insert_event(p_register_id, p_session_id, NULL, 'offline_ref_duplicate',
      jsonb_build_object('provisional_ref', p_ref, 'client_txn_id', p_client_txn_id,
                         'transaction_id', p_transaction_id, 'source', p_source));
    RETURN;
  END IF;

  IF v_p.seq > coalesce(v_max, 0) + 1 THEN
    PERFORM public.pos_insert_event(p_register_id, p_session_id, NULL, 'offline_gap',
      jsonb_build_object('detected_by', 'replay', 'business_day', v_p.business_day::text,
                         'provisional_ref', p_ref, 'previous_max_seq', coalesce(v_max, 0),
                         'missing', (SELECT jsonb_agg(g ORDER BY g)
                                     FROM generate_series(coalesce(v_max, 0) + 1, v_p.seq - 1) g)));
  END IF;
END;
$$;
COMMENT ON FUNCTION public.pos_offline_ref_record(uuid, uuid, text, uuid, uuid, text, text, text) IS
  'POS NF525 (interne) : inscrit une référence provisoire reçue ; JET offline_gap si numéro > max + 1, offline_ref_invalid / offline_ref_duplicate sinon.';
REVOKE EXECUTE ON FUNCTION public.pos_offline_ref_record(uuid, uuid, text, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;

-- Abandon tracé d'un élément de la file (JET offline_sale_abandoned) : le numéro est résolu.
CREATE OR REPLACE FUNCTION public.pos_events_offline_ref()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_ctid uuid;
BEGIN
  IF NEW.register_id IS NOT NULL AND nullif(NEW.payload ->> 'provisional_ref', '') IS NOT NULL THEN
    BEGIN
      v_ctid := (NEW.payload ->> 'client_txn_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_ctid := NULL;
    END;
    PERFORM public.pos_offline_ref_record(NEW.register_id, NEW.session_id, NEW.payload ->> 'provisional_ref',
      v_ctid, NULL, 'abandoned',
      nullif(NEW.payload -> 'payload' ->> 'offline_chain_prev', ''),
      nullif(NEW.payload -> 'payload' ->> 'offline_chain_hash', ''));
  END IF;
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.pos_events_offline_ref() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pos_events_offline_ref ON public.pos_events;
CREATE TRIGGER trg_pos_events_offline_ref
  AFTER INSERT ON public.pos_events
  FOR EACH ROW WHEN (NEW.event_type = 'offline_sale_abandoned')
  EXECUTE FUNCTION public.pos_events_offline_ref();

-- -----------------------------------------------------------------------------
-- Trous non résolus : numéros 1..max(reçu, déclaré par offline_exit) absents
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_offline_gaps(p_register_id uuid)
RETURNS TABLE (business_day date, max_received int, max_declared int, missing int[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  WITH declared AS (
    SELECT to_date(d.key, 'YYYYMMDD') AS business_day, max((d.value #>> '{}')::int) AS max_declared
    FROM public.pos_events e
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(e.payload -> 'last_seq_by_day') = 'object'
                                       THEN e.payload -> 'last_seq_by_day' ELSE '{}'::jsonb END) d
    WHERE e.register_id = p_register_id AND e.event_type = 'offline_exit'
      AND d.key ~ '^[0-9]{8}$' AND jsonb_typeof(d.value) = 'number' AND (d.value #>> '{}')::numeric BETWEEN 1 AND 999999
    GROUP BY 1
  ), received AS (
    SELECT o.business_day, max(o.seq) AS max_received
    FROM public.pos_offline_refs o WHERE o.register_id = p_register_id GROUP BY 1
  ), days AS (
    SELECT coalesce(r.business_day, d.business_day) AS business_day,
           coalesce(r.max_received, 0) AS max_received, coalesce(d.max_declared, 0) AS max_declared
    FROM received r FULL JOIN declared d ON d.business_day = r.business_day
  )
  SELECT x.business_day, x.max_received, x.max_declared, x.missing
  FROM (
    SELECT dd.business_day, dd.max_received, dd.max_declared,
           ARRAY(SELECT g FROM generate_series(1, greatest(dd.max_received, dd.max_declared)) g
                 WHERE NOT EXISTS (SELECT 1 FROM public.pos_offline_refs o
                                   WHERE o.register_id = p_register_id AND o.business_day = dd.business_day AND o.seq = g)
                 ORDER BY g) AS missing
    FROM days dd
  ) x
  WHERE cardinality(x.missing) > 0
  ORDER BY x.business_day;
$$;
COMMENT ON FUNCTION public.pos_offline_gaps(uuid) IS
  'POS NF525 : trous non résolus de la numérotation hors ligne par jour (numéros 1..max(reçu, déclaré offline_exit) absents de pos_offline_refs).';
REVOKE EXECUTE ON FUNCTION public.pos_offline_gaps(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_offline_gaps(uuid) TO authenticated, service_role;

-- Maillons du chaînage local dont le prédécesseur n'a jamais été reçu (suppression au milieu).
CREATE OR REPLACE FUNCTION public.pos_offline_chain_breaks(p_register_id uuid)
RETURNS TABLE (provisional_ref text, chain_prev text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT o.provisional_ref, o.chain_prev
  FROM public.pos_offline_refs o
  WHERE o.register_id = p_register_id AND o.chain_prev IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.pos_offline_refs p
                    WHERE p.register_id = p_register_id AND p.chain_hash = o.chain_prev)
    AND NOT EXISTS (SELECT 1 FROM public.pos_events e
                    WHERE e.register_id = p_register_id AND e.event_type IN ('sale', 'refund')
                      AND e.payload ->> 'offline_chain_hash' = o.chain_prev)
  ORDER BY o.id;
$$;
COMMENT ON FUNCTION public.pos_offline_chain_breaks(uuid) IS
  'POS NF525 : éléments hors ligne dont le maillon précédent (chain_prev) n''a jamais été reçu ni tracé.';
REVOKE EXECUTE ON FUNCTION public.pos_offline_chain_breaks(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_offline_chain_breaks(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_offline_gaps_summary(p_register_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT jsonb_build_object(
    'count', coalesce((SELECT sum(cardinality(g.missing)) FROM public.pos_offline_gaps(p_register_id) g), 0)::int,
    'days', coalesce((SELECT jsonb_agg(jsonb_build_object('business_day', g.business_day::text, 'missing', to_jsonb(g.missing))
                                       ORDER BY g.business_day)
                      FROM public.pos_offline_gaps(p_register_id) g), '[]'::jsonb),
    'chain_breaks', (SELECT count(*) FROM public.pos_offline_chain_breaks(p_register_id))::int);
$$;
COMMENT ON FUNCTION public.pos_offline_gaps_summary(uuid) IS
  'POS NF525 : {count, days:[{business_day, missing}], chain_breaks} des trous hors ligne non résolus.';
REVOKE EXECUTE ON FUNCTION public.pos_offline_gaps_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_offline_gaps_summary(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pos_finalize_sale (inscription de la référence, chaînage au JET)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_finalize_sale(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_client_txn_id  uuid;
  v_register_id    uuid;
  v_session_id     uuid;
  v_kind           text;
  v_refund_of      uuid;
  v_refund_reason  text;
  v_business_at    timestamptz;
  v_customer_id    uuid;
  v_quote_id       uuid;
  v_cashier_id     uuid;
  v_change         bigint;
  v_register       public.pos_registers;
  v_session        public.pos_sessions;
  v_existing       public.pos_transactions;
  v_target         public.pos_transactions;
  v_txn            public.pos_transactions;
  v_cart           jsonb;
  v_totals         jsonb;
  v_received       jsonb;
  v_payments       jsonb := '[]'::jsonb;
  v_pay            jsonb;
  v_pay_idx        int := 0;
  v_method         text;
  v_amount         bigint;
  v_reference      text;
  v_tendered       bigint := 0;
  v_has_cash       boolean := false;
  v_chk            record;
  v_snapshot       jsonb;
  v_ticket_number  bigint;
  v_prev_hash      text;
  v_lines_digest   text;
  v_pay_digest     text;
  v_hash           text;
  v_lines_out      jsonb;
  v_payments_out   jsonb;
  v_offline        boolean;
  v_deferred       boolean;
  v_tol            jsonb;
  v_orig_session   uuid;
  v_day_start      timestamptz;
BEGIN
  PERFORM public.pos_require_pos();

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"payload","reason":"object expected"}'::jsonb);
  END IF;

  -- ---------------------------------------------------------------- en-tête
  BEGIN
    v_client_txn_id := (p_payload ->> 'client_txn_id')::uuid;
    v_register_id   := (p_payload ->> 'register_id')::uuid;
    v_session_id    := (p_payload ->> 'session_id')::uuid;
    v_refund_of     := nullif(p_payload ->> 'refund_of_transaction_id', '')::uuid;
    v_customer_id   := nullif(p_payload ->> 'customer_account_id', '')::uuid;
    v_quote_id      := nullif(p_payload ->> 'quote_id', '')::uuid;
    v_business_at   := (p_payload ->> 'business_at')::timestamptz;
    v_cashier_id    := coalesce(auth.uid(), nullif(p_payload ->> 'cashier_id', '')::uuid);
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
    PERFORM public.pos_error('VALIDATION', jsonb_build_object('reason', 'invalid identifier or date', 'sqlerrm', SQLERRM));
  END;

  v_kind          := p_payload ->> 'kind';
  v_refund_reason := nullif(btrim(coalesce(p_payload ->> 'refund_reason', '')), '');
  v_change        := coalesce((p_payload ->> 'change_cents')::bigint, 0);

  IF v_client_txn_id IS NULL OR v_register_id IS NULL OR v_session_id IS NULL THEN
    PERFORM public.pos_error('VALIDATION', '{"reason":"client_txn_id, register_id and session_id are required"}'::jsonb);
  END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('sale', 'refund') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"kind","reason":"sale|refund"}'::jsonb);
  END IF;
  IF v_business_at IS NULL THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"business_at","reason":"ISO timestamp required"}'::jsonb);
  END IF;
  IF v_cashier_id IS NULL THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"cashier_id","reason":"auth.uid() or payload.cashier_id required"}'::jsonb);
  END IF;
  IF v_change < 0 THEN
    PERFORM public.pos_error('PAYMENTS_MISMATCH', '{"reason":"change_cents must be >= 0"}'::jsonb);
  END IF;

  SELECT * INTO v_register FROM public.pos_registers r WHERE r.id = v_register_id;
  IF NOT FOUND THEN
    PERFORM public.pos_error('REGISTER_NOT_FOUND', jsonb_build_object('register_id', v_register_id));
  END IF;

  -- ------------------------------------------------ verrou caisse + idempotence
  -- Le verrou sérialise les ventes d'une même caisse (numérotation, chaînage) et
  -- garantit que la relecture d'idempotence voit une éventuelle vente concurrente.
  PERFORM pg_advisory_xact_lock(hashtext('pos_txn:' || v_register_id::text));

  SELECT * INTO v_existing FROM public.pos_transactions t WHERE t.client_txn_id = v_client_txn_id;
  IF FOUND THEN
    SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.line_no), '[]'::jsonb) INTO v_lines_out
    FROM public.pos_transaction_lines l WHERE l.transaction_id = v_existing.id;
    SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at, p.id), '[]'::jsonb) INTO v_payments_out
    FROM public.pos_payments p WHERE p.transaction_id = v_existing.id;
    RETURN jsonb_build_object(
      'idempotent_replay', true,
      'transaction_id',    v_existing.id,
      'transaction',       to_jsonb(v_existing),
      'lines',             v_lines_out,
      'payments',          v_payments_out
    );
  END IF;

  -- ------------------------------------------- horodatage (lot 4, anti-antidatage)
  -- Placé après l'idempotence : le rejeu d'une vente déjà enregistrée réussit toujours.
  v_offline  := coalesce((p_payload ->> 'offline_queued')::boolean, false);
  v_deferred := coalesce((p_payload ->> 'deferred_capture')::boolean, false);
  IF v_offline AND v_kind = 'refund' THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"offline_queued","reason":"refunds are not allowed offline"}'::jsonb);
  END IF;
  -- deferred_capture (lot 4 bis) : paiement déjà capté par le TPE, enregistrement retardé par une
  -- coupure. Exige une CB réelle (preuve : transaction TPE) ; ouvre la fenêtre hors ligne et le
  -- rattachement de session, y compris pour un remboursement.
  IF v_deferred AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(p_payload -> 'payments', '[]'::jsonb)) p
       WHERE p ->> 'method' = 'cb' AND NOT coalesce((p ->> 'manual_fallback')::boolean, false)) THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"deferred_capture","reason":"requires a card payment captured by the terminal"}'::jsonb);
  END IF;
  SELECT s.value INTO v_tol FROM public.pos_settings s WHERE s.key = 'clock_tolerance';
  v_tol := coalesce(v_tol, '{}'::jsonb);
  IF v_offline OR v_deferred THEN
    IF v_business_at < now() - make_interval(hours => coalesce((v_tol ->> 'offline_hours')::int, 72))
       OR v_business_at > now() + make_interval(mins => coalesce((v_tol ->> 'future_minutes')::int, 5)) THEN
      PERFORM public.pos_error('BUSINESS_AT_OUT_OF_RANGE', jsonb_build_object(
        'business_at', v_business_at, 'server_now', now(), 'offline_queued', v_offline,
        'deferred_capture', v_deferred, 'tolerance', v_tol));
    END IF;
  ELSIF abs(extract(epoch FROM (v_business_at - now()))) > 60 * coalesce((v_tol ->> 'online_minutes')::int, 10) THEN
    PERFORM public.pos_error('BUSINESS_AT_OUT_OF_RANGE', jsonb_build_object(
      'business_at', v_business_at, 'server_now', now(), 'offline_queued', false, 'tolerance', v_tol));
  END IF;

  -- ---------------------------------------------------------------- session
  -- Vente hors ligne rejouée après la clôture de sa session : rattachée à la
  -- session ouverte de la caisse (elle entre dans le Z suivant ; business_date
  -- d'origine conservée ; événement JET offline_reattached). Le Z déjà calculé
  -- n'est jamais modifié.
  SELECT * INTO v_session FROM public.pos_sessions s WHERE s.id = v_session_id AND s.register_id = v_register_id;
  IF NOT FOUND THEN
    PERFORM public.pos_error('SESSION_NOT_OPEN', jsonb_build_object('session_id', v_session_id, 'register_id', v_register_id));
  END IF;
  IF v_session.status <> 'open' THEN
    IF NOT (v_offline OR v_deferred) THEN
      PERFORM public.pos_error('SESSION_NOT_OPEN', jsonb_build_object('session_id', v_session_id, 'register_id', v_register_id));
    END IF;
    SELECT * INTO v_session FROM public.pos_sessions s WHERE s.register_id = v_register_id AND s.status = 'open';
    IF NOT FOUND THEN
      PERFORM public.pos_error('SESSION_NOT_OPEN', jsonb_build_object(
        'session_id', v_session_id, 'register_id', v_register_id, 'reason', 'offline sale replay needs an open session'));
    END IF;
    v_orig_session := v_session_id;
    v_session_id   := v_session.id;
  END IF;

  -- 0.4.0 lot 2 : clôture Z journalière garantie. Une session ouverte avant le début du
  -- jour courant (heure de Paris) est périmée : aucune vente ni remboursement, en ligne ou
  -- rejoué, tant que son Z1 n'est pas établi (SESSION_STALE, 409). Le rejeu hors ligne
  -- garde son rattachement : après le Z, la vente rejoint la nouvelle session.
  SELECT b.period_start INTO v_day_start FROM public.pos_period_bounds('daily', now()) b;
  IF v_session.opened_at < v_day_start THEN
    PERFORM public.pos_error('SESSION_STALE', jsonb_build_object(
      'session_id', v_session.id, 'session_number', v_session.session_number,
      'opened_at', v_session.opened_at, 'day_start', v_day_start, 'register_id', v_register_id));
  END IF;

  -- ------------------------------------------------------- calcul du panier
  v_cart   := public.pos_compute_cart(p_payload -> 'lines');
  v_totals := v_cart -> 'totals';

  v_received := p_payload -> 'totals';
  IF v_received IS NOT NULL AND jsonb_typeof(v_received) = 'object' THEN
    IF (v_received ->> 'total_ht_cents')::bigint  IS DISTINCT FROM (v_totals ->> 'total_ht_cents')::bigint
    OR (v_received ->> 'total_vat_cents')::bigint IS DISTINCT FROM (v_totals ->> 'total_vat_cents')::bigint
    OR (v_received ->> 'total_ttc_cents')::bigint IS DISTINCT FROM (v_totals ->> 'total_ttc_cents')::bigint THEN
      PERFORM public.pos_error('TOTALS_MISMATCH', jsonb_build_object('expected', v_totals, 'received', v_received));
    END IF;
  END IF;

  -- ------------------------------------------------------------ paiements
  IF p_payload -> 'payments' IS NULL OR jsonb_typeof(p_payload -> 'payments') <> 'array'
     OR jsonb_array_length(p_payload -> 'payments') = 0 THEN
    PERFORM public.pos_error('PAYMENTS_MISMATCH', '{"reason":"at least one payment required"}'::jsonb);
  END IF;

  FOR v_pay IN SELECT * FROM jsonb_array_elements(p_payload -> 'payments') LOOP
    v_pay_idx   := v_pay_idx + 1;
    v_method    := v_pay ->> 'method';
    v_amount    := (v_pay ->> 'amount_cents')::bigint;
    v_reference := nullif(btrim(coalesce(v_pay ->> 'reference', '')), '');

    IF v_method IS NULL OR v_method NOT IN ('cb', 'cash', 'cheque', 'gift_ucia', 'transfer') THEN
      PERFORM public.pos_error('VALIDATION', jsonb_build_object('payment', v_pay_idx, 'field', 'method', 'reason', 'cb|cash|cheque|gift_ucia|transfer'));
    END IF;
    IF v_amount IS NULL THEN
      PERFORM public.pos_error('VALIDATION', jsonb_build_object('payment', v_pay_idx, 'field', 'amount_cents', 'reason', 'integer required'));
    END IF;
    IF v_method IN ('cheque', 'gift_ucia', 'transfer') AND v_reference IS NULL THEN
      PERFORM public.pos_error('VALIDATION', jsonb_build_object('payment', v_pay_idx, 'field', 'reference', 'reason', 'required for ' || v_method));
    END IF;
    IF v_method = 'cb' AND coalesce((v_pay ->> 'manual_fallback')::boolean, false)
       AND nullif(btrim(coalesce(v_pay -> 'tpe_response' ->> 'reason', '')), '') IS NULL THEN
      PERFORM public.pos_error('VALIDATION', jsonb_build_object('payment', v_pay_idx, 'field', 'tpe_response.reason', 'reason', 'required when manual_fallback'));
    END IF;
    IF (v_kind = 'sale' AND v_amount < 0) OR (v_kind = 'refund' AND v_amount > 0) THEN
      PERFORM public.pos_error('PAYMENTS_MISMATCH', jsonb_build_object('payment', v_pay_idx, 'reason', 'amount sign inconsistent with kind ' || v_kind));
    END IF;

    v_tendered := v_tendered + v_amount;
    v_has_cash := v_has_cash OR v_method = 'cash';
    v_payments := v_payments || jsonb_build_object(
      'method',          v_method,
      'amount_cents',    v_amount,
      'reference',       v_reference,
      'tpe_response',    v_pay -> 'tpe_response',
      'manual_fallback', coalesce((v_pay ->> 'manual_fallback')::boolean, false)
    );
  END LOOP;

  IF v_tendered - v_change <> (v_totals ->> 'total_ttc_cents')::bigint THEN
    PERFORM public.pos_error('PAYMENTS_MISMATCH', jsonb_build_object(
      'reason', 'sum(payments) - change_cents must equal total_ttc_cents',
      'tendered_cents', v_tendered, 'change_cents', v_change, 'total_ttc_cents', (v_totals ->> 'total_ttc_cents')::bigint));
  END IF;
  IF v_change > 0 AND NOT v_has_cash THEN
    PERFORM public.pos_error('PAYMENTS_MISMATCH', jsonb_build_object('reason', 'change_cents > 0 requires a cash payment', 'change_cents', v_change));
  END IF;
  IF v_kind = 'refund' AND v_change <> 0 THEN
    PERFORM public.pos_error('PAYMENTS_MISMATCH', jsonb_build_object('reason', 'change_cents must be 0 on a refund', 'change_cents', v_change));
  END IF;

  -- ---------------------------------------------------------- remboursement
  IF v_kind = 'refund' THEN
    IF v_refund_of IS NULL THEN
      PERFORM public.pos_error('VALIDATION', '{"field":"refund_of_transaction_id","reason":"required for refund"}'::jsonb);
    END IF;
    IF v_refund_reason IS NULL THEN
      PERFORM public.pos_error('VALIDATION', '{"field":"refund_reason","reason":"required for refund"}'::jsonb);
    END IF;
    SELECT * INTO v_target FROM public.pos_transactions t
    WHERE t.id = v_refund_of AND t.register_id = v_register_id AND t.kind = 'sale';
    IF NOT FOUND THEN
      PERFORM public.pos_error('REFUND_TARGET_NOT_FOUND', jsonb_build_object('refund_of_transaction_id', v_refund_of, 'register_id', v_register_id));
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_cart -> 'lines') l WHERE (l ->> 'qty')::numeric > 0) THEN
      PERFORM public.pos_error('VALIDATION', '{"field":"lines.qty","reason":"refund lines must have negative qty"}'::jsonb);
    END IF;

    -- Par produit (ou libellé si pas de product_id) : déjà remboursé + demandé <= vendu
    FOR v_chk IN
      WITH req AS (
        SELECT coalesce(l ->> 'product_id', 'label:' || (l ->> 'label')) AS k, sum(-(l ->> 'qty')::numeric) AS q
        FROM jsonb_array_elements(v_cart -> 'lines') l GROUP BY 1
      ), sold AS (
        SELECT coalesce(l.product_id::text, 'label:' || l.label) AS k, sum(l.qty) AS q
        FROM public.pos_transaction_lines l WHERE l.transaction_id = v_refund_of GROUP BY 1
      ), done AS (
        SELECT coalesce(l.product_id::text, 'label:' || l.label) AS k, sum(-l.qty) AS q
        FROM public.pos_transaction_lines l
        JOIN public.pos_transactions t ON t.id = l.transaction_id
        WHERE t.refund_of_transaction_id = v_refund_of GROUP BY 1
      )
      SELECT req.k, req.q AS requested, coalesce(sold.q, 0) AS sold, coalesce(done.q, 0) AS already
      FROM req LEFT JOIN sold USING (k) LEFT JOIN done USING (k)
      WHERE req.q + coalesce(done.q, 0) > coalesce(sold.q, 0)
      ORDER BY req.k
      LIMIT 1
    LOOP
      PERFORM public.pos_error('REFUND_EXCEEDS_SOLD', jsonb_build_object(
        'key', v_chk.k, 'requested', v_chk.requested, 'already_refunded', v_chk.already, 'sold', v_chk.sold,
        'refund_of_transaction_id', v_refund_of));
    END LOOP;
  ELSE
    v_refund_of     := NULL;
    v_refund_reason := NULL;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_cart -> 'lines') l WHERE (l ->> 'qty')::numeric < 0) THEN
      PERFORM public.pos_error('VALIDATION', '{"field":"lines.qty","reason":"sale lines must have positive qty"}'::jsonb);
    END IF;
  END IF;

  -- ------------------------------------------------------- client / devis
  -- Le snapshot client (customer_360 ma-papeterie) est fourni par l'Edge
  -- Function pos-checkout via le bridge pos_customer_get ; quote_id /
  -- quote_number sont vérifiés par l'Edge Function (QUOTE_NOT_FOUND) et
  -- stockés tels quels.
  IF jsonb_typeof(p_payload -> 'customer_snapshot') = 'object' THEN
    v_snapshot := jsonb_strip_nulls(p_payload -> 'customer_snapshot');
  END IF;

  -- -------------------------------------------- numérotation + chaînage
  UPDATE public.pos_counters
  SET value = value + 1
  WHERE register_id = v_register_id AND kind = 'ticket'
  RETURNING value INTO v_ticket_number;
  IF v_ticket_number IS NULL THEN
    PERFORM public.pos_error('REGISTER_NOT_FOUND', jsonb_build_object('register_id', v_register_id, 'reason', 'missing counter'));
  END IF;

  IF v_ticket_number = 1 THEN
    v_prev_hash := '';
  ELSE
    SELECT t.hash INTO v_prev_hash FROM public.pos_transactions t
    WHERE t.register_id = v_register_id AND t.ticket_number = v_ticket_number - 1;
    IF v_prev_hash IS NULL THEN
      PERFORM public.pos_error('CHAIN_INCONSISTENT', jsonb_build_object('register_id', v_register_id, 'missing_ticket', v_ticket_number - 1));
    END IF;
  END IF;

  v_lines_digest := public.pos_lines_digest_from_json(v_cart -> 'lines');
  v_pay_digest   := public.pos_payments_digest_from_json(v_payments);
  v_hash := public.pos_sha256(public.pos_build_canonical_txn(
    v_ticket_number, v_register.code, v_client_txn_id, v_business_at, v_kind,
    (v_totals ->> 'total_ht_cents')::bigint, (v_totals ->> 'total_vat_cents')::bigint, (v_totals ->> 'total_ttc_cents')::bigint,
    v_cart -> 'vat_breakdown', v_customer_id, v_lines_digest, v_pay_digest, v_prev_hash));

  -- ------------------------------------------------------------ insertion
  INSERT INTO public.pos_transactions (
    client_txn_id, register_id, session_id, ticket_number, kind,
    refund_of_transaction_id, refund_reason, business_at, business_date, cashier_id,
    customer_account_id, customer_snapshot, quote_id, quote_number, invoice_requested,
    total_ht_cents, total_vat_cents, total_ttc_cents, vat_breakdown,
    tendered_cents, change_cents, offline_queued, provisional_ref,
    prev_hash, hash, hash_version, signature_status, app_version
  ) VALUES (
    v_client_txn_id, v_register_id, v_session_id, v_ticket_number, v_kind,
    v_refund_of, v_refund_reason, v_business_at, (v_business_at AT TIME ZONE 'Europe/Paris')::date, v_cashier_id,
    v_customer_id, v_snapshot, v_quote_id, nullif(p_payload ->> 'quote_number', ''), coalesce((p_payload ->> 'invoice_requested')::boolean, false),
    (v_totals ->> 'total_ht_cents')::bigint, (v_totals ->> 'total_vat_cents')::bigint, (v_totals ->> 'total_ttc_cents')::bigint,
    v_cart -> 'vat_breakdown',
    v_tendered, v_change, v_offline, nullif(p_payload ->> 'provisional_ref', ''),
    v_prev_hash, v_hash, 1, 'pending_signature', nullif(p_payload ->> 'app_version', '')
  )
  RETURNING * INTO v_txn;

  INSERT INTO public.pos_transaction_lines (
    transaction_id, line_no, product_id, ean, sku, label, qty,
    unit_price_ttc_cents, unit_price_ht_cents, vat_rate, discount_percent, discount_reason,
    line_ttc_cents, line_ht_cents, line_vat_cents, eco_tax_cents,
    pricing_rule_id, price_tier_title, public_price_ttc_cents
  )
  SELECT v_txn.id, (l ->> 'line_no')::int, (l ->> 'product_id')::uuid, l ->> 'ean', l ->> 'sku', l ->> 'label', (l ->> 'qty')::numeric,
         (l ->> 'unit_price_ttc_cents')::bigint, (l ->> 'unit_price_ht_cents')::bigint, (l ->> 'vat_rate')::numeric,
         (l ->> 'discount_percent')::numeric, l ->> 'discount_reason',
         (l ->> 'line_ttc_cents')::bigint, (l ->> 'line_ht_cents')::bigint, (l ->> 'line_vat_cents')::bigint, (l ->> 'eco_tax_cents')::bigint,
         (l ->> 'pricing_rule_id')::uuid, l ->> 'price_tier_title', (l ->> 'public_price_ttc_cents')::bigint
  FROM jsonb_array_elements(v_cart -> 'lines') l;

  INSERT INTO public.pos_payments (transaction_id, method, amount_cents, reference, tpe_response, manual_fallback)
  SELECT v_txn.id, p ->> 'method', (p ->> 'amount_cents')::bigint, p ->> 'reference', p -> 'tpe_response', (p ->> 'manual_fallback')::boolean
  FROM jsonb_array_elements(v_payments) p;

  -- ------------------------------------------------------- stock (outbox)
  -- Le stock_boutique vit dans ma-papeterie : une ligne d'outbox par ligne de
  -- ticket avec product_id, appliquée par l'Edge Function pos-stock-sync
  -- (bridge pos_apply_stock_movements, idempotent). Vente : -qty ;
  -- remboursement : +|qty|. Les quantités fractionnaires sont arrondies (::int).
  INSERT INTO public.pos_stock_sync (transaction_id, product_id, qty_delta, idempotency_key)
  SELECT v_txn.id,
         (l ->> 'product_id')::uuid,
         -(((l ->> 'qty')::numeric)::int),
         v_txn.id::text || ':' || (l ->> 'line_no')
  FROM jsonb_array_elements(v_cart -> 'lines') l
  WHERE nullif(l ->> 'product_id', '') IS NOT NULL
    AND ((l ->> 'qty')::numeric)::int <> 0;

  -- ------------------------------------------------------------- JET
  -- Chaînage local de la file hors ligne (0.4.0 lot 5) : tracé au JET, jamais dans le hash v1.
  PERFORM public.pos_insert_event(v_register_id, v_session_id, v_cashier_id, v_kind,
    jsonb_build_object('transaction_id', v_txn.id, 'ticket_number', v_ticket_number, 'client_txn_id', v_client_txn_id,
                       'total_ttc_cents', v_txn.total_ttc_cents, 'refund_of_transaction_id', v_refund_of,
                       'offline_queued', v_txn.offline_queued, 'provisional_ref', v_txn.provisional_ref,
                       'deferred_capture', v_deferred)
    || jsonb_strip_nulls(jsonb_build_object(
         'offline_chain_prev', nullif(p_payload ->> 'offline_chain_prev', ''),
         'offline_chain_hash', nullif(p_payload ->> 'offline_chain_hash', ''))),
    v_business_at);
  -- Référence provisoire OFF-<caisse>-<AAAAMMJJ>-<nnn> : inscrite, trous signalés (offline_gap).
  IF v_txn.provisional_ref IS NOT NULL THEN
    PERFORM public.pos_offline_ref_record(v_register_id, v_session_id, v_txn.provisional_ref, v_client_txn_id,
      v_txn.id, 'sale', nullif(p_payload ->> 'offline_chain_prev', ''), nullif(p_payload ->> 'offline_chain_hash', ''));
  END IF;
  IF v_orig_session IS NOT NULL THEN
    PERFORM public.pos_insert_event(v_register_id, v_session_id, v_cashier_id, 'offline_reattached',
      jsonb_build_object('transaction_id', v_txn.id, 'ticket_number', v_ticket_number,
                         'original_session_id', v_orig_session, 'session_id', v_session_id,
                         'provisional_ref', v_txn.provisional_ref),
      v_business_at);
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.line_no), '[]'::jsonb) INTO v_lines_out
  FROM public.pos_transaction_lines l WHERE l.transaction_id = v_txn.id;
  SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at, p.id), '[]'::jsonb) INTO v_payments_out
  FROM public.pos_payments p WHERE p.transaction_id = v_txn.id;

  RETURN jsonb_build_object(
    'idempotent_replay', false,
    'transaction_id',    v_txn.id,
    'transaction',       to_jsonb(v_txn),
    'lines',             v_lines_out,
    'payments',          v_payments_out
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.pos_finalize_sale(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_finalize_sale(jsonb) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pos_compute_closing (Z1 : trous hors ligne non résolus) — reste identique à
-- 20260923195205_pos_rpc.sql (calcul, numérotation, hash v1)
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

  v_hash := public.pos_sha256(
    'v1|closing|' || v_number
    || '|' || p_period_type
    || '|' || public.pos_canonical_ts(p_period_start)
    || '|' || public.pos_canonical_ts(p_period_end)
    || '|' || v_txn_count
    || '|' || v_ttc
    || '|' || v_grand
    || '|' || v_prev_hash
  );

  INSERT INTO public.pos_closings (
    register_id, closing_number, period_type, period_start, period_end, session_id,
    txn_count, first_ticket_number, last_ticket_number,
    total_ht_cents, total_vat_cents, total_ttc_cents, vat_breakdown, payments_breakdown,
    refunds_ttc_cents, grand_total_perpetual_cents, prev_hash, hash, created_by, offline_gaps
  ) VALUES (
    p_register_id, v_number, p_period_type, p_period_start, p_period_end, p_session_id,
    v_txn_count, v_first, v_last,
    v_ht, v_vat, v_ttc, v_vat_bd, v_pay_bd,
    v_refunds, v_grand, v_prev_hash, v_hash, p_created_by, v_gaps
  )
  RETURNING * INTO v_closing;

  PERFORM public.pos_insert_event(p_register_id, p_session_id, p_created_by, 'closing',
    jsonb_build_object('closing_id', v_closing.id, 'closing_number', v_number, 'period_type', p_period_type,
                       'period_start', public.pos_canonical_ts(p_period_start), 'period_end', public.pos_canonical_ts(p_period_end),
                       'txn_count', v_txn_count, 'total_ttc_cents', v_ttc, 'grand_total_perpetual_cents', v_grand)
    || CASE WHEN v_gaps IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('offline_gaps_unresolved', (v_gaps ->> 'count')::int) END);

  RETURN v_closing;
END;
$$;

COMMENT ON FUNCTION public.pos_compute_closing(uuid, text, timestamptz, timestamptz, uuid, uuid) IS
  'POS NF525 : crée (ou renvoie si déjà présente) une clôture daily (tickets de la session ou de [start,end)), monthly/annual (agrégat des daily), avec grand total perpétuel, numéro continu et chaînage ; Z1 : trous hors ligne non résolus (offline_gaps, JET offline_gap).';
