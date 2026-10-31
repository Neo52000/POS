-- =============================================================================
-- POS NF525 — contact de passage d'une vente (projet Pos, HORS PÉRIMÈTRE FISCAL)
-- -----------------------------------------------------------------------------
-- Une personne sans dossier client (nom + téléphone, table passage_contacts du
-- projet ma-papeterie) peut être rattachée à un ticket. Le ticket fiscal porte
-- customer_account_id = fiche « Client passage » de ma-papeterie (vrai compte :
-- hash v1, snapshot client et pont commandes inchangés). L'identifiant du
-- contact, lui, suit le précédent de order_id (PERIMETRE-NF525.md §1.2) :
-- retiré du payload avant pos_finalize_sale par pos-checkout, jamais stocké
-- dans pos_transactions ni haché, inscrit ici après validation du ticket.
--
--   * pos_transaction_passage_contacts : outbox (1 ligne par vente rattachée).
--   * pos_passage_contact_record()     : inscription idempotente (ventes uniquement).
--   * pos_sales_sync_pending()         : transmet passage_contact_id à
--                                        pos_record_sales (ma-papeterie), qui le
--                                        complète aussi sur un ticket déjà reçu.
-- Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_transaction_passage_contacts (
  transaction_id     uuid        PRIMARY KEY REFERENCES public.pos_transactions (id),
  passage_contact_id uuid        NOT NULL,                  -- passage_contacts.id ma-papeterie (sans FK)
  created_at         timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pos_transaction_passage_contacts IS
  'Pont contacts de passage → ma-papeterie (hors périmètre fiscal) : vente rattachée à une personne de passage (passage_contacts ma-papeterie). Lu par pos_sales_sync_pending.';

ALTER TABLE public.pos_transaction_passage_contacts ENABLE ROW LEVEL SECURITY;
-- deny-all volontaire : service role uniquement (pos-checkout, pos-sales-sync).
REVOKE ALL ON public.pos_transaction_passage_contacts FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- Inscription (appelée par pos-checkout juste après pos_finalize_sale, rejeux
-- compris). Retourne false si la transaction n'est pas une vente ou est déjà
-- rattachée.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_passage_contact_record(p_transaction_id uuid, p_passage_contact_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM public.pos_require_service_role();
  IF p_transaction_id IS NULL OR p_passage_contact_id IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.pos_transaction_passage_contacts (transaction_id, passage_contact_id)
  SELECT t.id, p_passage_contact_id
  FROM public.pos_transactions t
  WHERE t.id = p_transaction_id AND t.kind = 'sale'
  ON CONFLICT (transaction_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
COMMENT ON FUNCTION public.pos_passage_contact_record(uuid, uuid) IS
  'Pont contacts de passage (service role) : rattache une vente validée à un contact de passage ma-papeterie (idempotent, ventes uniquement).';
REVOKE EXECUTE ON FUNCTION public.pos_passage_contact_record(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Pont ventes : reprise de 20260927090000_pos_sales_sync.sql, seuls ajouts :
-- passage_contact_id (LEFT JOIN de l'outbox ci-dessus).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_sales_sync_pending(
  p_limit        int     DEFAULT 200,
  p_include_test boolean DEFAULT false
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_require_service_role();
  RETURN QUERY
    SELECT jsonb_build_object(
      'transaction_id',           t.id,
      'register_code',            r.code,
      'ticket_number',            t.ticket_number,
      'kind',                     t.kind,
      'refund_of_transaction_id', t.refund_of_transaction_id,
      'business_at',              t.business_at,
      'business_date',            t.business_date,
      'total_ttc_cents',          t.total_ttc_cents,
      'total_ht_cents',           t.total_ht_cents,
      'total_vat_cents',          t.total_vat_cents,
      'vat_breakdown',            t.vat_breakdown,
      'customer_account_id',      t.customer_account_id,
      'signature_status',         t.signature_status,
      'passage_contact_id',       pc.passage_contact_id,
      'payments', coalesce((
        SELECT jsonb_agg(jsonb_build_object('method', p.method, 'amount_cents', p.amount_cents)
                         ORDER BY p.created_at, p.id)
        FROM public.pos_payments p
        WHERE p.transaction_id = t.id
      ), '[]'::jsonb),
      'lines', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'line_no',        l.line_no,
                 'product_id',     l.product_id,
                 'ean',            l.ean,
                 'label',          l.label,
                 'qty',            l.qty,
                 'line_ttc_cents', l.line_ttc_cents,
                 'line_ht_cents',  l.line_ht_cents,
                 'vat_rate',       l.vat_rate
               ) ORDER BY l.line_no)
        FROM public.pos_transaction_lines l
        WHERE l.transaction_id = t.id
      ), '[]'::jsonb)
    )
    FROM public.pos_transactions t
    JOIN public.pos_registers r ON r.id = t.register_id
    LEFT JOIN public.pos_sales_sync s ON s.transaction_id = t.id
    LEFT JOIN public.pos_transaction_passage_contacts pc ON pc.transaction_id = t.id
    WHERE (r.fiskaly_env = 'live' OR p_include_test)
      AND (s.transaction_id IS NULL OR s.status = 'pending')
    ORDER BY t.received_at, t.id
    LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000);
END;
$$;
COMMENT ON FUNCTION public.pos_sales_sync_pending(int, boolean) IS
  'Pont ventes (service role, hors périmètre fiscal) : tickets des caisses live à envoyer à ma-papeterie (pos_record_sales), avec lignes, paiements et contact de passage (outbox, hors périmètre fiscal). p_include_test : contrôle manuel uniquement.';
REVOKE EXECUTE ON FUNCTION public.pos_sales_sync_pending(int, boolean) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- ROLLBACK :
--   recréer pos_sales_sync_pending depuis 20260927090000_pos_sales_sync.sql ;
--   DROP FUNCTION IF EXISTS public.pos_passage_contact_record(uuid, uuid);
--   DROP TABLE IF EXISTS public.pos_transaction_passage_contacts;
-- =============================================================================
