-- =============================================================================
-- POS NF525 — lecture X et clôtures Z2 / Z3 à la demande (projet Pos, v0.3.0)
-- -----------------------------------------------------------------------------
-- * pos_x_report(session) : lecture intermédiaire X d'une session ouverte, SANS
--   remise à zéro ni écriture fiscale. Mêmes agrégats que la clôture journalière
--   (pos_compute_closing daily) + espèces attendues (≡ pos_close_session) et
--   grand total perpétuel projeté. Chaque lecture est tracée au JET
--   (événement `x_report`) ; son id sert de numéro de lecture.
-- * pos_close_period(register, monthly|annual, ref, created_by) : clôture Z2 / Z3 de la
--   période contenant `ref`, avec garde-fous AVANT pos_compute_closing (dont le
--   calcul, le hash et la numérotation sont inchangés) :
--     - PERIOD_NOT_ENDED       : la période n'est pas terminée (une clôture est
--                                définitive : un mois en cours serait figé) ;
--     - SESSION_OPEN_IN_PERIOD : une session ouverte avant la fin de période
--                                n'a pas encore son Z1 (il manquerait au Z2) ;
--     - NOTHING_TO_CLOSE       : aucune clôture journalière avant la fin de
--                                période (période antérieure à la mise en
--                                service de la caisse).
--   Idempotent : une clôture existante est renvoyée (`already_exists: true`).
-- * pg_cron : Z2 tenté chaque jour à 03:10 UTC et Z3 chaque jour de janvier à
--   03:20 UTC (au lieu du seul 1er) : une clôture bloquée par une session
--   restée ouverte est rattrapée dès le lendemain, sans intervention.
-- Idempotent (CREATE OR REPLACE, jobs dé-planifiés avant replanification).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pos_x_report(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session  public.pos_sessions;
  v_code     text;
  v_now      timestamptz := clock_timestamp();
  v_figures  jsonb;
  v_vat_bd   jsonb;
  v_pay_bd   jsonb;
  v_cash_in  bigint;
  v_change   bigint;
  v_ttc      bigint;
  v_grand    bigint;
  v_event_id bigint;
BEGIN
  PERFORM public.pos_require_pos();

  SELECT * INTO v_session FROM public.pos_sessions s WHERE s.id = p_session_id;
  IF NOT FOUND OR v_session.status <> 'open' THEN
    PERFORM public.pos_error('SESSION_NOT_OPEN', jsonb_build_object('session_id', p_session_id));
  END IF;
  SELECT r.code INTO v_code FROM public.pos_registers r WHERE r.id = v_session.register_id;

  SELECT jsonb_build_object(
           'txn_count',           count(*)::int,
           'sales_count',         (count(*) FILTER (WHERE t.kind = 'sale'))::int,
           'refunds_count',       (count(*) FILTER (WHERE t.kind = 'refund'))::int,
           'first_ticket_number', min(t.ticket_number),
           'last_ticket_number',  max(t.ticket_number),
           'total_ht_cents',      coalesce(sum(t.total_ht_cents), 0)::bigint,
           'total_vat_cents',     coalesce(sum(t.total_vat_cents), 0)::bigint,
           'total_ttc_cents',     coalesce(sum(t.total_ttc_cents), 0)::bigint,
           'refunds_ttc_cents',   coalesce(sum(t.total_ttc_cents) FILTER (WHERE t.kind = 'refund'), 0)::bigint,
           'change_cents',        coalesce(sum(t.change_cents), 0)::bigint),
         coalesce(sum(t.total_ttc_cents), 0)::bigint,
         coalesce(sum(t.change_cents), 0)::bigint
  INTO v_figures, v_ttc, v_change
  FROM public.pos_transactions t
  WHERE t.session_id = p_session_id;

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
    WHERE t.session_id = p_session_id
    GROUP BY 1
  ) g;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'method', s.method, 'amount_cents', s.amount, 'count', s.cnt
         ) ORDER BY s.method), '[]'::jsonb)
  INTO v_pay_bd
  FROM (
    SELECT p.method, sum(p.amount_cents)::bigint AS amount, count(*)::int AS cnt
    FROM public.pos_payments p
    JOIN public.pos_transactions t ON t.id = p.transaction_id
    WHERE t.session_id = p_session_id
    GROUP BY p.method
  ) s;

  -- Espèces attendues : même formule que pos_close_session.
  SELECT coalesce(sum(p.amount_cents), 0)::bigint INTO v_cash_in
  FROM public.pos_payments p
  JOIN public.pos_transactions t ON t.id = p.transaction_id
  WHERE t.session_id = p_session_id AND p.method = 'cash';

  -- Grand total perpétuel projeté : dernier GTP journalier + TTC net de la session.
  SELECT c.grand_total_perpetual_cents INTO v_grand
  FROM public.pos_closings c
  WHERE c.register_id = v_session.register_id AND c.period_type = 'daily'
  ORDER BY c.closing_number DESC
  LIMIT 1;
  v_grand := coalesce(v_grand, 0) + v_ttc;

  v_figures := v_figures || jsonb_build_object(
    'vat_breakdown', v_vat_bd,
    'payments', v_pay_bd,
    'cash', jsonb_build_object(
      'opening_float_cents', v_session.opening_float_cents,
      'expected_cash_cents', v_session.opening_float_cents + v_cash_in - v_change),
    'grand_total_perpetual_cents', v_grand);

  v_event_id := public.pos_insert_event(v_session.register_id, p_session_id, auth.uid(), 'x_report',
    jsonb_build_object('session_id', p_session_id, 'session_number', v_session.session_number,
                       'txn_count', v_figures -> 'txn_count', 'total_ttc_cents', v_ttc));

  RETURN jsonb_build_object(
    'x_number', v_event_id,
    'generated_at', public.pos_canonical_ts(v_now),
    'register_code', v_code,
    'session', to_jsonb(v_session),
    'figures', v_figures);
END;
$$;
COMMENT ON FUNCTION public.pos_x_report(uuid) IS
  'POS NF525 : lecture X (intermédiaire, sans remise à zéro) d''une session ouverte ; agrégats identiques au Z1, espèces attendues, GTP projeté ; tracée au JET (x_report).';
REVOKE ALL ON FUNCTION public.pos_x_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_x_report(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_close_period(
  p_register_id uuid,
  p_period_type text,
  p_ref         timestamptz DEFAULT NULL,
  p_created_by  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_start    timestamptz;
  v_end      timestamptz;
  v_existing public.pos_closings;
  v_closing  public.pos_closings;
BEGIN
  PERFORM public.pos_require_pos();
  IF p_period_type NOT IN ('monthly', 'annual') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_period_type","reason":"monthly|annual"}'::jsonb);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pos_registers r WHERE r.id = p_register_id) THEN
    PERFORM public.pos_error('REGISTER_NOT_FOUND', jsonb_build_object('register_id', p_register_id));
  END IF;

  SELECT b.period_start, b.period_end INTO v_start, v_end
  FROM public.pos_period_bounds(p_period_type, coalesce(p_ref, now())) b;

  SELECT * INTO v_existing
  FROM public.pos_closings c
  WHERE c.register_id = p_register_id AND c.period_type = p_period_type AND c.period_start = v_start;
  IF FOUND THEN
    RETURN jsonb_build_object('closing', to_jsonb(v_existing), 'already_exists', true);
  END IF;

  IF v_end > now() THEN
    PERFORM public.pos_error('PERIOD_NOT_ENDED', jsonb_build_object(
      'period_type', p_period_type, 'period_start', public.pos_canonical_ts(v_start),
      'period_end', public.pos_canonical_ts(v_end)));
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pos_sessions s
    WHERE s.register_id = p_register_id AND s.status = 'open' AND s.opened_at < v_end
  ) THEN
    PERFORM public.pos_error('SESSION_OPEN_IN_PERIOD', jsonb_build_object(
      'period_type', p_period_type, 'period_end', public.pos_canonical_ts(v_end)));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pos_closings c
    WHERE c.register_id = p_register_id AND c.period_type = 'daily' AND c.period_start < v_end
  ) THEN
    PERFORM public.pos_error('NOTHING_TO_CLOSE', jsonb_build_object(
      'period_type', p_period_type, 'period_end', public.pos_canonical_ts(v_end)));
  END IF;

  -- Edge Function (service role) : l'auteur est transmis explicitement, comme pos_compute_closing.
  v_closing := public.pos_compute_closing(p_register_id, p_period_type, v_start, v_end, NULL,
                                          coalesce(auth.uid(), p_created_by));
  RETURN jsonb_build_object('closing', to_jsonb(v_closing), 'already_exists', false);
END;
$$;
COMMENT ON FUNCTION public.pos_close_period(uuid, text, timestamptz, uuid) IS
  'POS NF525 : clôture Z2 (monthly) / Z3 (annual) de la période contenant p_ref (défaut maintenant) ; refuse une période non terminée, une session encore ouverte dans la période ou une période sans activité ; idempotent.';
REVOKE ALL ON FUNCTION public.pos_close_period(uuid, text, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_close_period(uuid, text, timestamptz, uuid) TO authenticated, service_role;

-- Crons Z2 / Z3 : tentative quotidienne (rattrapage automatique), idempotente.
DO $$
DECLARE
  v_job  record;
  v_jobs CONSTANT jsonb := '[
    {"name": "pos-closing-monthly", "schedule": "10 3 * * *", "fn": "pos-closing", "body": {"source": "pg_cron", "period_type": "monthly"}},
    {"name": "pos-closing-annual",  "schedule": "20 3 * 1 *", "fn": "pos-closing", "body": {"source": "pg_cron", "period_type": "annual"}}
  ]'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_cron / pg_net absents : jobs POS non replanifiés';
    RETURN;
  END IF;
  FOR v_job IN SELECT * FROM jsonb_to_recordset(v_jobs) AS j(name text, schedule text, fn text, body jsonb) LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job.name) THEN
      PERFORM cron.unschedule(v_job.name);
    END IF;
    PERFORM cron.schedule(v_job.name, v_job.schedule,
      format('SELECT public.pos_cron_call(%L, %L::jsonb)', v_job.fn, v_job.body::text));
  END LOOP;
END $$;
