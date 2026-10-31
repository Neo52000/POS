-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — lots de commandes préparés pour la caisse
-- -----------------------------------------------------------------------------
-- Depuis la fiche client (/admin/clients/[id], onglet Commandes), l'admin coche
-- plusieurs commandes encaissables et les regroupe en un LOT : une facture, un
-- encaissement en caisse NF525. La caisse (pos-customer-orders) reçoit le lot
-- avec les commandes à encaisser et le présélectionne ; le paiement règle toutes
-- les commandes sur un seul ticket (pos_settle_orders, encaissement groupé).
--
--   pos_order_groups                    1 ligne par lot (2 à 50 commandes d'un compte)
--   admin_create_pos_order_group(...)   création validée (service role) ; remplace
--                                       les lots ouverts qui partagent une commande
--   admin_cancel_pos_order_group(...)   annulation (service role)
--   pos_customer_open_orders            ajoute `prepared_group` à chaque commande
--                                       d'un lot dont TOUTES les commandes sont
--                                       encore à encaisser
--
-- Aucun effet sur sales_orders, ni sur la facturation ERP (invoices) : la facture
-- du lot est le ticket de caisse « facture demandée » (invoice_requested).
-- Un lot n'a pas d'état « consommé » : il disparaît de la caisse dès qu'une de
-- ses commandes est réglée, annulée, facturée ou payée en ligne.
-- Fiche « Client passage » exclue (ses commandes appartiennent à des contacts).
-- Même fichier dans Neo52000/POS (supabase-mapapeterie/migrations) et
-- Neo52000/ma-papeterie-v1 (supabase/migrations). Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_order_groups (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid        NOT NULL REFERENCES public.customer_accounts (id) ON DELETE CASCADE,
  order_ids         uuid[]      NOT NULL CHECK (cardinality(order_ids) BETWEEN 2 AND 50),
  invoice_requested boolean     NOT NULL DEFAULT true,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  cancelled_at      timestamptz
);
COMMENT ON TABLE public.pos_order_groups IS 'POS bridge : lot de commandes sales_orders d''un compte, préparé au back-office pour un encaissement groupé en caisse (un ticket, une facture). Écrit uniquement par admin_create_pos_order_group / admin_cancel_pos_order_group (service role).';
CREATE INDEX IF NOT EXISTS pos_order_groups_account_open_idx
  ON public.pos_order_groups (account_id, created_at DESC) WHERE cancelled_at IS NULL;

ALTER TABLE public.pos_order_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_order_groups FROM anon, authenticated;
DROP POLICY IF EXISTS pos_order_groups_admin_select ON public.pos_order_groups;
CREATE POLICY pos_order_groups_admin_select ON public.pos_order_groups
  FOR SELECT TO authenticated USING (public.is_admin());
GRANT SELECT ON public.pos_order_groups TO authenticated;
-- Écritures : service role uniquement (RPC ci-dessous), aucune policy d'écriture.

-- -----------------------------------------------------------------------------
-- Commande encaissable en caisse (même règle que pos_customer_open_orders).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_order_is_cashable(p_order_id uuid, p_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sales_orders so
    WHERE so.id = p_order_id
      AND so.account_id = p_account_id
      AND so.status NOT IN ('cancelled', 'invoiced')
      AND coalesce(so.shopify_financial_status, '') NOT IN
          ('paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided')
      AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements ps WHERE ps.order_id = so.id)
      AND EXISTS (SELECT 1 FROM public.sales_order_lines l
                  WHERE l.order_id = so.id AND l.qty - coalesce(l.qty_invoiced, 0) > 0)
  );
$$;
COMMENT ON FUNCTION public.pos_order_is_cashable(uuid, uuid) IS 'POS bridge : vrai si la commande du compte est encaissable en caisse (non annulée/facturée, non payée en ligne, non réglée en caisse, au moins une ligne restant due).';
REVOKE EXECUTE ON FUNCTION public.pos_order_is_cashable(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Création d'un lot (API admin, service role).
-- Refus : VALIDATION (taille, doublons), ACCOUNT_NOT_FOUND, PASSAGE_ACCOUNT,
-- ORDER_NOT_CASHABLE (detail.order_ids = commandes refusées).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_pos_order_group(
  p_account_id        uuid,
  p_order_ids         uuid[],
  p_invoice_requested boolean DEFAULT true,
  p_created_by        uuid    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_ids     uuid[];
  v_bad     uuid[];
  v_passage boolean;
  v_id      uuid;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  SELECT array_agg(DISTINCT u) INTO v_ids FROM unnest(p_order_ids) u WHERE u IS NOT NULL;
  IF coalesce(cardinality(v_ids), 0) < 2 OR cardinality(v_ids) > 50
     OR cardinality(v_ids) <> cardinality(p_order_ids) THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_order_ids","reason":"2 à 50 commandes distinctes"}'::jsonb);
  END IF;

  SELECT coalesce(a.is_passage, false) INTO v_passage FROM public.customer_accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    PERFORM public.pos_bridge_error('ACCOUNT_NOT_FOUND', jsonb_build_object('account_id', p_account_id));
  END IF;
  IF v_passage THEN
    PERFORM public.pos_bridge_error('PASSAGE_ACCOUNT', NULL);
  END IF;

  SELECT array_agg(u) INTO v_bad FROM unnest(v_ids) u
  WHERE NOT public.pos_order_is_cashable(u, p_account_id);
  IF v_bad IS NOT NULL THEN
    PERFORM public.pos_bridge_error('ORDER_NOT_CASHABLE', jsonb_build_object('order_ids', to_jsonb(v_bad)));
  END IF;

  -- Un nouveau lot remplace les lots ouverts du compte qui partagent une commande.
  UPDATE public.pos_order_groups g SET cancelled_at = now()
  WHERE g.account_id = p_account_id AND g.cancelled_at IS NULL AND g.order_ids && v_ids;

  INSERT INTO public.pos_order_groups (account_id, order_ids, invoice_requested, created_by)
  VALUES (p_account_id, v_ids, coalesce(p_invoice_requested, true), p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.admin_create_pos_order_group(uuid, uuid[], boolean, uuid) IS 'Back-office (service role) : prépare un lot de 2 à 50 commandes encaissables d''un compte (hors Client passage) pour un encaissement groupé en caisse ; remplace les lots ouverts qui partagent une commande. Erreurs : VALIDATION, ACCOUNT_NOT_FOUND, PASSAGE_ACCOUNT, ORDER_NOT_CASHABLE.';
REVOKE EXECUTE ON FUNCTION public.admin_create_pos_order_group(uuid, uuid[], boolean, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_cancel_pos_order_group(p_group_id uuid, p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  UPDATE public.pos_order_groups g SET cancelled_at = now()
  WHERE g.id = p_group_id AND g.account_id = p_account_id AND g.cancelled_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
COMMENT ON FUNCTION public.admin_cancel_pos_order_group(uuid, uuid) IS 'Back-office (service role) : annule un lot ouvert du compte ; false si introuvable ou déjà annulé.';
REVOKE EXECUTE ON FUNCTION public.admin_cancel_pos_order_group(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Commandes à encaisser : + prepared_group (lot ouvert le plus récent dont toutes
-- les commandes sont encore à encaisser), {id, invoice_requested, order_count,
-- created_at}, sinon null. Champ ignoré par les caisses antérieures.
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

  WITH open_orders AS (
    SELECT so.*
    FROM public.sales_orders so
    WHERE so.account_id = p_account_id
      AND so.status NOT IN ('cancelled', 'invoiced')
      AND coalesce(so.shopify_financial_status, '') NOT IN
          ('paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided')
      AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements ps WHERE ps.order_id = so.id)
  ),
  live_group AS (
    SELECT g.id, g.order_ids, g.invoice_requested, g.created_at
    FROM public.pos_order_groups g
    WHERE g.account_id = p_account_id
      AND g.cancelled_at IS NULL
      AND g.order_ids <@ (SELECT coalesce(array_agg(o.id), '{}'::uuid[]) FROM open_orders o)
    ORDER BY g.created_at DESC
    LIMIT 1
  )
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
             'prepared_group',    (SELECT jsonb_build_object(
                                            'id',                lg.id,
                                            'invoice_requested', lg.invoice_requested,
                                            'order_count',       cardinality(lg.order_ids),
                                            'created_at',        lg.created_at)
                                     FROM live_group lg WHERE so.id = ANY (lg.order_ids)),
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
    FROM open_orders so
  ) o;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_customer_open_orders(uuid) IS 'POS bridge (service role) : commandes non réglées (hors cancelled/invoiced, hors payées en ligne, hors réglées en caisse) d''un compte client, avec lignes restant à facturer, frais de port TTC et lot préparé au back-office (prepared_group).';
REVOKE EXECUTE ON FUNCTION public.pos_customer_open_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_customer_open_orders(uuid) TO authenticated, service_role;
