-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — commandes ET BL en cours d'un client,
-- encaissement groupé à la ligne
-- -----------------------------------------------------------------------------
-- Avant : 1 commande par ticket, commande entière masquée une fois réglée
-- (pos_order_settlements), BL invisibles en caisse.
-- Après : un ticket peut régler plusieurs commandes et BL ; le règlement est
-- enregistré À LA LIGNE (pos_settled_lines) :
--   * ligne de BL (non annulé) ouverte = livré sur cette ligne de BL − déjà
--     réglé sur cette ligne de BL, plafonné par le reste dû de la ligne de
--     commande (qty − qty_invoiced − réglé) ;
--   * ligne de commande ouverte = qty − qty_invoiced − réglé − livré dans un BL
--     encore ouvert (= partie non livrée, non payée) : pas de double affichage.
-- Pas de facture automatique : le ticket NF525 est la pièce de caisse.
-- Compat : une commande présente dans pos_order_settlements (ancien modèle)
-- reste exclue en entier ; les anciennes RPC restent en place.
--
--   pos_open_document_lines(p_account_id, p_passage_contact_id)  lignes ouvertes
--   pos_customer_open_documents(p_account_id)       {orders, delivery_notes}
--   pos_passage_open_documents(p_contact_id)        idem, pour un contact de passage
--   pos_settle_documents(p_settlements)             règlement (idempotent par ticket)
--   sales_order_edit_block_reason                   + 'pos_settled' (fusion/ajout
--                                                   interdits après encaissement)
-- Service role uniquement. Même fichier dans Neo52000/POS et ma-papeterie-v1.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_settled_lines (
  id                    bigserial   PRIMARY KEY,
  pos_transaction_id    uuid        NOT NULL,                 -- pos_transactions.id (projet Pos)
  sales_order_line_id   uuid        NOT NULL REFERENCES public.sales_order_lines (id),
  delivery_note_line_id uuid        REFERENCES public.delivery_note_lines (id),
  qty                   numeric(12,3) NOT NULL CHECK (qty > 0),
  register_code         text,
  ticket_number         bigint,
  business_at           timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pos_settled_lines IS
  'POS bridge : quantités de lignes de commande (et de BL) réglées en caisse NF525, 1 ligne par (ticket, ligne). Sert au calcul du reste à encaisser ; ne modifie ni qty_invoiced ni le statut ERP.';
CREATE UNIQUE INDEX IF NOT EXISTS pos_settled_lines_txn_line_key
  ON public.pos_settled_lines (pos_transaction_id, sales_order_line_id,
                               coalesce(delivery_note_line_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS pos_settled_lines_sol_idx ON public.pos_settled_lines (sales_order_line_id);
CREATE INDEX IF NOT EXISTS pos_settled_lines_dnl_idx
  ON public.pos_settled_lines (delivery_note_line_id) WHERE delivery_note_line_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_settled_lines_txn_idx ON public.pos_settled_lines (pos_transaction_id);

ALTER TABLE public.pos_settled_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_settled_lines FROM anon, authenticated;
DROP POLICY IF EXISTS pos_settled_lines_admin_select ON public.pos_settled_lines;
CREATE POLICY pos_settled_lines_admin_select ON public.pos_settled_lines
  FOR SELECT TO authenticated USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- Lignes ouvertes d'un client (p_account_id) ou d'un contact de passage
-- (p_passage_contact_id, commandes encore portées par la fiche passage).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_open_document_lines(
  p_account_id         uuid,
  p_passage_contact_id uuid DEFAULT NULL
)
RETURNS TABLE (
  kind                  text,       -- 'order' | 'delivery_note'
  doc_id                uuid,       -- sales_orders.id ou delivery_notes.id
  doc_number            text,
  doc_created_at        timestamptz,
  order_id              uuid,
  order_number          text,
  order_origin          text,
  shipping_ttc          numeric,
  sales_order_line_id   uuid,
  delivery_note_line_id uuid,
  product_id            uuid,
  label                 text,
  qty_open              numeric,
  unit_price_ht         numeric,
  discount_percent      numeric,
  vat_rate              numeric
)
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  WITH orders AS (
    SELECT so.*
      FROM public.sales_orders so
     WHERE (
             (p_passage_contact_id IS NULL AND so.account_id = p_account_id)
          OR (p_passage_contact_id IS NOT NULL AND so.passage_contact_id = p_passage_contact_id
              AND so.account_id = (SELECT a.id FROM public.customer_accounts a WHERE a.is_passage LIMIT 1))
           )
       AND so.status NOT IN ('cancelled', 'invoiced')
       AND coalesce(so.shopify_financial_status, '') NOT IN
           ('paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided')
       AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements ps WHERE ps.order_id = so.id)
  ),
  sol AS (
    SELECT l.*, o.order_number AS o_number, o.origin AS o_origin, o.created_at AS o_created_at,
           o.shipping_ht AS o_shipping_ht,
           coalesce((SELECT sum(s.qty) FROM public.pos_settled_lines s
                      WHERE s.sales_order_line_id = l.id), 0) AS settled
      FROM public.sales_order_lines l
      JOIN orders o ON o.id = l.order_id
  ),
  dnl AS (
    SELECT d.id AS dn_id, d.delivery_note_number, d.created_at AS dn_created_at,
           x.id AS dnl_id, x.sales_order_line_id, x.qty_delivered,
           x.qty_delivered - coalesce((SELECT sum(s.qty) FROM public.pos_settled_lines s
                                        WHERE s.delivery_note_line_id = x.id), 0) AS dnl_open
      FROM public.delivery_notes d
      JOIN public.delivery_note_lines x ON x.delivery_note_id = d.id
     WHERE d.voided_at IS NULL
       AND d.order_id IN (SELECT id FROM orders)
  ),
  bl_open_by_sol AS (
    SELECT sales_order_line_id, sum(greatest(dnl_open, 0)) AS bl_open
      FROM dnl GROUP BY sales_order_line_id
  )
  -- Lignes de BL ouvertes
  SELECT 'delivery_note', dnl.dn_id, dnl.delivery_note_number, dnl.dn_created_at,
         sol.order_id, coalesce(sol.o_number, ''), sol.o_origin, 0::numeric,
         sol.id, dnl.dnl_id, sol.product_id, sol.label,
         least(dnl.dnl_open, sol.qty - coalesce(sol.qty_invoiced, 0) - sol.settled),
         sol.unit_price_ht, coalesce(sol.discount_percent, 0), sol.vat_rate
    FROM dnl JOIN sol ON sol.id = dnl.sales_order_line_id
   WHERE least(dnl.dnl_open, sol.qty - coalesce(sol.qty_invoiced, 0) - sol.settled) > 0
  UNION ALL
  -- Lignes de commande ouvertes (non livrées, non payées)
  SELECT 'order', sol.order_id, coalesce(sol.o_number, ''), sol.o_created_at,
         sol.order_id, coalesce(sol.o_number, ''), sol.o_origin,
         CASE WHEN sol.o_origin = 'shopify' THEN coalesce(sol.o_shipping_ht, 0)
              ELSE round(coalesce(sol.o_shipping_ht, 0) * 1.2, 2) END,
         sol.id, NULL::uuid, sol.product_id, sol.label,
         sol.qty - coalesce(sol.qty_invoiced, 0) - sol.settled - coalesce(b.bl_open, 0),
         sol.unit_price_ht, coalesce(sol.discount_percent, 0), sol.vat_rate
    FROM sol LEFT JOIN bl_open_by_sol b ON b.sales_order_line_id = sol.id
   WHERE sol.qty - coalesce(sol.qty_invoiced, 0) - sol.settled - coalesce(b.bl_open, 0) > 0;
$$;
COMMENT ON FUNCTION public.pos_open_document_lines(uuid, uuid) IS
  'POS bridge : lignes de commande et de BL restant à encaisser pour un client (ou un contact de passage). Base de pos_customer_open_documents / pos_passage_open_documents / pos_settle_documents.';

-- Agrégat JSON commun {orders:[…], delivery_notes:[…]}.
CREATE OR REPLACE FUNCTION public._pos_open_documents_json(p_account_id uuid, p_passage_contact_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  WITH l AS (
    SELECT o.*, p.name AS product_name, p.tva_rate
      FROM public.pos_open_document_lines(p_account_id, p_passage_contact_id) o
      LEFT JOIN public.products p ON p.id = o.product_id
  ),
  docs AS (
    SELECT l.kind, l.doc_id, min(l.doc_number) AS doc_number, min(l.doc_created_at) AS created_at,
           min(l.order_id::text)::uuid AS order_id, min(l.order_number) AS order_number,
           min(l.order_origin) AS origin, max(l.shipping_ttc) AS shipping_ttc,
           jsonb_agg(jsonb_build_object(
             'sales_order_line_id',   l.sales_order_line_id,
             'delivery_note_line_id', l.delivery_note_line_id,
             'product_id',            l.product_id,
             'label',                 coalesce(nullif(btrim(l.label), ''), l.product_name, 'Article'),
             'quantity',              l.qty_open,
             'unit_price_ht',         l.unit_price_ht,
             'unit_price_ttc',        NULL,
             'discount_percent',      l.discount_percent,
             'vat_rate',              round(coalesce(l.vat_rate, l.tva_rate, 20), 2)
           ) ORDER BY l.label) AS items,
           round(sum(l.qty_open * l.unit_price_ht * (1 - l.discount_percent / 100)
                     * (1 + coalesce(l.vat_rate, l.tva_rate, 20) / 100)), 2) AS open_ttc
      FROM l
     GROUP BY l.kind, l.doc_id
  )
  SELECT jsonb_build_object(
    'orders', coalesce((SELECT jsonb_agg(jsonb_build_object(
                 'id', d.doc_id, 'order_number', d.order_number, 'origin', d.origin,
                 'created_at', d.created_at, 'shipping_ttc', d.shipping_ttc,
                 'open_ttc', d.open_ttc, 'items', d.items) ORDER BY d.created_at DESC)
               FROM docs d WHERE d.kind = 'order'), '[]'::jsonb),
    'delivery_notes', coalesce((SELECT jsonb_agg(jsonb_build_object(
                 'id', d.doc_id, 'delivery_note_number', d.doc_number,
                 'order_id', d.order_id, 'order_number', d.order_number,
                 'created_at', d.created_at, 'open_ttc', d.open_ttc, 'items', d.items)
                 ORDER BY d.created_at DESC)
               FROM docs d WHERE d.kind = 'delivery_note'), '[]'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.pos_customer_open_documents(p_account_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  RETURN public._pos_open_documents_json(p_account_id, NULL);
END;
$$;
COMMENT ON FUNCTION public.pos_customer_open_documents(uuid) IS
  'POS bridge (service role) : commandes et BL restant à encaisser d''un client, lignes avec sales_order_line_id / delivery_note_line_id.';

CREATE OR REPLACE FUNCTION public.pos_passage_open_documents(p_contact_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  RETURN public._pos_open_documents_json(NULL, p_contact_id);
END;
$$;
COMMENT ON FUNCTION public.pos_passage_open_documents(uuid) IS
  'POS bridge (service role) : commandes et BL restant à encaisser d''un contact de passage.';

-- -----------------------------------------------------------------------------
-- Règlement : [{transaction_id, customer_account_id, register_code?, ticket_number?,
--               business_at, lines:[{sales_order_line_id, delivery_note_line_id?, qty}]}]
-- Idempotent par transaction_id. Refus définitifs (ticket entier) :
-- VALIDATION, LINE_NOT_FOUND, ACCOUNT_MISMATCH, QTY_EXCEEDED.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_settle_documents(p_settlements jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_s       jsonb;
  v_l       jsonb;
  v_txn     uuid;
  v_account uuid;
  v_at      timestamptz;
  v_sol     uuid;
  v_dnl     uuid;
  v_qty     numeric;
  v_owner   uuid;
  v_dnl_sol uuid;
  v_open    numeric;
  v_error   text;
  v_result  jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF p_settlements IS NULL OR jsonb_typeof(p_settlements) <> 'array' THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_settlements","reason":"array expected"}'::jsonb);
  END IF;

  FOR v_s IN SELECT * FROM jsonb_array_elements(p_settlements) LOOP
    v_error := NULL;
    BEGIN
      v_txn     := (v_s ->> 'transaction_id')::uuid;
      v_account := nullif(v_s ->> 'customer_account_id', '')::uuid;
      v_at      := (v_s ->> 'business_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      v_txn := NULL;
    END;
    IF v_txn IS NULL OR v_at IS NULL OR jsonb_typeof(v_s -> 'lines') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_s -> 'lines') = 0 THEN
      v_result := v_result || jsonb_build_object(
        'transaction_id', v_s ->> 'transaction_id', 'applied', false, 'error', 'VALIDATION');
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.pos_settled_lines x WHERE x.pos_transaction_id = v_txn) THEN
      v_result := v_result || jsonb_build_object('transaction_id', v_txn, 'applied', false,
                                                 'already_applied', true);
      CONTINUE;
    END IF;

    BEGIN
      FOR v_l IN SELECT * FROM jsonb_array_elements(v_s -> 'lines') LOOP
        v_sol := (v_l ->> 'sales_order_line_id')::uuid;
        v_dnl := nullif(v_l ->> 'delivery_note_line_id', '')::uuid;
        v_qty := (v_l ->> 'qty')::numeric;
        IF v_sol IS NULL OR v_qty IS NULL OR v_qty <= 0 THEN
          RAISE EXCEPTION 'VALIDATION';
        END IF;

        SELECT so.account_id INTO v_owner
          FROM public.sales_order_lines l JOIN public.sales_orders so ON so.id = l.order_id
         WHERE l.id = v_sol;
        IF NOT FOUND THEN RAISE EXCEPTION 'LINE_NOT_FOUND'; END IF;
        IF v_owner IS DISTINCT FROM v_account THEN RAISE EXCEPTION 'ACCOUNT_MISMATCH'; END IF;

        IF v_dnl IS NOT NULL THEN
          SELECT x.sales_order_line_id INTO v_dnl_sol
            FROM public.delivery_note_lines x WHERE x.id = v_dnl;
          IF NOT FOUND OR v_dnl_sol <> v_sol THEN RAISE EXCEPTION 'LINE_NOT_FOUND'; END IF;
        END IF;

        -- Ouvert pour ce compte, recalculé ligne par ligne (les lignes déjà insérées
        -- pour ce même ticket sont prises en compte).
        -- Filtre par compte (fiche passage comprise) puis par ligne : couvre aussi
        -- un contact de passage, sans dépendre de passage_contact_id.
        SELECT o.qty_open INTO v_open
          FROM public.pos_open_document_lines(v_account, NULL) o
         WHERE o.sales_order_line_id = v_sol
           AND o.delivery_note_line_id IS NOT DISTINCT FROM v_dnl;
        IF coalesce(v_open, 0) < v_qty THEN RAISE EXCEPTION 'QTY_EXCEEDED'; END IF;

        INSERT INTO public.pos_settled_lines
          (pos_transaction_id, sales_order_line_id, delivery_note_line_id, qty,
           register_code, ticket_number, business_at)
        VALUES
          (v_txn, v_sol, v_dnl, v_qty, nullif(v_s ->> 'register_code', ''),
           nullif(v_s ->> 'ticket_number', '')::bigint, v_at);
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      -- Annule les lignes déjà insérées pour ce ticket (sous-transaction du bloc).
      v_error := CASE WHEN SQLERRM IN ('VALIDATION', 'LINE_NOT_FOUND', 'ACCOUNT_MISMATCH', 'QTY_EXCEEDED')
                      THEN SQLERRM ELSE 'VALIDATION' END;
    END;

    IF v_error IS NOT NULL THEN
      v_result := v_result || jsonb_build_object('transaction_id', v_txn, 'applied', false,
                                                 'error', v_error);
    ELSE
      v_result := v_result || jsonb_build_object('transaction_id', v_txn, 'applied', true);
    END IF;
  END LOOP;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_settle_documents(jsonb) IS
  'POS bridge (service role) : règle à la ligne des commandes et BL encaissés en caisse ; idempotent par transaction_id ; refus VALIDATION / LINE_NOT_FOUND / ACCOUNT_MISMATCH / QTY_EXCEEDED.';

-- -----------------------------------------------------------------------------
-- Une commande réglée en caisse (tout ou partie) n'est plus modifiable ni
-- fusionnable. Reprise de 20261030135307, seul ajout : 'pos_settled'.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sales_order_edit_block_reason(p_order_id uuid)
  RETURNS text
  LANGUAGE plpgsql
  STABLE
  SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.sales_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.sales_orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF v_order.origin <> 'erp' THEN RETURN 'not_erp'; END IF;
  IF v_order.status NOT IN ('draft', 'confirmed') THEN RETURN 'status'; END IF;
  IF v_order.shopify_order_id IS NOT NULL THEN RETURN 'pushed_to_shopify'; END IF;
  IF v_order.account_id IS NULL THEN RETURN 'no_account'; END IF;
  IF EXISTS (SELECT 1 FROM public.sales_order_lines
              WHERE order_id = p_order_id AND (qty_delivered > 0 OR qty_invoiced > 0)) THEN
    RETURN 'delivered_or_invoiced';
  END IF;
  IF EXISTS (SELECT 1 FROM public.delivery_notes
              WHERE order_id = p_order_id AND voided_at IS NULL) THEN
    RETURN 'has_delivery_note';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices WHERE order_id = p_order_id) THEN
    RETURN 'has_invoice';
  END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_purchase_orders
              WHERE order_id = p_order_id AND status <> 'cancelled') THEN
    RETURN 'has_purchase_order';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_order_settlements WHERE order_id = p_order_id)
     OR EXISTS (SELECT 1 FROM public.pos_settled_lines s
                  JOIN public.sales_order_lines l ON l.id = s.sales_order_line_id
                 WHERE l.order_id = p_order_id) THEN
    RETURN 'pos_settled';
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.pos_open_document_lines(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._pos_open_documents_json(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_customer_open_documents(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_passage_open_documents(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_settle_documents(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sales_order_edit_block_reason(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_open_document_lines(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._pos_open_documents_json(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_customer_open_documents(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_passage_open_documents(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_settle_documents(jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sales_order_edit_block_reason(uuid) TO service_role;

-- =============================================================================
-- ROLLBACK :
--   DROP FUNCTION IF EXISTS public.pos_settle_documents(jsonb);
--   DROP FUNCTION IF EXISTS public.pos_passage_open_documents(uuid);
--   DROP FUNCTION IF EXISTS public.pos_customer_open_documents(uuid);
--   DROP FUNCTION IF EXISTS public._pos_open_documents_json(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.pos_open_document_lines(uuid, uuid);
--   DROP TABLE IF EXISTS public.pos_settled_lines;
--   sales_order_edit_block_reason : recréer la version de 20261030135307.
-- =============================================================================
