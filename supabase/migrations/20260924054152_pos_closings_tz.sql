-- =============================================================================
-- POS NF525 — lot 5 : bornes de période Europe/Paris + vérification de la
-- chaîne des clôtures (projet Pos)
-- -----------------------------------------------------------------------------
-- pos_period_bounds(type, ref) : période daily|monthly|annual contenant ref,
--   bornes calculées en heure légale française (fin exclusive). Remplace le
--   calcul UTC de l'Edge Function pos-closing (décalage d'1 à 2 h).
-- pos_verify_closings_chain(register) : numéros continus, prev_hash, hash
--   recalculé (même formule que pos_compute_closing).
-- Idempotent (CREATE OR REPLACE).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pos_period_bounds(p_type text, p_ref timestamptz)
RETURNS TABLE (period_start timestamptz, period_end timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_unit  text;
  v_local timestamp;
BEGIN
  v_unit := CASE p_type WHEN 'daily' THEN 'day' WHEN 'monthly' THEN 'month' WHEN 'annual' THEN 'year' END;
  IF v_unit IS NULL OR p_ref IS NULL THEN
    PERFORM public.pos_error('VALIDATION', jsonb_build_object('field', 'period_type', 'reason', 'daily|monthly|annual and a reference date are required'));
  END IF;
  v_local := date_trunc(v_unit, p_ref AT TIME ZONE 'Europe/Paris');
  period_start := v_local AT TIME ZONE 'Europe/Paris';
  period_end   := (v_local + ('1 ' || v_unit)::interval) AT TIME ZONE 'Europe/Paris';
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.pos_period_bounds(text, timestamptz) IS
  'POS NF525 : bornes [début, fin) de la période daily|monthly|annual contenant p_ref, en heure légale Europe/Paris.';
GRANT EXECUTE ON FUNCTION public.pos_period_bounds(text, timestamptz) TO authenticated, service_role;

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
    v_hash := public.pos_sha256(
      'v1|closing|' || c.closing_number
      || '|' || c.period_type
      || '|' || public.pos_canonical_ts(c.period_start)
      || '|' || public.pos_canonical_ts(c.period_end)
      || '|' || c.txn_count
      || '|' || c.total_ttc_cents
      || '|' || c.grand_total_perpetual_cents
      || '|' || c.prev_hash);
    IF v_hash <> c.hash THEN
      ok := false; first_break_number := c.closing_number; reason := 'HASH_MISMATCH';
      RETURN NEXT; RETURN;
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
  'POS NF525 : vérifie la chaîne des clôtures d''une caisse (numéros continus, prev_hash, hash recalculé).';
REVOKE ALL ON FUNCTION public.pos_verify_closings_chain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_verify_closings_chain(uuid) TO authenticated, service_role;
