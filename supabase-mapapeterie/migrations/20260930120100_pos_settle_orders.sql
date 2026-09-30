-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — commandes réglées en caisse
-- -----------------------------------------------------------------------------
-- pos_order_settlements : une ligne par ticket de caisse ayant réglé une
-- commande sales_orders (idempotent par pos_transaction_id). sales_orders n'est
-- PAS modifiée (aucun effet sur le statut ERP ni sur la synchro Shopify) : la
-- commande réglée est simplement exclue de pos_customer_open_orders.
-- pos_settle_orders(p_settlements) : service role, appelée par le pont Pos
-- (pos-checkout + cron pos-sales-sync). Refus métier : ORDER_NOT_FOUND,
-- ACCOUNT_MISMATCH (commande d'un autre client), VALIDATION.
-- Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_order_settlements (
  pos_transaction_id  uuid        PRIMARY KEY,                    -- pos_transactions.id (projet Pos)
  order_id            uuid        NOT NULL REFERENCES public.sales_orders (id),
  register_code       text,
  ticket_number       bigint,
  amount_ttc_cents    bigint      NOT NULL,
  business_at         timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pos_order_settlements IS 'POS bridge : commandes sales_orders réglées en caisse NF525 (1 ligne par ticket, idempotent). Une commande présente ici n''est plus proposée à l''encaissement.';
CREATE INDEX IF NOT EXISTS pos_order_settlements_order_idx ON public.pos_order_settlements (order_id);
ALTER TABLE public.pos_order_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_order_settlements FROM anon, authenticated;
DROP POLICY IF EXISTS pos_order_settlements_admin_select ON public.pos_order_settlements;
CREATE POLICY pos_order_settlements_admin_select ON public.pos_order_settlements
  FOR SELECT TO authenticated USING (public.is_admin());
GRANT SELECT ON public.pos_order_settlements TO authenticated;

CREATE OR REPLACE FUNCTION public.pos_settle_orders(p_settlements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_s        jsonb;
  v_txn      uuid;
  v_order    uuid;
  v_account  uuid;
  v_amount   bigint;
  v_at       timestamptz;
  v_owner    uuid;
  v_found    boolean;
  v_result   jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF p_settlements IS NULL OR jsonb_typeof(p_settlements) <> 'array' THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_settlements","reason":"array expected"}'::jsonb);
  END IF;

  FOR v_s IN SELECT * FROM jsonb_array_elements(p_settlements) LOOP
    BEGIN
      v_txn     := (v_s ->> 'transaction_id')::uuid;
      v_order   := (v_s ->> 'order_id')::uuid;
      v_account := nullif(v_s ->> 'customer_account_id', '')::uuid;
      v_amount  := (v_s ->> 'total_ttc_cents')::bigint;
      v_at      := (v_s ->> 'business_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      v_txn := NULL;
    END;

    IF v_txn IS NULL OR v_order IS NULL OR v_amount IS NULL OR v_at IS NULL THEN
      v_result := v_result || jsonb_build_object(
        'transaction_id', v_s ->> 'transaction_id', 'applied', false, 'error', 'VALIDATION');
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.pos_order_settlements x WHERE x.pos_transaction_id = v_txn) THEN
      v_result := v_result || jsonb_build_object(
        'transaction_id', v_txn, 'applied', false, 'already_applied', true);
      CONTINUE;
    END IF;

    SELECT true, so.account_id INTO v_found, v_owner
    FROM public.sales_orders so WHERE so.id = v_order;
    IF NOT coalesce(v_found, false) THEN
      v_result := v_result || jsonb_build_object(
        'transaction_id', v_txn, 'applied', false, 'error', 'ORDER_NOT_FOUND');
      CONTINUE;
    END IF;
    IF v_owner IS NOT NULL AND v_owner IS DISTINCT FROM v_account THEN
      v_result := v_result || jsonb_build_object(
        'transaction_id', v_txn, 'applied', false, 'error', 'ACCOUNT_MISMATCH');
      CONTINUE;
    END IF;

    INSERT INTO public.pos_order_settlements
      (pos_transaction_id, order_id, register_code, ticket_number, amount_ttc_cents, business_at)
    VALUES
      (v_txn, v_order, nullif(v_s ->> 'register_code', ''),
       nullif(v_s ->> 'ticket_number', '')::bigint, v_amount, v_at)
    ON CONFLICT (pos_transaction_id) DO NOTHING;

    v_result := v_result || jsonb_build_object('transaction_id', v_txn, 'applied', true);
  END LOOP;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_settle_orders(jsonb) IS 'POS bridge (service role) : marque réglées en caisse les commandes [{transaction_id, order_id, customer_account_id, register_code, ticket_number, total_ttc_cents, business_at}] ; idempotent par transaction_id ; renvoie [{transaction_id, applied, already_applied?, error?}] (ORDER_NOT_FOUND, ACCOUNT_MISMATCH, VALIDATION).';

REVOKE EXECUTE ON FUNCTION public.pos_settle_orders(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_settle_orders(jsonb) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Commandes à encaisser : exclut désormais les commandes réglées en caisse.
-- -----------------------------------------------------------------------------
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
      AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements ps WHERE ps.order_id = so.id)
  ) o;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_customer_open_orders(uuid) IS 'POS bridge (service role) : commandes non réglées (hors cancelled/invoiced, hors payées en ligne, hors réglées en caisse) d''un compte client, avec lignes restant à facturer (vat_rate = ligne ou tva produit ou 20) et frais de port TTC.';
