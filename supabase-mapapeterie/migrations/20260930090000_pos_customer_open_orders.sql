-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — commandes transférables en caisse
-- -----------------------------------------------------------------------------
-- pos_customer_open_orders(p_account_id) : commandes (sales_orders) d'un compte
-- client pro NON RÉGLÉES, reprenables en caisse pour encaissement :
--   * status  ∉ (cancelled, invoiced) ;
--   * shopify_financial_status ∉ (paid, partially_paid, refunded,
--     partially_refunded, voided) — une commande déjà payée en ligne n'est
--     jamais proposée (double encaissement / double CA NF525).
-- Lignes : quantité restant à facturer (qty − qty_invoiced, lignes soldées
-- exclues), prix HT unitaire, remise, TVA (ligne, sinon produit, sinon 20).
-- Frais de port : renvoyés à part en TTC (shipping_ttc, TVA 20 %) ; la caisse
-- les ajoute en ligne libre retirable. Anomalie de données constatée : pour
-- origin = 'shopify', sales_orders.shipping_ht contient le port TTC (total_ttc =
-- subtotal_ht × 1,2 + shipping_ht) ; pour erp/pos, c'est bien du HT.
-- SECURITY DEFINER (sales_orders en RLS), réservée au service role.
-- Idempotent.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pos_customer_open_orders(p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();

  SELECT coalesce(jsonb_agg(o.doc ORDER BY o.created_at DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT so.created_at,
           jsonb_build_object(
             'id',                so.id,
             'order_number',      coalesce(so.order_number, so.shopify_order_name),
             'status',            so.status,
             'origin',            so.origin,
             'financial_status',  so.shopify_financial_status,
             'created_at',        so.created_at,
             'subtotal_ht',       so.subtotal_ht,
             'shipping_ttc',      CASE WHEN so.origin = 'shopify'
                                       THEN coalesce(so.shipping_ht, 0)
                                       ELSE round(coalesce(so.shipping_ht, 0) * 1.2, 2) END,
             'total_ttc',         so.total_ttc,
             'items',             coalesce((
               SELECT jsonb_agg(jsonb_build_object(
                        'product_id',       l.product_id,
                        'label',            coalesce(nullif(btrim(l.label), ''), p.name, 'Article'),
                        'quantity',         l.qty - coalesce(l.qty_invoiced, 0),
                        'unit_price_ht',    l.unit_price_ht,
                        'unit_price_ttc',   NULL,
                        'discount_percent', coalesce(l.discount_percent, 0),
                        'vat_rate',         round(coalesce(l.vat_rate, p.tva_rate, 20), 2)
                      ) ORDER BY l.id)
               FROM public.sales_order_lines l
               LEFT JOIN public.products p ON p.id = l.product_id
               WHERE l.order_id = so.id
                 AND l.qty - coalesce(l.qty_invoiced, 0) > 0
             ), '[]'::jsonb)
           ) AS doc
    FROM public.sales_orders so
    WHERE so.account_id = p_account_id
      AND so.status NOT IN ('cancelled', 'invoiced')
      AND coalesce(so.shopify_financial_status, '') NOT IN
          ('paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided')
  ) o;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_customer_open_orders(uuid) IS 'POS bridge (service role) : commandes non réglées (hors cancelled/invoiced et hors payées en ligne) d''un compte client, avec lignes restant à facturer (vat_rate = ligne ou tva produit ou 20) et frais de port TTC.';

REVOKE EXECUTE ON FUNCTION public.pos_customer_open_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_customer_open_orders(uuid) TO authenticated, service_role;
