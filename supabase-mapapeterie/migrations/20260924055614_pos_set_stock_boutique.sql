-- =============================================================================
-- POS bridge (projet ma-papeterie) — lot 6 : inventaire
-- -----------------------------------------------------------------------------
-- pos_set_stock_boutique(product, counted, reason, idempotency_key) : fixe
-- products.stock_boutique à la quantité comptée (valeur absolue), trace le
-- mouvement (reason 'inventory: <motif>', delta = compté - avant, 0 accepté pour
-- tracer un comptage conforme), idempotent par clé (un rejeu renvoie le
-- mouvement d'origine sans rien modifier). Réservé au service role (appel par
-- l'Edge Function pos-stock-adjust du projet Pos). stock_online jamais modifié.
-- Idempotent (CREATE OR REPLACE).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.pos_set_stock_boutique(
  p_product_id uuid, p_counted int, p_reason text, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_key      text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_existing public.pos_stock_movements;
  v_before   int;
  v_after    int;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF p_product_id IS NULL OR p_counted IS NULL OR p_counted < 0 THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_counted","reason":"product and counted >= 0 required"}'::jsonb);
  END IF;
  IF v_reason IS NULL OR v_key IS NULL OR length(v_key) < 8 OR length(v_key) > 80 THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_reason/p_idempotency_key","reason":"reason and idempotency key (8..80 chars) required"}'::jsonb);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('pos_stock_movement:' || v_key));
  SELECT * INTO v_existing FROM public.pos_stock_movements m WHERE m.idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('product_id', v_existing.product_id, 'applied', false, 'already_applied', true,
      'stock_before', v_existing.stock_before, 'stock_after', v_existing.stock_after, 'delta', v_existing.qty_delta);
  END IF;

  SELECT coalesce(p.stock_boutique, 0) INTO v_before FROM public.products p WHERE p.id = p_product_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.pos_bridge_error('PRODUCT_NOT_FOUND', jsonb_build_object('product_id', p_product_id));
  END IF;

  UPDATE public.products p SET stock_boutique = p_counted WHERE p.id = p_product_id
  RETURNING p.stock_boutique INTO v_after;

  INSERT INTO public.pos_stock_movements (idempotency_key, product_id, qty_delta, stock_before, stock_after, went_negative, transaction_ref, reason, created_by)
  VALUES (v_key, p_product_id, p_counted - v_before, v_before, v_after, false, NULL, left('inventory: ' || v_reason, 200), auth.uid());

  RETURN jsonb_build_object('product_id', p_product_id, 'applied', true, 'already_applied', false,
    'stock_before', v_before, 'stock_after', v_after, 'delta', p_counted - v_before);
END;
$$;
COMMENT ON FUNCTION public.pos_set_stock_boutique(uuid, int, text, text) IS
  'POS bridge (service role) : inventaire, fixe products.stock_boutique à la quantité comptée, mouvement tracé, idempotent par clé. Retourne {product_id, applied, already_applied, stock_before, stock_after, delta}.';
REVOKE ALL ON FUNCTION public.pos_set_stock_boutique(uuid, int, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_set_stock_boutique(uuid, int, text, text) TO authenticated, service_role;
