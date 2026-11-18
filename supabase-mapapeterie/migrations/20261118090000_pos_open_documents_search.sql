-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — recherche transverse des commandes / BL
-- à encaisser, pour la reprise directe en caisse (sans choisir le client avant).
-- -----------------------------------------------------------------------------
-- pos_open_documents_search(p_query, p_limit) : un résultat par client (compte pro)
-- ou par personne de passage ayant au moins une commande ou un BL restant à
-- encaisser (pos_open_document_lines, mêmes règles que pos_customer_open_documents).
--   * p_query vide  : tous les clients ayant des documents à encaisser ;
--   * p_query ≥ 2 car. : n° de commande, n° de BL, nom / société du client,
--     nom ou téléphone (≥ 4 chiffres) d'une personne de passage.
-- Résultat jsonb : [{owner_kind 'account'|'passage', account_id, passage_contact_id,
--   display_name, phone, customer (fiche PosCustomer, comptes pro), orders_count, delivery_notes_count, open_ttc,
--   order_numbers[], last_document_at}] — plus récent d'abord.
-- Fiche « Client passage » portée sans contact : exclue. Lecture seule, service role.
-- Même fichier dans Neo52000/POS et Neo52000/ma-papeterie-v1. Idempotent.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.pos_open_documents_search(p_query text DEFAULT NULL, p_limit int DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_q      text := btrim(coalesce(p_query, ''));
  v_digits text := regexp_replace(coalesce(p_query, ''), '[^0-9]', '', 'g');
  v_key    text := public.passage_phone_key(p_query);
  v_limit  int  := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_res    jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF v_q <> '' AND length(v_q) < 2 THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"q","reason":"2 caractères minimum"}'::jsonb);
  END IF;

  WITH cand AS (
    -- Propriétaires (compte pro ou contact de passage) ayant une commande « candidate »
    -- (filtre grossier, identique à pos_open_document_lines) qui correspond à la recherche.
    SELECT so.account_id,
           so.passage_contact_id,
           max(so.created_at) AS last_at
      FROM public.sales_orders so
      JOIN public.customer_accounts a ON a.id = so.account_id
      LEFT JOIN public.customer_360 c360 ON c360.id = so.account_id
      LEFT JOIN public.passage_contacts pc ON pc.id = so.passage_contact_id
     WHERE so.status NOT IN ('cancelled', 'invoiced')
       AND coalesce(so.shopify_financial_status, '') NOT IN
           ('paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided')
       AND NOT EXISTS (SELECT 1 FROM public.pos_order_settlements ps WHERE ps.order_id = so.id)
       AND ((NOT coalesce(a.is_passage, false)) OR so.passage_contact_id IS NOT NULL)
       AND (
             v_q = ''
          OR so.order_number ILIKE '%' || v_q || '%'
          OR (NOT coalesce(a.is_passage, false)
              AND (c360.display_name ILIKE '%' || v_q || '%' OR c360.company_name ILIKE '%' || v_q || '%'))
          OR pc.full_name ILIKE '%' || v_q || '%'
          OR (length(v_digits) >= 4 AND pc.phone_key LIKE '%' || coalesce(v_key, v_digits) || '%')
          OR EXISTS (SELECT 1 FROM public.delivery_notes d
                      WHERE d.order_id = so.id AND d.voided_at IS NULL
                        AND d.delivery_note_number ILIKE '%' || v_q || '%')
       )
     GROUP BY so.account_id, so.passage_contact_id
     ORDER BY max(so.created_at) DESC
     LIMIT 100
  ),
  docs AS (
    SELECT c.account_id, c.passage_contact_id, c.last_at,
           CASE WHEN c.passage_contact_id IS NULL
                THEN public._pos_open_documents_json(c.account_id, NULL)
                ELSE public._pos_open_documents_json(NULL, c.passage_contact_id) END AS j
      FROM cand c
  ),
  found AS (
    SELECT d.*,
           jsonb_array_length(d.j -> 'orders')         AS n_orders,
           jsonb_array_length(d.j -> 'delivery_notes') AS n_notes
      FROM docs d
  )
  SELECT coalesce(jsonb_agg(r.payload ORDER BY r.last_at DESC), '[]'::jsonb) INTO v_res
    FROM (
      SELECT f.last_at,
             jsonb_build_object(
               'owner_kind',           CASE WHEN f.passage_contact_id IS NULL THEN 'account' ELSE 'passage' END,
               'account_id',           f.account_id,
               'passage_contact_id',   f.passage_contact_id,
               'display_name',         CASE WHEN f.passage_contact_id IS NULL THEN c360.display_name ELSE pc.full_name END,
               'phone',                CASE WHEN f.passage_contact_id IS NULL THEN c360.phone ELSE pc.phone END,
               -- Compte pro : fiche complète (même forme que pos_customer_lookup) pour l'attacher au ticket.
               'customer',             CASE WHEN f.passage_contact_id IS NULL AND c360.id IS NOT NULL THEN jsonb_build_object(
                                         'id', c360.id, 'display_name', c360.display_name,
                                         'company_name', c360.company_name, 'siret', c360.siret,
                                         'vat_number', c360.vat_number, 'kind', c360.kind,
                                         'customer_type', c360.customer_type,
                                         'payment_terms_days', c360.payment_terms_days,
                                         'pricing_rules_count', coalesce(c360.pricing_rules_count, 0),
                                         'open_quotes_count', coalesce(c360.open_quotes_count, 0),
                                         'revenue_ttc_12m', coalesce(c360.revenue_ttc_12m, 0),
                                         'email', c360.email, 'phone', c360.phone) END,
               'orders_count',         f.n_orders,
               'delivery_notes_count', f.n_notes,
               'open_ttc',             coalesce((SELECT sum((e ->> 'open_ttc')::numeric)
                                                   FROM jsonb_array_elements((f.j -> 'orders') || (f.j -> 'delivery_notes')) e), 0),
               'order_numbers',        coalesce((SELECT jsonb_agg(DISTINCT e ->> 'order_number')
                                                   FROM jsonb_array_elements((f.j -> 'orders') || (f.j -> 'delivery_notes')) e), '[]'::jsonb),
               'last_document_at',     f.last_at
             ) AS payload
        FROM found f
        LEFT JOIN public.customer_360 c360 ON c360.id = f.account_id
        LEFT JOIN public.passage_contacts pc ON pc.id = f.passage_contact_id
       WHERE f.n_orders + f.n_notes > 0
       ORDER BY f.last_at DESC
       LIMIT v_limit
    ) r;

  RETURN coalesce(v_res, '[]'::jsonb);
END;
$$;
COMMENT ON FUNCTION public.pos_open_documents_search(text, int) IS
  'POS bridge (service role) : clients et personnes de passage ayant des commandes / BL à encaisser, recherchés par n° de commande ou de BL, nom, société, téléphone (passage). Requête vide = tous. Erreur : VALIDATION (1 caractère).';
REVOKE EXECUTE ON FUNCTION public.pos_open_documents_search(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_open_documents_search(text, int) TO service_role;
