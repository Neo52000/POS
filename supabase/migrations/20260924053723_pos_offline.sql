-- =============================================================================
-- POS NF525 — lot 4 : mode hors ligne (projet Pos)
-- -----------------------------------------------------------------------------
-- 1. pos_settings.clock_tolerance : tolérances d'horodatage (anti-antidatage).
-- 2. pos_finalize_sale : bornes business_at (en ligne ±online_minutes ; hors
--    ligne [now - offline_hours, now + future_minutes]) -> BUSINESS_AT_OUT_OF_RANGE ;
--    remboursement hors ligne refusé ; vente hors ligne rejouée après clôture de
--    sa session -> rattachée à la session ouverte + événement offline_reattached.
-- 3. pos_client_settings() : paramètres hors ligne lus par la PWA.
-- Idempotent (CREATE OR REPLACE, ON CONFLICT DO NOTHING).
-- =============================================================================

INSERT INTO public.pos_settings (key, value)
VALUES ('clock_tolerance', '{"online_minutes":10,"offline_hours":72,"future_minutes":5}'::jsonb)
ON CONFLICT (key) DO NOTHING;

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
  v_tol            jsonb;
  v_orig_session   uuid;
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
  v_offline := coalesce((p_payload ->> 'offline_queued')::boolean, false);
  IF v_offline AND v_kind = 'refund' THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"offline_queued","reason":"refunds are not allowed offline"}'::jsonb);
  END IF;
  SELECT s.value INTO v_tol FROM public.pos_settings s WHERE s.key = 'clock_tolerance';
  v_tol := coalesce(v_tol, '{}'::jsonb);
  IF v_offline THEN
    IF v_business_at < now() - make_interval(hours => coalesce((v_tol ->> 'offline_hours')::int, 72))
       OR v_business_at > now() + make_interval(mins => coalesce((v_tol ->> 'future_minutes')::int, 5)) THEN
      PERFORM public.pos_error('BUSINESS_AT_OUT_OF_RANGE', jsonb_build_object(
        'business_at', v_business_at, 'server_now', now(), 'offline_queued', true, 'tolerance', v_tol));
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
    IF NOT v_offline THEN
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
  PERFORM public.pos_insert_event(v_register_id, v_session_id, v_cashier_id, v_kind,
    jsonb_build_object('transaction_id', v_txn.id, 'ticket_number', v_ticket_number, 'client_txn_id', v_client_txn_id,
                       'total_ttc_cents', v_txn.total_ttc_cents, 'refund_of_transaction_id', v_refund_of,
                       'offline_queued', v_txn.offline_queued, 'provisional_ref', v_txn.provisional_ref),
    v_business_at);
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
COMMENT ON FUNCTION public.pos_finalize_sale(jsonb) IS
  'POS NF525 : finalise une vente/remboursement (CheckoutPayload SPEC §4 + customer_snapshot/quote_number/cashier_id fournis par l''Edge) : idempotence client_txn_id, bornes business_at (BUSINESS_AT_OUT_OF_RANGE), session ouverte (rattachement des ventes hors ligne rejouées après clôture), recalcul serveur (TOTALS_MISMATCH), contrôle paiements (PAYMENTS_MISMATCH), contrôle remboursement, numéro continu, hash chaîné, lignes, paiements, outbox stock, JET. Retourne {transaction, lines, payments, idempotent_replay}.';

-- -----------------------------------------------------------------------------
-- pos_client_settings() : paramètres utiles à la PWA (hors ligne)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_client_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v jsonb;
BEGIN
  PERFORM public.pos_require_pos();
  SELECT jsonb_build_object(
    'offline_max_txns',  coalesce((SELECT (s.value #>> '{}')::int FROM public.pos_settings s WHERE s.key = 'offline_max_txns'), 50),
    'offline_max_hours', coalesce((SELECT (s.value #>> '{}')::int FROM public.pos_settings s WHERE s.key = 'offline_max_hours'), 24),
    'clock_tolerance',   coalesce((SELECT s.value FROM public.pos_settings s WHERE s.key = 'clock_tolerance'),
                                  '{"online_minutes":10,"offline_hours":72,"future_minutes":5}'::jsonb),
    'server_now',        now()
  ) INTO v;
  RETURN v;
END;
$$;
COMMENT ON FUNCTION public.pos_client_settings() IS 'POS NF525 : paramètres hors ligne pour la PWA (offline_max_txns, offline_max_hours, clock_tolerance, server_now).';
REVOKE ALL ON FUNCTION public.pos_client_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_client_settings() TO authenticated, service_role;
