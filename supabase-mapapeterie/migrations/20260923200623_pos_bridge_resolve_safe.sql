-- POS bridge (projet ma-papeterie) : resolve_price() lève une exception si le produit est inconnu ;
-- on isole chaque ligne pour que pos_resolve_cart_prices renvoie NULL sur la ligne fautive
-- au lieu d'échouer globalement. Remplace la version de 20260923195840_pos_bridge_functions.sql.
CREATE OR REPLACE FUNCTION public.pos_resolve_price_safe(p_account_id uuid, p_product_id uuid, p_qty int)
RETURNS TABLE (unit_price_ht numeric, vat_rate numeric, rule_id uuid, rule_scope text, rule_mode text, rule_value numeric, public_price_ht numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  IF p_product_id IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT rp.unit_price_ht, rp.vat_rate, rp.rule_id, rp.rule_scope::text, rp.rule_mode::text, rp.rule_value, rp.public_price_ht
               FROM public.resolve_price(p_account_id, p_product_id, p_qty) rp;
EXCEPTION WHEN OTHERS THEN
  RETURN;
END;
$$;
COMMENT ON FUNCTION public.pos_resolve_price_safe(uuid, uuid, int) IS 'POS bridge : resolve_price() sans exception (aucune ligne si produit inconnu).';
REVOKE EXECUTE ON FUNCTION public.pos_resolve_price_safe(uuid, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_resolve_price_safe(uuid, uuid, int) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pos_resolve_cart_prices(p_account_id uuid, p_lines jsonb)
RETURNS TABLE (product_id uuid, qty numeric, unit_price_ht_cents bigint, unit_price_ttc_cents bigint, vat_rate numeric,
               rule_id uuid, rule_scope text, rule_mode text, rule_value numeric, public_price_ht_cents bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_lines","reason":"array expected"}'::jsonb);
  END IF;
  RETURN QUERY
    SELECT
      nullif(e ->> 'product_id', '')::uuid,
      coalesce((e ->> 'qty')::numeric, 1),
      round(rp.unit_price_ht * 100)::bigint,
      round(rp.unit_price_ht * 100 * (1 + round(rp.vat_rate, 2) / 100))::bigint,
      round(rp.vat_rate, 2),
      rp.rule_id, rp.rule_scope, rp.rule_mode, rp.rule_value,
      round(rp.public_price_ht * 100)::bigint
    FROM jsonb_array_elements(p_lines) AS e
    LEFT JOIN LATERAL public.pos_resolve_price_safe(p_account_id, nullif(e ->> 'product_id', '')::uuid,
      greatest(1, ceil(coalesce((e ->> 'qty')::numeric, 1)))::int) AS rp ON true;
END;
$$;
