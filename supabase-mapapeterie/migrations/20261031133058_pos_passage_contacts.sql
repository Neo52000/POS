-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — contacts de passage en caisse NF525
-- -----------------------------------------------------------------------------
-- Prérequis : migration ma-papeterie-v1 20261031120000_erp_passage_contacts
-- (fiche customer_accounts.is_passage, table passage_contacts, colonnes
-- sales_orders.passage_contact_id et pos_nf525_sales.passage_contact_id).
--
-- À la caisse, une personne sans dossier client (nom + téléphone) est un
-- contact de passage. Le ticket fiscal porte customer_account_id = fiche
-- « Client passage » (vrai compte : hash v1, snapshot et ACCOUNT_MISMATCH
-- inchangés) ; le contact voyage hors périmètre fiscal (outbox Pos
-- pos_transaction_passage_contacts → pos_sales_sync_pending → pos_record_sales).
--
--   pos_passage_lookup(p_query, p_limit)   recherche nom / téléphone (contacts non basculés)
--   pos_passage_upsert(p_full_name, p_phone) création, dédoublonnée par téléphone
--   pos_passage_open_orders(p_contact_id)  commandes à encaisser du contact
--   pos_customer_lookup                     n'expose plus la fiche « Client passage »
--   pos_record_sales                        enregistre passage_contact_id (et le complète
--                                           sur un ticket déjà reçu)
--
-- Service role uniquement : EXECUTE retiré à PUBLIC, anon, authenticated.
-- Même fichier dans Neo52000/POS (supabase-mapapeterie/migrations) et
-- Neo52000/ma-papeterie-v1 (supabase/migrations). Idempotent.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Recherche d'un contact de passage
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_passage_lookup(p_query text, p_limit int DEFAULT 10)
RETURNS TABLE (
  id                 uuid,
  full_name          text,
  phone              text,
  passage_account_id uuid,
  open_orders_count  int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_q       text := btrim(coalesce(p_query, ''));
  v_key     text := public.passage_phone_key(p_query);
  v_digits  text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  v_passage uuid;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF length(v_q) < 2 THEN
    RETURN;
  END IF;
  SELECT a.id INTO v_passage FROM public.customer_accounts a WHERE a.is_passage LIMIT 1;

  RETURN QUERY
    SELECT c.id,
           c.full_name,
           c.phone,
           v_passage,
           (SELECT count(*)::int
              FROM public.sales_orders so
             WHERE so.passage_contact_id = c.id
               AND so.account_id = v_passage
               AND so.status NOT IN ('cancelled', 'invoiced')
               AND coalesce(so.shopify_financial_status, '') NOT IN
                   ('paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided')
               AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements ps WHERE ps.order_id = so.id))
    FROM public.passage_contacts c
    WHERE c.converted_account_id IS NULL
      AND (c.full_name ILIKE '%' || v_q || '%'
           OR (length(v_digits) >= 4 AND c.phone_key LIKE '%' || coalesce(v_key, v_digits) || '%'))
    ORDER BY c.updated_at DESC
    LIMIT least(greatest(coalesce(p_limit, 10), 1), 50);
END;
$$;
COMMENT ON FUNCTION public.pos_passage_lookup(text, int) IS 'POS bridge (service role) : contacts de passage non basculés par nom ou téléphone (≥ 4 chiffres, tous formats) + nb de commandes à encaisser.';

-- -----------------------------------------------------------------------------
-- Création (ou reprise par téléphone) d'un contact de passage
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_passage_upsert(p_full_name text, p_phone text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_name     text := btrim(coalesce(p_full_name, ''));
  v_phone    text := nullif(btrim(coalesce(p_phone, '')), '');
  v_key      text := public.passage_phone_key(p_phone);
  v_contact  public.passage_contacts%ROWTYPE;
  v_existing boolean := false;
  v_passage  uuid;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF v_name = '' OR length(v_name) > 160 THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"full_name"}'::jsonb);
  END IF;
  IF v_phone IS NOT NULL AND (v_key IS NULL OR length(v_phone) > 40) THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"phone"}'::jsonb);
  END IF;
  SELECT a.id INTO v_passage FROM public.customer_accounts a WHERE a.is_passage LIMIT 1;
  IF v_passage IS NULL THEN
    PERFORM public.pos_bridge_error('NOT_FOUND', '{"reason":"passage_account_missing"}'::jsonb);
  END IF;

  IF v_key IS NOT NULL THEN
    SELECT * INTO v_contact FROM public.passage_contacts c
     WHERE c.phone_key = v_key AND c.converted_account_id IS NULL
     ORDER BY c.updated_at DESC LIMIT 1;
    v_existing := FOUND;
  END IF;

  IF NOT v_existing THEN
    INSERT INTO public.passage_contacts (full_name, phone, notes)
    VALUES (v_name, v_phone, 'Créé en caisse NF525')
    RETURNING * INTO v_contact;
  END IF;

  RETURN jsonb_build_object(
    'id', v_contact.id,
    'full_name', v_contact.full_name,
    'phone', v_contact.phone,
    'passage_account_id', v_passage,
    'existing', v_existing);
END;
$$;
COMMENT ON FUNCTION public.pos_passage_upsert(text, text) IS 'POS bridge (service role) : crée un contact de passage, ou renvoie le contact non basculé portant déjà ce téléphone (existing=true). Erreurs VALIDATION, NOT_FOUND.';

-- -----------------------------------------------------------------------------
-- Commandes à encaisser d'un contact de passage (même forme que
-- pos_customer_open_orders, filtrée sur le contact).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_passage_open_orders(p_contact_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_result  jsonb;
  v_passage uuid;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  SELECT a.id INTO v_passage FROM public.customer_accounts a WHERE a.is_passage LIMIT 1;

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
    WHERE so.passage_contact_id = p_contact_id
      AND so.account_id = v_passage
      AND so.status NOT IN ('cancelled', 'invoiced')
      AND coalesce(so.shopify_financial_status, '') NOT IN
          ('paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided')
      AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements ps WHERE ps.order_id = so.id)
  ) o;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_passage_open_orders(uuid) IS 'POS bridge (service role) : commandes non réglées d''un contact de passage (encore portées par la fiche Client passage), même forme que pos_customer_open_orders.';

-- -----------------------------------------------------------------------------
-- Recherche client pro : la fiche « Client passage » n'est plus proposée
-- (elle porterait les commandes de tous les inconnus) — on passe par
-- pos_passage_lookup. Reprise à l'identique de 20260923195840, seul ajout :
-- NOT EXISTS (… is_passage).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_customer_lookup(p_query text, p_limit int DEFAULT 10)
RETURNS TABLE (
  id                  uuid,
  display_name        text,
  company_name        text,
  siret               text,
  vat_number          text,
  kind                text,
  customer_type       text,
  payment_terms_days  int,
  pricing_rules_count int,
  open_quotes_count   int,
  revenue_ttc_12m     numeric,
  email               text,
  phone               text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_q text := btrim(coalesce(p_query, ''));
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF v_q = '' THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT c.id,
           c.display_name::text,
           c.company_name::text,
           c.siret::text,
           c.vat_number::text,
           c.kind::text,
           c.customer_type::text,
           c.payment_terms_days::int,
           coalesce(c.pricing_rules_count, 0)::int,
           coalesce(c.open_quotes_count, 0)::int,
           coalesce(c.revenue_ttc_12m, 0)::numeric,
           c.email::text,
           c.phone::text
    FROM public.customer_360 c
    WHERE (c.display_name ILIKE '%' || v_q || '%'
       OR c.company_name ILIKE '%' || v_q || '%'
       OR c.email        ILIKE '%' || v_q || '%'
       OR c.siret        ILIKE v_q || '%'
       OR c.phone        ILIKE '%' || v_q || '%')
      AND NOT EXISTS (SELECT 1 FROM public.customer_accounts a WHERE a.id = c.id AND a.is_passage)
    ORDER BY (c.kind = 'b2b') DESC, c.company_name NULLS LAST, c.display_name
    LIMIT least(greatest(coalesce(p_limit, 10), 1), 50);
END;
$$;
COMMENT ON FUNCTION public.pos_customer_lookup(text, int) IS 'POS bridge (service role) : recherche client (customer_360) par nom, société, email, SIRET, téléphone ; B2B en premier ; hors fiche « Client passage ».';

-- -----------------------------------------------------------------------------
-- Ventes NF525 : passage_contact_id (hors périmètre fiscal). Reprise de
-- 20260927091000, ajouts : colonne à l'insertion, et complément sur un ticket
-- déjà reçu (l'outbox Pos peut être inscrite après une première synchro).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_record_sales(p_sales jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_s       jsonb;
  v_id      uuid;
  v_contact uuid;
  v_result  jsonb := '[]'::jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF p_sales IS NULL OR jsonb_typeof(p_sales) <> 'array' THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"p_sales","reason":"array expected"}'::jsonb);
  END IF;

  FOR v_s IN SELECT * FROM jsonb_array_elements(p_sales) LOOP
    BEGIN
      v_id := (v_s ->> 'transaction_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_id := NULL;
    END;
    IF v_id IS NULL THEN
      v_result := v_result || jsonb_build_object('transaction_id', v_s ->> 'transaction_id',
                                                 'applied', false, 'error', 'VALIDATION');
      CONTINUE;
    END IF;

    -- Contact inconnu (supprimé, faute de frappe) : ignoré plutôt que de rejeter le ticket.
    BEGIN
      v_contact := nullif(v_s ->> 'passage_contact_id', '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_contact := NULL;
    END;
    IF v_contact IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.passage_contacts c WHERE c.id = v_contact) THEN
      v_contact := NULL;
    END IF;

    IF EXISTS (SELECT 1 FROM public.pos_nf525_sales s WHERE s.transaction_id = v_id) THEN
      UPDATE public.pos_nf525_sales s
      SET signature_status   = coalesce(v_s ->> 'signature_status', s.signature_status),
          passage_contact_id = coalesce(s.passage_contact_id, v_contact)
      WHERE s.transaction_id = v_id;
      v_result := v_result || jsonb_build_object('transaction_id', v_id, 'applied', false,
                                                 'already_applied', true);
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO public.pos_nf525_sales (
        transaction_id, register_code, ticket_number, kind, refund_of_transaction_id,
        business_at, business_date, total_ttc, total_ht, total_vat, vat_breakdown, payments,
        customer_account_id, signature_status, passage_contact_id)
      VALUES (
        v_id,
        v_s ->> 'register_code',
        (v_s ->> 'ticket_number')::bigint,
        v_s ->> 'kind',
        nullif(v_s ->> 'refund_of_transaction_id', '')::uuid,
        (v_s ->> 'business_at')::timestamptz,
        (v_s ->> 'business_date')::date,
        (v_s ->> 'total_ttc_cents')::bigint / 100.0,
        (v_s ->> 'total_ht_cents')::bigint / 100.0,
        (v_s ->> 'total_vat_cents')::bigint / 100.0,
        coalesce(v_s -> 'vat_breakdown', '[]'::jsonb),
        coalesce(v_s -> 'payments', '[]'::jsonb),
        nullif(v_s ->> 'customer_account_id', '')::uuid,
        v_s ->> 'signature_status',
        v_contact);

      INSERT INTO public.pos_nf525_sale_lines (
        transaction_id, line_no, product_id, ean, label, qty, line_ttc, line_ht, vat_rate)
      SELECT v_id,
             (l ->> 'line_no')::int,
             nullif(l ->> 'product_id', '')::uuid,
             nullif(l ->> 'ean', ''),
             coalesce(nullif(l ->> 'label', ''), 'Article'),
             (l ->> 'qty')::numeric,
             (l ->> 'line_ttc_cents')::bigint / 100.0,
             (l ->> 'line_ht_cents')::bigint / 100.0,
             (l ->> 'vat_rate')::numeric
      FROM jsonb_array_elements(coalesce(v_s -> 'lines', '[]'::jsonb)) AS l;

      v_result := v_result || jsonb_build_object('transaction_id', v_id, 'applied', true);
    EXCEPTION WHEN OTHERS THEN
      v_result := v_result || jsonb_build_object('transaction_id', v_id, 'applied', false,
                                                 'error', left(SQLERRM, 200));
    END;
  END LOOP;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.pos_passage_lookup(text, int) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_passage_upsert(text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_passage_open_orders(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_passage_lookup(text, int) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_passage_upsert(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_passage_open_orders(uuid) TO service_role;

-- =============================================================================
-- ROLLBACK :
--   DROP FUNCTION IF EXISTS public.pos_passage_open_orders(uuid);
--   DROP FUNCTION IF EXISTS public.pos_passage_upsert(text, text);
--   DROP FUNCTION IF EXISTS public.pos_passage_lookup(text, int);
--   pos_customer_lookup : recréer la version de 20260923195840_pos_bridge_functions.sql.
--   pos_record_sales    : recréer la version de 20260927091000_pos_nf525_sales.sql.
-- =============================================================================
