-- =============================================================================
-- POS NF525 — 0.5.0 : mouvements d'espèces hors vente (projet Pos)
-- -----------------------------------------------------------------------------
-- Remises en banque, retraits / prélèvements et apports d'espèces en cours de
-- session. Sans eux, une remise en banque apparaissait au Z comme un manque de
-- caisse inexpliqué.
--
-- * pos_cash_movements : registre IMMUABLE (ni UPDATE, ni DELETE, ni TRUNCATE) ;
--   une erreur se corrige par un mouvement inverse, jamais par modification.
--   Montant toujours > 0 ; le sens découle du type :
--     bank_deposit (remise en banque) et withdrawal (retrait) = sortie ;
--     cash_in (apport) = entrée.
-- * pos_record_cash_movement(...) : seule voie d'écriture (SECURITY DEFINER),
--   session ouverte (périmée acceptée : un mouvement n'est pas une vente, et le
--   Z de la veille doit en tenir compte), idempotente par client_movement_id,
--   tracée au JET (événement `cash_movement`, chaîné comme tout événement).
-- * Espèces attendues = fond + Σ espèces encaissées − Σ rendu monnaie
--                       + Σ apports − Σ sorties,
--   identiques en lecture X (pos_x_report, détail `cash.movements`) et à la
--   clôture (pos_close_session, totaux dans l'événement `session_close`).
--
-- Hors chiffre d'affaires : ni ticket, ni TVA, ni grand total perpétuel ; le
-- calcul des clôtures (pos_compute_closing), leur hash v2, le hash ticket v1,
-- la numérotation et le format d'archive sont inchangés. Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_cash_movements (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id        uuid        NOT NULL REFERENCES public.pos_registers (id),
  session_id         uuid        NOT NULL REFERENCES public.pos_sessions (id),
  kind               text        NOT NULL CHECK (kind IN ('bank_deposit', 'withdrawal', 'cash_in')),
  amount_cents       bigint      NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  reason             text        NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 200),
  reference          text        CHECK (reference IS NULL OR length(reference) <= 60),
  client_movement_id uuid        NOT NULL UNIQUE,
  event_id           bigint      REFERENCES public.pos_events (id),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE public.pos_cash_movements IS
  'POS NF525 (0.5.0) : mouvements d''espèces hors vente (remise en banque, retrait, apport) d''une session ; immuable, tracé au JET (cash_movement).';
CREATE INDEX IF NOT EXISTS pos_cash_movements_session_idx ON public.pos_cash_movements (session_id, created_at);

-- Immutabilité : UPDATE / DELETE / TRUNCATE interdits, aucune écriture directe.
DROP TRIGGER IF EXISTS trg_pos_cash_movements_immutable ON public.pos_cash_movements;
CREATE TRIGGER trg_pos_cash_movements_immutable
  BEFORE UPDATE OR DELETE ON public.pos_cash_movements
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();
DROP TRIGGER IF EXISTS trg_pos_cash_movements_no_truncate ON public.pos_cash_movements;
CREATE TRIGGER trg_pos_cash_movements_no_truncate
  BEFORE TRUNCATE ON public.pos_cash_movements
  FOR EACH STATEMENT EXECUTE FUNCTION public.pos_forbid_truncate();
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.pos_cash_movements
  FROM anon, authenticated, service_role;

ALTER TABLE public.pos_cash_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pos_cash_movements_select ON public.pos_cash_movements;
CREATE POLICY pos_cash_movements_select ON public.pos_cash_movements
  FOR SELECT TO authenticated USING (public.is_pos());
GRANT SELECT ON public.pos_cash_movements TO authenticated;

-- -----------------------------------------------------------------------------
-- pos_record_cash_movement : enregistrement (seule voie d'écriture).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_record_cash_movement(
  p_session_id         uuid,
  p_kind               text,
  p_amount_cents       bigint,
  p_reason             text,
  p_reference          text DEFAULT NULL,
  p_client_movement_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_session  public.pos_sessions;
  v_existing public.pos_cash_movements;
  v_movement public.pos_cash_movements;
  v_user     uuid := auth.uid();
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_ref      text := nullif(btrim(coalesce(p_reference, '')), '');
  v_event_id bigint;
BEGIN
  PERFORM public.pos_require_pos();

  IF p_client_movement_id IS NULL THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_client_movement_id","reason":"required"}'::jsonb);
  END IF;
  -- Idempotence : un rejeu (réseau coupé après l'écriture) renvoie le mouvement existant.
  SELECT * INTO v_existing FROM public.pos_cash_movements m WHERE m.client_movement_id = p_client_movement_id;
  IF FOUND THEN
    RETURN jsonb_build_object('movement', to_jsonb(v_existing), 'idempotent_replay', true);
  END IF;

  IF p_kind IS NULL OR p_kind NOT IN ('bank_deposit', 'withdrawal', 'cash_in') THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_kind","reason":"bank_deposit | withdrawal | cash_in"}'::jsonb);
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 OR p_amount_cents > 100000000 THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_amount_cents","reason":"integer 1..100000000 required"}'::jsonb);
  END IF;
  IF length(v_reason) < 1 OR length(v_reason) > 200 THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_reason","reason":"1..200 characters required"}'::jsonb);
  END IF;
  IF v_ref IS NOT NULL AND length(v_ref) > 60 THEN
    PERFORM public.pos_error('VALIDATION', '{"field":"p_reference","reason":"<= 60 characters"}'::jsonb);
  END IF;

  SELECT * INTO v_session FROM public.pos_sessions s WHERE s.id = p_session_id FOR UPDATE;
  IF NOT FOUND OR v_session.status <> 'open' THEN
    PERFORM public.pos_error('SESSION_NOT_OPEN', jsonb_build_object('session_id', p_session_id));
  END IF;

  v_event_id := public.pos_insert_event(v_session.register_id, p_session_id, v_user, 'cash_movement',
    jsonb_build_object('session_id', p_session_id, 'session_number', v_session.session_number,
                       'client_movement_id', p_client_movement_id, 'kind', p_kind,
                       'amount_cents', p_amount_cents, 'reason', v_reason, 'reference', v_ref));

  INSERT INTO public.pos_cash_movements
    (register_id, session_id, kind, amount_cents, reason, reference, client_movement_id, event_id, created_by)
  VALUES
    (v_session.register_id, p_session_id, p_kind, p_amount_cents, v_reason, v_ref, p_client_movement_id, v_event_id, v_user)
  RETURNING * INTO v_movement;

  RETURN jsonb_build_object('movement', to_jsonb(v_movement), 'idempotent_replay', false);
END;
$$;
COMMENT ON FUNCTION public.pos_record_cash_movement(uuid, text, bigint, text, text, uuid) IS
  'POS NF525 (0.5.0) : enregistre un mouvement d''espèces hors vente (bank_deposit / withdrawal = sortie, cash_in = entrée) sur une session ouverte ; idempotent (client_movement_id) ; JET cash_movement. Retourne {movement, idempotent_replay}.';
REVOKE ALL ON FUNCTION public.pos_record_cash_movement(uuid, text, bigint, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_record_cash_movement(uuid, text, bigint, text, text, uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pos_close_session : espèces attendues incluant les mouvements (corps 0.1.0,
-- seul le calcul de v_expected et la charge utile du JET changent).
-- -----------------------------------------------------------------------------
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
  v_mv_in     bigint := 0;   -- Σ apports d'espèces (0.5.0)
  v_mv_out    bigint := 0;   -- Σ remises en banque et retraits (0.5.0)
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

  -- Espèces attendues = fond + Σ espèces encaissées − Σ rendu monnaie + Σ apports − Σ sorties
  SELECT coalesce(sum(p.amount_cents), 0)::bigint INTO v_cash_in
  FROM public.pos_payments p
  JOIN public.pos_transactions t ON t.id = p.transaction_id
  WHERE t.session_id = p_session_id AND p.method = 'cash';

  SELECT coalesce(sum(t.change_cents), 0)::bigint INTO v_change
  FROM public.pos_transactions t
  WHERE t.session_id = p_session_id;

  SELECT coalesce(sum(m.amount_cents) FILTER (WHERE m.kind = 'cash_in'), 0)::bigint,
         coalesce(sum(m.amount_cents) FILTER (WHERE m.kind <> 'cash_in'), 0)::bigint
  INTO v_mv_in, v_mv_out
  FROM public.pos_cash_movements m
  WHERE m.session_id = p_session_id;

  v_expected := v_session.opening_float_cents + v_cash_in - v_change + v_mv_in - v_mv_out;
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
                       'variance_cents', v_variance, 'closing_id', v_closing.id, 'closing_number', v_closing.closing_number,
                       'cash_movements_in_cents', v_mv_in, 'cash_movements_out_cents', v_mv_out));

  RETURN jsonb_build_object('session', to_jsonb(v_session), 'closing', to_jsonb(v_closing));
END;
$$;
COMMENT ON FUNCTION public.pos_close_session(uuid, bigint, text, uuid) IS 'POS NF525 : ferme une session (espèces attendues incluant les mouvements d''espèces 0.5.0, écart), crée la clôture Z daily et journalise session_close. Retourne {session, closing}.';

-- -----------------------------------------------------------------------------
-- pos_x_report : espèces attendues et détail des mouvements (corps 0.3.0).
-- -----------------------------------------------------------------------------
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
  v_mv_in    bigint;
  v_mv_out   bigint;
  v_mv_list  jsonb;
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

  SELECT coalesce(sum(m.amount_cents) FILTER (WHERE m.kind = 'cash_in'), 0)::bigint,
         coalesce(sum(m.amount_cents) FILTER (WHERE m.kind <> 'cash_in'), 0)::bigint,
         coalesce(jsonb_agg(jsonb_build_object(
           'kind', m.kind, 'amount_cents', m.amount_cents, 'reason', m.reason,
           'reference', m.reference, 'created_at', public.pos_canonical_ts(m.created_at)
         ) ORDER BY m.created_at), '[]'::jsonb)
  INTO v_mv_in, v_mv_out, v_mv_list
  FROM public.pos_cash_movements m
  WHERE m.session_id = p_session_id;

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
      'expected_cash_cents', v_session.opening_float_cents + v_cash_in - v_change + v_mv_in - v_mv_out,
      'movements_in_cents', v_mv_in,
      'movements_out_cents', v_mv_out,
      'movements', v_mv_list),
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
  'POS NF525 : lecture X (intermédiaire, sans remise à zéro) d''une session ouverte ; agrégats identiques au Z1, espèces attendues (mouvements d''espèces 0.5.0 inclus, détaillés), GTP projeté ; tracée au JET (x_report).';
REVOKE ALL ON FUNCTION public.pos_x_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_x_report(uuid) TO authenticated, service_role;

-- Vérification :
--   SELECT * FROM public.pos_cash_movements ORDER BY created_at DESC LIMIT 10;
--   SELECT payload FROM public.pos_events WHERE event_type = 'cash_movement' ORDER BY id DESC LIMIT 10;
