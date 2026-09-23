-- =============================================================================
-- POS NF525 — 0005 (projet « Pos ») : RPC (API SQL de la caisse)
-- -----------------------------------------------------------------------------
-- Le catalogue, les clients, les tarifs négociés et le stock vivent dans
-- ma-papeterie : voir supabase-mapapeterie/migrations (fonctions bridge
-- pos_search_products, pos_product_by_ean, pos_catalog_page,
-- pos_resolve_cart_prices, pos_customer_lookup, pos_customer_get,
-- pos_customer_open_quotes, pos_apply_stock_movements, pos_adjust_stock_boutique).
-- Ici : sessions, ventes (pos_finalize_sale), clôtures, JET, signature Fiskaly,
-- outbox de stock (pos_stock_sync_*), lecture des tickets.
--
-- Toutes les fonctions d'écriture sont SECURITY DEFINER avec
-- SET search_path = public, extensions, pg_temp et vérifient public.is_pos()
-- (sinon ERRCODE 42501 / MESSAGE 'FORBIDDEN_ROLE'). Les erreurs métier
-- utilisent ERRCODE 'P0001' avec MESSAGE = code (docs/SPEC.md §5) et un DETAIL
-- JSON : SESSION_NOT_OPEN, TOTALS_MISMATCH, PAYMENTS_MISMATCH,
-- REFUND_EXCEEDS_SOLD, REFUND_TARGET_NOT_FOUND, VALIDATION, SESSION_ALREADY_OPEN,
-- REGISTER_NOT_FOUND, TRANSACTION_NOT_FOUND, CLOSING_NOT_FOUND, CHAIN_INCONSISTENT.
-- Le calcul du panier (pos_compute_cart) est le portage exact de
-- packages/core/src/cart.ts (SPEC §2). pos_finalize_sale ne touche jamais aux
-- données ma-papeterie (products) : le stock passe par l'outbox pos_stock_sync.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers d'erreur / d'autorisation
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_error(p_code text, p_detail jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = p_code,
    DETAIL  = coalesce(p_detail, '{}'::jsonb)::text;
END;
$$;
COMMENT ON FUNCTION public.pos_error(text, jsonb) IS 'POS NF525 : lève une erreur métier (ERRCODE P0001, MESSAGE = code SPEC §5, DETAIL = JSON).';

CREATE OR REPLACE FUNCTION public.pos_require_pos()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NOT public.is_pos() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE';
  END IF;
END;
$$;
COMMENT ON FUNCTION public.pos_require_pos() IS 'POS NF525 : lève FORBIDDEN_ROLE (42501) si is_pos() est faux.';

CREATE OR REPLACE FUNCTION public.pos_require_service_role()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF NOT public.pos_is_service_role() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE';
  END IF;
END;
$$;
COMMENT ON FUNCTION public.pos_require_service_role() IS 'POS NF525 : lève FORBIDDEN_ROLE (42501) si l''appelant n''est pas le service role.';

-- -----------------------------------------------------------------------------
-- pos_user_display_name(uuid) : nom du caissier pour le ticket
-- (auth.users du projet Pos : full_name / name des métadonnées, sinon email, sinon id)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_user_display_name(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT coalesce(
    (SELECT nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name', u.raw_user_meta_data ->> 'name', u.email)), '')
     FROM auth.users u WHERE u.id = p_user_id),
    p_user_id::text
  );
$$;
COMMENT ON FUNCTION public.pos_user_display_name(uuid) IS 'POS NF525 : nom du caissier pour le ticket (métadonnées auth.users full_name/name, sinon email, sinon id).';

-- -----------------------------------------------------------------------------
-- Journal des événements (interne + RPC publique)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_insert_event(
  p_register_id uuid,
  p_session_id  uuid,
  p_user_id     uuid,
  p_event_type  text,
  p_payload     jsonb DEFAULT '{}'::jsonb,
  p_client_at   timestamptz DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO public.pos_events (register_id, session_id, user_id, event_type, payload, client_at)
  VALUES (p_register_id, p_session_id, p_user_id, p_event_type, coalesce(p_payload, '{}'::jsonb), p_client_at)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.pos_insert_event(uuid, uuid, uuid, text, jsonb, timestamptz) IS 'POS NF525 : insertion interne d''un événement JET (sans contrôle de rôle ; réservée aux autres RPC).';
REVOKE EXECUTE ON FUNCTION public.pos_insert_event(uuid, uuid, uuid, text, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;

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
  RETURN public.pos_insert_event(
    p_register_id, p_session_id,
    coalesce(auth.uid(), (p_payload ->> 'user_id')::uuid),
    p_event_type, coalesce(p_payload, '{}'::jsonb), p_client_at);
END;
$$;
COMMENT ON FUNCTION public.pos_log_event(text, jsonb, timestamptz, uuid, uuid) IS 'POS NF525 : journalise un événement (login, logout, sale_abandoned, line_deleted, price_override, drawer_opened, reprint, offline_enter/exit, manual_cb_fallback...). Retourne l''id.';

-- -----------------------------------------------------------------------------
-- pos_compute_cart(jsonb) : calcul panier SPEC §2 (portage de cart.ts)
-- Entrée : tableau de CartLineInput. Sortie : {lines, vat_breakdown, totals}.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_compute_cart(p_lines jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_in          jsonb;
  v_lines       jsonb := '[]'::jsonb;
  v_idx         int := 0;
  v_line_no     int;
  v_label       text;
  v_qty         numeric;
  v_unit        bigint;
  v_rate        numeric;
  v_disc        numeric;
  v_rate_bp     bigint;
  v_unit_after  bigint;
  v_line_ttc    bigint;
  v_line_ht     bigint;
  v_line_vat    bigint;
  v_unit_ht     bigint;
  v_breakdown   jsonb;
  v_total_ttc   bigint;
  v_total_vat   bigint;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"lines","reason":"at least one line required"}'::jsonb);
  END IF;

  FOR v_in IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    v_idx     := v_idx + 1;
    v_line_no := coalesce((v_in ->> 'line_no')::int, v_idx);
    v_label   := btrim(coalesce(v_in ->> 'label', ''));
    v_qty     := (v_in ->> 'qty')::numeric;
    v_unit    := (v_in ->> 'unit_price_ttc_cents')::bigint;
    v_rate    := round((v_in ->> 'vat_rate')::numeric, 2);
    v_disc    := round(coalesce((v_in ->> 'discount_percent')::numeric, 0), 2);

    IF v_label = '' THEN
      PERFORM public.pos_error('VALIDATION', jsonb_build_object('line_no', v_line_no, 'field', 'label', 'reason', 'required'));
    END IF;
    IF v_qty IS NULL OR v_qty = 0 OR v_qty <> round(v_qty, 3) THEN
      PERFORM public.pos_error('VALIDATION', jsonb_build_object('line_no', v_line_no, 'field', 'qty', 'reason', 'non-zero, 3 decimals max'));
    END IF;
    IF v_unit IS NULL OR v_unit < 0 THEN
      PERFORM public.pos_error('VALIDATION', jsonb_build_object('line_no', v_line_no, 'field', 'unit_price_ttc_cents', 'reason', 'integer >= 0 required'));
    END IF;
    IF v_rate IS NULL OR v_rate < 0 OR v_rate > 100 THEN
      PERFORM public.pos_error('VALIDATION', jsonb_build_object('line_no', v_line_no, 'field', 'vat_rate', 'reason', '0..100 required'));
    END IF;
    IF v_disc < 0 OR v_disc > 100 THEN
      PERFORM public.pos_error('VALIDATION', jsonb_build_object('line_no', v_line_no, 'field', 'discount_percent', 'reason', '0..100 required'));
    END IF;

    -- SPEC §2 : arrondi half away from zero = round() de Postgres sur numeric
    v_rate_bp    := round(v_rate * 100)::bigint;
    v_unit_after := round(v_unit::numeric * (100 - v_disc) / 100)::bigint;
    v_line_ttc   := round(v_unit_after::numeric * v_qty)::bigint;
    v_line_ht    := round(v_line_ttc::numeric * 10000 / (10000 + v_rate_bp))::bigint;
    v_line_vat   := v_line_ttc - v_line_ht;
    v_unit_ht    := round(v_unit::numeric * 10000 / (10000 + v_rate_bp))::bigint;

    v_lines := v_lines || jsonb_build_object(
      'line_no',                v_line_no,
      'product_id',             nullif(v_in ->> 'product_id', '')::uuid,
      'ean',                    nullif(v_in ->> 'ean', ''),
      'sku',                    nullif(v_in ->> 'sku', ''),
      'label',                  v_label,
      'qty',                    v_qty,
      'unit_price_ttc_cents',   v_unit,
      'unit_price_ht_cents',    v_unit_ht,
      'vat_rate',               v_rate,
      'discount_percent',       v_disc,
      'discount_reason',        nullif(v_in ->> 'discount_reason', ''),
      'line_ttc_cents',         v_line_ttc,
      'line_ht_cents',          v_line_ht,
      'line_vat_cents',         v_line_vat,
      'eco_tax_cents',          coalesce((v_in ->> 'eco_tax_cents')::bigint, 0),
      'pricing_rule_id',        nullif(v_in ->> 'pricing_rule_id', '')::uuid,
      'price_tier_title',       nullif(v_in ->> 'price_tier_title', ''),
      'public_price_ttc_cents', (v_in ->> 'public_price_ttc_cents')::bigint
    );
  END LOOP;

  -- line_no uniques
  IF (SELECT count(*) <> count(DISTINCT (l ->> 'line_no')::int) FROM jsonb_array_elements(v_lines) l) THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"lines","reason":"duplicate line_no"}'::jsonb);
  END IF;

  -- Ventilation TVA triée numériquement par taux
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'rate',          public.pos_canonical_rate(g.rate),
           'base_ht_cents', g.ht,
           'vat_cents',     g.vat,
           'ttc_cents',     g.ttc
         ) ORDER BY g.rate), '[]'::jsonb)
  INTO v_breakdown
  FROM (
    SELECT (l ->> 'vat_rate')::numeric              AS rate,
           sum((l ->> 'line_ht_cents')::bigint)::bigint  AS ht,
           sum((l ->> 'line_vat_cents')::bigint)::bigint AS vat,
           sum((l ->> 'line_ttc_cents')::bigint)::bigint AS ttc
    FROM jsonb_array_elements(v_lines) l
    GROUP BY 1
  ) g;

  SELECT sum((l ->> 'line_ttc_cents')::bigint)::bigint, sum((l ->> 'line_vat_cents')::bigint)::bigint
  INTO v_total_ttc, v_total_vat
  FROM jsonb_array_elements(v_lines) l;

  RETURN jsonb_build_object(
    'lines',         v_lines,
    'vat_breakdown', v_breakdown,
    'totals',        jsonb_build_object(
      'total_ht_cents',  v_total_ttc - v_total_vat,
      'total_vat_cents', v_total_vat,
      'total_ttc_cents', v_total_ttc
    )
  );
END;
$$;
COMMENT ON FUNCTION public.pos_compute_cart(jsonb) IS 'POS NF525 : calcul panier SPEC §2 (arrondi half away from zero par ligne, ventilation TVA, totaux) ; portage exact de @pos/core cart.ts. Pure.';

-- -----------------------------------------------------------------------------
-- Sessions de caisse
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_open_session(
  p_register_id         uuid,
  p_opening_float_cents bigint,
  p_opened_by           uuid DEFAULT NULL
)
RETURNS public.pos_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_number   bigint;
  v_session  public.pos_sessions;
  v_user     uuid := coalesce(auth.uid(), p_opened_by);
BEGIN
  PERFORM public.pos_require_pos();
  IF coalesce(p_opening_float_cents, 0) < 0 THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_opening_float_cents","reason":">= 0 required"}'::jsonb);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_registers r WHERE r.id = p_register_id AND r.is_active) THEN
    PERFORM public.pos_error('REGISTER_NOT_FOUND', jsonb_build_object('register_id', p_register_id));
  END IF;

  -- Verrou de ligne sur le compteur : sérialise les ouvertures concurrentes.
  -- Si une exception suit, l'incrément est annulé avec la transaction (pas de trou).
  UPDATE public.pos_counters
  SET value = value + 1
  WHERE register_id = p_register_id AND kind = 'session'
  RETURNING value INTO v_number;
  IF v_number IS NULL THEN
    PERFORM public.pos_error('REGISTER_NOT_FOUND', jsonb_build_object('register_id', p_register_id, 'reason', 'missing counter'));
  END IF;

  IF EXISTS (SELECT 1 FROM public.pos_sessions s WHERE s.register_id = p_register_id AND s.status = 'open') THEN
    PERFORM public.pos_error('SESSION_ALREADY_OPEN', jsonb_build_object('register_id', p_register_id));
  END IF;

  INSERT INTO public.pos_sessions (register_id, session_number, opened_by, opening_float_cents, status)
  VALUES (p_register_id, v_number, v_user, coalesce(p_opening_float_cents, 0), 'open')
  RETURNING * INTO v_session;

  PERFORM public.pos_insert_event(p_register_id, v_session.id, v_user, 'session_open',
    jsonb_build_object('session_id', v_session.id, 'session_number', v_number, 'opening_float_cents', v_session.opening_float_cents));

  RETURN v_session;
END;
$$;
COMMENT ON FUNCTION public.pos_open_session(uuid, bigint, uuid) IS 'POS NF525 : ouvre une session de caisse (numéro continu, une seule ouverte par caisse -> SESSION_ALREADY_OPEN). Journalise session_open.';

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
    refunds_ttc_cents, grand_total_perpetual_cents, prev_hash, hash, created_by
  ) VALUES (
    p_register_id, v_number, p_period_type, p_period_start, p_period_end, p_session_id,
    v_txn_count, v_first, v_last,
    v_ht, v_vat, v_ttc, v_vat_bd, v_pay_bd,
    v_refunds, v_grand, v_prev_hash, v_hash, p_created_by
  )
  RETURNING * INTO v_closing;

  PERFORM public.pos_insert_event(p_register_id, p_session_id, p_created_by, 'closing',
    jsonb_build_object('closing_id', v_closing.id, 'closing_number', v_number, 'period_type', p_period_type,
                       'period_start', public.pos_canonical_ts(p_period_start), 'period_end', public.pos_canonical_ts(p_period_end),
                       'txn_count', v_txn_count, 'total_ttc_cents', v_ttc, 'grand_total_perpetual_cents', v_grand));

  RETURN v_closing;
END;
$$;
COMMENT ON FUNCTION public.pos_compute_closing(uuid, text, timestamptz, timestamptz, uuid, uuid) IS
  'POS NF525 : crée (ou renvoie si déjà présente) une clôture daily (tickets de la session ou de [start,end)), monthly/annual (agrégat des daily), avec grand total perpétuel, numéro continu et chaînage.';

CREATE OR REPLACE FUNCTION public.pos_close_session(
  p_session_id         uuid,
  p_counted_cash_cents bigint,
  p_notes              text DEFAULT NULL,
  p_closed_by          uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session   public.pos_sessions;
  v_closing   public.pos_closings;
  v_user      uuid := coalesce(auth.uid(), p_closed_by);
  v_now       timestamptz := clock_timestamp();   -- heure réelle (> opened_at même dans une seule transaction)
  v_cash_in   bigint := 0;   -- Σ paiements espèces (négatifs sur remboursements)
  v_change    bigint := 0;   -- Σ rendu monnaie
  v_expected  bigint;
  v_variance  bigint;
BEGIN
  PERFORM public.pos_require_pos();

  SELECT * INTO v_session FROM public.pos_sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.status <> 'open' THEN
    PERFORM public.pos_error('SESSION_NOT_OPEN', jsonb_build_object('session_id', p_session_id));
  END IF;
  IF p_counted_cash_cents IS NULL OR p_counted_cash_cents < 0 THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_counted_cash_cents","reason":"integer >= 0 required"}'::jsonb);
  END IF;

  -- Espèces attendues = fond de caisse + Σ espèces encaissées − Σ rendu monnaie
  SELECT coalesce(sum(p.amount_cents), 0)::bigint INTO v_cash_in
  FROM public.pos_payments p
  JOIN public.pos_transactions t ON t.id = p.transaction_id
  WHERE t.session_id = p_session_id AND p.method = 'cash';

  SELECT coalesce(sum(t.change_cents), 0)::bigint INTO v_change
  FROM public.pos_transactions t
  WHERE t.session_id = p_session_id;

  v_expected := v_session.opening_float_cents + v_cash_in - v_change;
  v_variance := p_counted_cash_cents - v_expected;

  -- Clôture Z (daily) de la session
  v_closing := public.pos_compute_closing(v_session.register_id, 'daily', v_session.opened_at, v_now, p_session_id, v_user);

  UPDATE public.pos_sessions
  SET status              = 'closed',
      closed_by           = v_user,
      closed_at           = v_now,
      counted_cash_cents  = p_counted_cash_cents,
      expected_cash_cents = v_expected,
      variance_cents      = v_variance,
      closing_id          = v_closing.id,
      notes               = p_notes
  WHERE id = p_session_id
  RETURNING * INTO v_session;

  PERFORM public.pos_insert_event(v_session.register_id, p_session_id, v_user, 'session_close',
    jsonb_build_object('session_id', p_session_id, 'session_number', v_session.session_number,
                       'counted_cash_cents', p_counted_cash_cents, 'expected_cash_cents', v_expected,
                       'variance_cents', v_variance, 'closing_id', v_closing.id, 'closing_number', v_closing.closing_number));

  RETURN jsonb_build_object('session', to_jsonb(v_session), 'closing', to_jsonb(v_closing));
END;
$$;
COMMENT ON FUNCTION public.pos_close_session(uuid, bigint, text, uuid) IS 'POS NF525 : ferme une session (espèces attendues, écart), crée la clôture Z daily et journalise session_close. Retourne {session, closing}.';

-- -----------------------------------------------------------------------------
-- pos_finalize_sale(jsonb) : cœur de la vente (CheckoutPayload SPEC §4)
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

  -- ---------------------------------------------------------------- session
  SELECT * INTO v_session FROM public.pos_sessions s WHERE s.id = v_session_id AND s.register_id = v_register_id;
  IF NOT FOUND OR v_session.status <> 'open' THEN
    PERFORM public.pos_error('SESSION_NOT_OPEN', jsonb_build_object('session_id', v_session_id, 'register_id', v_register_id));
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
    v_tendered, v_change, coalesce((p_payload ->> 'offline_queued')::boolean, false), nullif(p_payload ->> 'provisional_ref', ''),
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
  PERFORM public.pos_insert_event(v_register_id, v_session_id, v_cashier_id, v_kind,
    jsonb_build_object('transaction_id', v_txn.id, 'ticket_number', v_ticket_number, 'client_txn_id', v_client_txn_id,
                       'total_ttc_cents', v_txn.total_ttc_cents, 'refund_of_transaction_id', v_refund_of,
                       'offline_queued', v_txn.offline_queued, 'provisional_ref', v_txn.provisional_ref),
    v_business_at);

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
COMMENT ON FUNCTION public.pos_finalize_sale(jsonb) IS
  'POS NF525 : finalise une vente/remboursement (CheckoutPayload SPEC §4 + customer_snapshot/quote_number/cashier_id fournis par l''Edge) : idempotence client_txn_id, session ouverte, recalcul serveur (TOTALS_MISMATCH), contrôle paiements (PAYMENTS_MISMATCH), contrôle remboursement, numéro continu, hash chaîné, lignes, paiements, outbox stock, JET. Retourne {transaction, lines, payments, idempotent_replay}.';

-- -----------------------------------------------------------------------------
-- Outbox stock (service role : Edge Function pos-stock-sync)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_stock_sync_pending(p_limit int DEFAULT 100)
RETURNS SETOF public.pos_stock_sync
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_require_service_role();
  RETURN QUERY
    SELECT s.*
    FROM public.pos_stock_sync s
    WHERE s.status = 'pending'
    ORDER BY s.id
    LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000);
END;
$$;
COMMENT ON FUNCTION public.pos_stock_sync_pending(int) IS 'POS NF525 (service role) : mouvements de stock en attente de synchronisation vers ma-papeterie, par id croissant.';

CREATE OR REPLACE FUNCTION public.pos_stock_sync_mark(
  p_id                 bigint,
  p_status             text,
  p_error              text,
  p_remote_stock_after int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_require_service_role();
  IF p_status IS NULL OR p_status NOT IN ('pending', 'done', 'failed') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_status","reason":"pending|done|failed"}'::jsonb);
  END IF;

  UPDATE public.pos_stock_sync s
  SET status             = p_status,
      attempts           = s.attempts + 1,
      last_error         = CASE WHEN p_status = 'done' THEN NULL ELSE coalesce(p_error, s.last_error) END,
      remote_stock_after = coalesce(p_remote_stock_after, s.remote_stock_after),
      done_at            = CASE WHEN p_status = 'done' THEN now() ELSE s.done_at END
  WHERE s.id = p_id;
  IF NOT FOUND THEN
    PERFORM public.pos_error('STOCK_SYNC_NOT_FOUND', jsonb_build_object('id', p_id));
  END IF;
END;
$$;
COMMENT ON FUNCTION public.pos_stock_sync_mark(bigint, text, text, int) IS 'POS NF525 (service role) : résultat d''une tentative de synchronisation d''un mouvement de stock (attempts++, done_at si done, remote_stock_after).';

-- -----------------------------------------------------------------------------
-- Signature Fiskaly (service role uniquement)
-- -----------------------------------------------------------------------------
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
COMMENT ON FUNCTION public.pos_mark_signature(uuid, text, text, text, jsonb, text) IS 'POS NF525 (service role) : enregistre le résultat d''une tentative de signature Fiskaly ; incrémente signature_attempts, fiskaly_signed_at = now() si signed ; journalise signature_failed sinon.';

CREATE OR REPLACE FUNCTION public.pos_pending_signatures(p_limit int DEFAULT 50)
RETURNS SETOF public.pos_transactions
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_require_service_role();
  RETURN QUERY
    SELECT t.*
    FROM public.pos_transactions t
    WHERE t.signature_status = 'pending_signature' AND t.signature_attempts < 50
    ORDER BY t.register_id, t.ticket_number ASC
    LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
END;
$$;
COMMENT ON FUNCTION public.pos_pending_signatures(int) IS 'POS NF525 (service role) : tickets en attente de signature (< 50 tentatives), par caisse puis ticket_number croissant.';

CREATE OR REPLACE FUNCTION public.pos_mark_closing_synced(p_closing_id uuid, p_fiskaly_closing_id text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_closing public.pos_closings;
BEGIN
  PERFORM public.pos_require_service_role();
  SELECT * INTO v_closing FROM public.pos_closings c WHERE c.id = p_closing_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.pos_error('CLOSING_NOT_FOUND', jsonb_build_object('closing_id', p_closing_id));
  END IF;
  IF v_closing.fiskaly_closing_id IS NOT NULL THEN
    RETURN;  -- déjà rapprochée (immutable)
  END IF;
  UPDATE public.pos_closings c
  SET fiskaly_closing_id = p_fiskaly_closing_id,
      fiskaly_payload    = p_payload
  WHERE c.id = p_closing_id;
END;
$$;
COMMENT ON FUNCTION public.pos_mark_closing_synced(uuid, text, jsonb) IS 'POS NF525 (service role) : rapprochement d''une clôture avec Fiskaly (fiskaly_closing_id, fiskaly_payload), une seule fois.';

-- -----------------------------------------------------------------------------
-- Lecture
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_transaction_full(p_transaction_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_txn       public.pos_transactions;
  v_register  public.pos_registers;
  v_refund_of jsonb;
BEGIN
  PERFORM public.pos_require_pos();

  SELECT * INTO v_txn FROM public.pos_transactions t WHERE t.id = p_transaction_id;
  IF NOT FOUND THEN
    PERFORM public.pos_error('TRANSACTION_NOT_FOUND', jsonb_build_object('transaction_id', p_transaction_id));
  END IF;
  SELECT * INTO v_register FROM public.pos_registers r WHERE r.id = v_txn.register_id;

  IF v_txn.refund_of_transaction_id IS NOT NULL THEN
    SELECT jsonb_build_object('transaction_id', t.id, 'ticket_number', t.ticket_number, 'business_at', t.business_at)
    INTO v_refund_of
    FROM public.pos_transactions t WHERE t.id = v_txn.refund_of_transaction_id;
  END IF;

  RETURN jsonb_build_object(
    'transaction', to_jsonb(v_txn),
    'lines', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.line_no), '[]'::jsonb)
              FROM public.pos_transaction_lines l WHERE l.transaction_id = v_txn.id),
    'payments', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at, p.id), '[]'::jsonb)
                 FROM public.pos_payments p WHERE p.transaction_id = v_txn.id),
    'register', jsonb_build_object(
      'id', v_register.id, 'code', v_register.code, 'label', v_register.label,
      'fiskaly_system_id', v_register.fiskaly_system_id, 'fiskaly_env', v_register.fiskaly_env),
    'settings', jsonb_build_object(
      'legal',         (SELECT s.value FROM public.pos_settings s WHERE s.key = 'legal'),
      'ticket_footer', (SELECT s.value FROM public.pos_settings s WHERE s.key = 'ticket_footer'),
      'software',      (SELECT s.value FROM public.pos_settings s WHERE s.key = 'software')),
    'cashier_name', public.pos_user_display_name(v_txn.cashier_id),
    'refund_of',    v_refund_of,
    'quote_number', v_txn.quote_number
  );
END;
$$;
COMMENT ON FUNCTION public.pos_transaction_full(uuid) IS 'POS NF525 : ticket complet pour impression/réimpression : {transaction, lines, payments, register, settings{legal,ticket_footer,software}, cashier_name, refund_of, quote_number}.';

CREATE OR REPLACE FUNCTION public.pos_today_transactions(
  p_register_id uuid,
  p_date        date DEFAULT (now() AT TIME ZONE 'Europe/Paris')::date
)
RETURNS SETOF public.pos_transactions
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_require_pos();
  RETURN QUERY
    SELECT t.*
    FROM public.pos_transactions t
    WHERE t.register_id = p_register_id AND t.business_date = p_date
    ORDER BY t.ticket_number DESC;
END;
$$;
COMMENT ON FUNCTION public.pos_today_transactions(uuid, date) IS 'POS NF525 : tickets d''une caisse pour une date métier (Europe/Paris), du plus récent au plus ancien.';

-- -----------------------------------------------------------------------------
-- Droits d'exécution : PUBLIC et anon n'exécutent rien ; authenticated et
-- service_role exécutent les RPC (le contrôle fin — is_pos() / service role —
-- est fait dans chaque fonction).
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION
  public.pos_error(text, jsonb), public.pos_require_pos(), public.pos_require_service_role(),
  public.pos_user_display_name(uuid), public.pos_log_event(text, jsonb, timestamptz, uuid, uuid),
  public.pos_compute_cart(jsonb),
  public.pos_open_session(uuid, bigint, uuid), public.pos_compute_closing(uuid, text, timestamptz, timestamptz, uuid, uuid),
  public.pos_close_session(uuid, bigint, text, uuid), public.pos_finalize_sale(jsonb),
  public.pos_stock_sync_pending(int), public.pos_stock_sync_mark(bigint, text, text, int),
  public.pos_mark_signature(uuid, text, text, text, jsonb, text), public.pos_pending_signatures(int),
  public.pos_mark_closing_synced(uuid, text, jsonb), public.pos_transaction_full(uuid), public.pos_today_transactions(uuid, date)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.pos_error(text, jsonb), public.pos_require_pos(), public.pos_require_service_role(),
  public.pos_user_display_name(uuid), public.pos_log_event(text, jsonb, timestamptz, uuid, uuid),
  public.pos_compute_cart(jsonb),
  public.pos_open_session(uuid, bigint, uuid), public.pos_compute_closing(uuid, text, timestamptz, timestamptz, uuid, uuid),
  public.pos_close_session(uuid, bigint, text, uuid), public.pos_finalize_sale(jsonb),
  public.pos_stock_sync_pending(int), public.pos_stock_sync_mark(bigint, text, text, int),
  public.pos_mark_signature(uuid, text, text, text, jsonb, text), public.pos_pending_signatures(int),
  public.pos_mark_closing_synced(uuid, text, jsonb), public.pos_transaction_full(uuid), public.pos_today_transactions(uuid, date)
TO authenticated, service_role;
