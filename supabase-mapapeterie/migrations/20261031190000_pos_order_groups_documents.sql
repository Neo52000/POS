-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — lots préparés au back-office, modèle
-- « documents réglés à la ligne » (pos_settle_documents, 20261031154237)
-- -----------------------------------------------------------------------------
-- Depuis la fiche client (onglet Commandes, « À encaisser »), l'admin coche des
-- commandes et/ou BL restant à encaisser et en fait un LOT : une facture, un
-- encaissement en caisse NF525. pos_customer_open_documents renvoie le lot
-- (prepared_group) ; la caisse le présélectionne et pré-coche « facture ».
--
-- Remplace la première version (20261031180000_pos_order_groups, modèle
-- pos_order_settlements, commandes seules) :
--   * pos_order_groups : + delivery_note_ids ; 2 à 50 documents au total ;
--   * admin_create_pos_order_group(account, order_ids, delivery_note_ids,
--     invoice_requested, created_by) : chaque document doit être ouvert
--     (pos_open_document_lines) ; remplace les lots ouverts qui en partagent un ;
--   * pos_customer_open_documents : + prepared_group {id, invoice_requested,
--     order_ids, delivery_note_ids, created_at} si TOUS les documents du lot sont
--     encore ouverts, sinon null ;
--   * pos_customer_open_orders : rétablie à l'identique (sans prepared_group) ;
--     pos_order_is_cashable supprimée ;
--   * admin_pos_order_settlements(order_ids) : tickets de caisse ayant réglé
--     chaque commande (pos_settled_lines + ancien pos_order_settlements), pour
--     le badge « Réglée en caisse » de la fiche client.
-- Aucun effet sur sales_orders ni sur la facturation ERP (invoices) : la facture
-- du lot est le ticket de caisse « facture demandée ».
-- Fiche « Client passage » exclue. Service role uniquement.
-- Même fichier dans Neo52000/POS (supabase-mapapeterie/migrations) et
-- Neo52000/ma-papeterie-v1 (supabase/migrations). Idempotent.
-- =============================================================================

ALTER TABLE public.pos_order_groups
  ADD COLUMN IF NOT EXISTS delivery_note_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.pos_order_groups ALTER COLUMN order_ids SET DEFAULT '{}';
ALTER TABLE public.pos_order_groups DROP CONSTRAINT IF EXISTS pos_order_groups_order_ids_check;
ALTER TABLE public.pos_order_groups DROP CONSTRAINT IF EXISTS pos_order_groups_size_check;
ALTER TABLE public.pos_order_groups ADD CONSTRAINT pos_order_groups_size_check
  CHECK (cardinality(order_ids) + cardinality(delivery_note_ids) BETWEEN 2 AND 50);
COMMENT ON TABLE public.pos_order_groups IS 'POS bridge : lot de documents (commandes sales_orders et/ou BL delivery_notes) d''un compte, préparé au back-office pour un encaissement groupé en caisse (un ticket, une facture). Écrit uniquement par admin_create_pos_order_group / admin_cancel_pos_order_group (service role).';

DROP FUNCTION IF EXISTS public.admin_create_pos_order_group(uuid, uuid[], boolean, uuid);
DROP FUNCTION IF EXISTS public.pos_order_is_cashable(uuid, uuid);

-- -----------------------------------------------------------------------------
-- Création d'un lot. Refus : VALIDATION, ACCOUNT_NOT_FOUND, PASSAGE_ACCOUNT,
-- DOCUMENT_NOT_OPEN (detail.order_ids / detail.delivery_note_ids refusés).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_create_pos_order_group(
  p_account_id        uuid,
  p_order_ids         uuid[],
  p_delivery_note_ids uuid[],
  p_invoice_requested boolean DEFAULT true,
  p_created_by        uuid    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_orders  uuid[] := coalesce(p_order_ids, '{}');
  v_notes   uuid[] := coalesce(p_delivery_note_ids, '{}');
  v_bad_o   uuid[];
  v_bad_d   uuid[];
  v_passage boolean;
  v_id      uuid;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF array_position(v_orders, NULL) IS NOT NULL OR array_position(v_notes, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT u) FROM unnest(v_orders) u) <> cardinality(v_orders)
     OR (SELECT count(DISTINCT u) FROM unnest(v_notes) u) <> cardinality(v_notes)
     OR cardinality(v_orders) + cardinality(v_notes) NOT BETWEEN 2 AND 50 THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"documents","reason":"2 à 50 documents distincts"}'::jsonb);
  END IF;

  SELECT coalesce(a.is_passage, false) INTO v_passage FROM public.customer_accounts a WHERE a.id = p_account_id;
  IF NOT FOUND THEN
    PERFORM public.pos_bridge_error('ACCOUNT_NOT_FOUND', jsonb_build_object('account_id', p_account_id));
  END IF;
  IF v_passage THEN
    PERFORM public.pos_bridge_error('PASSAGE_ACCOUNT', NULL);
  END IF;

  WITH open_docs AS (
    SELECT DISTINCT kind, doc_id FROM public.pos_open_document_lines(p_account_id, NULL)
  )
  SELECT (SELECT array_agg(u) FROM unnest(v_orders) u
           WHERE NOT EXISTS (SELECT 1 FROM open_docs d WHERE d.kind = 'order' AND d.doc_id = u)),
         (SELECT array_agg(u) FROM unnest(v_notes) u
           WHERE NOT EXISTS (SELECT 1 FROM open_docs d WHERE d.kind = 'delivery_note' AND d.doc_id = u))
    INTO v_bad_o, v_bad_d;
  IF v_bad_o IS NOT NULL OR v_bad_d IS NOT NULL THEN
    PERFORM public.pos_bridge_error('DOCUMENT_NOT_OPEN', jsonb_build_object(
      'order_ids', coalesce(to_jsonb(v_bad_o), '[]'::jsonb),
      'delivery_note_ids', coalesce(to_jsonb(v_bad_d), '[]'::jsonb)));
  END IF;

  -- Un nouveau lot remplace les lots ouverts du compte qui partagent un document.
  UPDATE public.pos_order_groups g SET cancelled_at = now()
   WHERE g.account_id = p_account_id AND g.cancelled_at IS NULL
     AND (g.order_ids && v_orders OR g.delivery_note_ids && v_notes);

  INSERT INTO public.pos_order_groups (account_id, order_ids, delivery_note_ids, invoice_requested, created_by)
  VALUES (p_account_id, v_orders, v_notes, coalesce(p_invoice_requested, true), p_created_by)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.admin_create_pos_order_group(uuid, uuid[], uuid[], boolean, uuid) IS 'Back-office (service role) : prépare un lot de 2 à 50 documents ouverts (commandes et/ou BL) d''un compte (hors Client passage) pour un encaissement groupé en caisse ; remplace les lots ouverts qui partagent un document. Erreurs : VALIDATION, ACCOUNT_NOT_FOUND, PASSAGE_ACCOUNT, DOCUMENT_NOT_OPEN.';
REVOKE EXECUTE ON FUNCTION public.admin_create_pos_order_group(uuid, uuid[], uuid[], boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_pos_order_group(uuid, uuid[], uuid[], boolean, uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- Documents à encaisser + lot préparé (tous ses documents encore ouverts).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_customer_open_documents(p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_docs   jsonb;
  v_orders uuid[];
  v_notes  uuid[];
  v_group  jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  v_docs := public._pos_open_documents_json(p_account_id, NULL);
  SELECT coalesce(array_agg((e ->> 'id')::uuid), '{}') INTO v_orders
    FROM jsonb_array_elements(v_docs -> 'orders') e;
  SELECT coalesce(array_agg((e ->> 'id')::uuid), '{}') INTO v_notes
    FROM jsonb_array_elements(v_docs -> 'delivery_notes') e;

  SELECT jsonb_build_object(
           'id',                g.id,
           'invoice_requested', g.invoice_requested,
           'order_ids',         to_jsonb(g.order_ids),
           'delivery_note_ids', to_jsonb(g.delivery_note_ids),
           'created_at',        g.created_at)
    INTO v_group
    FROM public.pos_order_groups g
   WHERE g.account_id = p_account_id
     AND g.cancelled_at IS NULL
     AND g.order_ids <@ v_orders
     AND g.delivery_note_ids <@ v_notes
   ORDER BY g.created_at DESC
   LIMIT 1;

  RETURN v_docs || jsonb_build_object('prepared_group', v_group);
END;
$$;
COMMENT ON FUNCTION public.pos_customer_open_documents(uuid) IS
  'POS bridge (service role) : commandes et BL restant à encaisser d''un client, lignes avec sales_order_line_id / delivery_note_line_id, et lot préparé au back-office (prepared_group, null si aucun lot complet).';
REVOKE EXECUTE ON FUNCTION public.pos_customer_open_documents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_customer_open_documents(uuid) TO service_role;

-- -----------------------------------------------------------------------------
-- pos_customer_open_orders : rétablie (sans prepared_group, ancien modèle).
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
REVOKE EXECUTE ON FUNCTION public.pos_customer_open_orders(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_customer_open_orders(uuid) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Tickets de caisse ayant réglé (tout ou partie de) chaque commande : nouveau
-- modèle (pos_settled_lines) et ancien (pos_order_settlements). ticket_orders =
-- nombre de commandes réglées par ce ticket (encaissement groupé).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_pos_order_settlements(p_order_ids uuid[])
RETURNS TABLE (
  order_id           uuid,
  pos_transaction_id uuid,
  register_code      text,
  ticket_number      bigint,
  business_at        timestamptz,
  ticket_orders      int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  RETURN QUERY
    WITH t AS (
      SELECT DISTINCT l.order_id, s.pos_transaction_id, s.register_code, s.ticket_number, s.business_at
        FROM public.pos_settled_lines s
        JOIN public.sales_order_lines l ON l.id = s.sales_order_line_id
      UNION
      SELECT x.order_id, x.pos_transaction_id, x.register_code, x.ticket_number, x.business_at
        FROM public.pos_order_settlements x
    )
    SELECT t.order_id, t.pos_transaction_id, t.register_code, t.ticket_number, t.business_at,
           (SELECT count(DISTINCT t2.order_id)::int FROM t t2 WHERE t2.pos_transaction_id = t.pos_transaction_id)
      FROM t
     WHERE t.order_id = ANY (coalesce(p_order_ids, '{}'))
     ORDER BY t.order_id, t.business_at DESC;
END;
$$;
COMMENT ON FUNCTION public.admin_pos_order_settlements(uuid[]) IS 'Back-office (service role) : tickets de caisse NF525 ayant réglé tout ou partie de chaque commande (pos_settled_lines + pos_order_settlements), avec le nombre de commandes du ticket.';
REVOKE EXECUTE ON FUNCTION public.admin_pos_order_settlements(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_pos_order_settlements(uuid[]) TO service_role;
