-- =============================================================================
-- POS NF525 — règlement en caisse de lignes de commandes / BL ma-papeterie
-- (projet Pos, HORS PÉRIMÈTRE FISCAL)
-- -----------------------------------------------------------------------------
-- Un ticket peut régler plusieurs commandes et bons de livraison d'un même client
-- (lignes transférées dans le panier). Les références (sales_order_line_id,
-- delivery_note_line_id, quantité) suivent le précédent de order_id
-- (PERIMETRE-NF525.md §1.2) : retirées du payload avant pos_finalize_sale par
-- pos-checkout, jamais stockées dans pos_transactions ni hachées, inscrites ici
-- après validation du ticket, envoyées à pos_settle_documents (ma-papeterie).
--
--   * pos_document_settlements           : outbox (1 ligne par vente, lignes en jsonb).
--   * pos_document_settlement_record()   : inscription idempotente (ventes uniquement).
--   * pos_document_settlement_pending()  : règlements à envoyer.
--   * pos_document_settlement_mark()     : résultat d'une tentative.
-- Rejeu : cron pos-sales-sync (5 min), après l'envoi immédiat par pos-checkout.
-- L'ancien pont commande entière (pos_order_settlements) reste servi : tickets
-- en file hors ligne d'une version antérieure.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_document_settlements (
  transaction_id uuid        PRIMARY KEY REFERENCES public.pos_transactions (id),
  lines          jsonb       NOT NULL CHECK (jsonb_typeof(lines) = 'array' AND jsonb_array_length(lines) > 0),
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'done', 'rejected', 'failed')),
  attempts       int         NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  done_at        timestamptz
);
COMMENT ON TABLE public.pos_document_settlements IS
  'Pont commandes/BL → ma-papeterie (hors périmètre fiscal) : lignes de commandes et de BL réglées par une vente, envoyées à pos_settle_documents. rejected = refus métier (quantité, client), failed = 100 échecs techniques.';
CREATE INDEX IF NOT EXISTS pos_document_settlements_status_idx ON public.pos_document_settlements (status);

ALTER TABLE public.pos_document_settlements ENABLE ROW LEVEL SECURITY;
-- deny-all volontaire : service role uniquement (pos-checkout, pos-sales-sync).
REVOKE ALL ON public.pos_document_settlements FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- Inscription (pos-checkout, après pos_finalize_sale, rejeux compris).
-- p_lines : [{sales_order_line_id, delivery_note_line_id?, qty}] (validé par
-- pos-checkout). Retourne false si la transaction n'est pas une vente ou est
-- déjà inscrite.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_document_settlement_record(p_transaction_id uuid, p_lines jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM public.pos_require_service_role();
  IF p_transaction_id IS NULL OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array'
     OR jsonb_array_length(p_lines) = 0 THEN
    RETURN false;
  END IF;
  INSERT INTO public.pos_document_settlements (transaction_id, lines)
  SELECT t.id, p_lines
  FROM public.pos_transactions t
  WHERE t.id = p_transaction_id AND t.kind = 'sale'
  ON CONFLICT (transaction_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
COMMENT ON FUNCTION public.pos_document_settlement_record(uuid, jsonb) IS
  'Pont commandes/BL (service role) : lignes réglées par une vente validée (idempotent, ventes uniquement).';
REVOKE EXECUTE ON FUNCTION public.pos_document_settlement_record(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Règlements à envoyer, au format de pos_settle_documents (ma-papeterie).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_document_settlement_pending(
  p_limit           int    DEFAULT 200,
  p_transaction_ids uuid[] DEFAULT NULL
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
      'transaction_id',      t.id,
      'customer_account_id', t.customer_account_id,
      'register_code',       r.code,
      'ticket_number',       t.ticket_number,
      'business_at',         t.business_at,
      'lines',               s.lines
    )
    FROM public.pos_document_settlements s
    JOIN public.pos_transactions t ON t.id = s.transaction_id
    JOIN public.pos_registers r ON r.id = t.register_id
    WHERE s.status = 'pending'
      AND (p_transaction_ids IS NULL OR s.transaction_id = ANY (p_transaction_ids))
    ORDER BY s.created_at, s.transaction_id
    LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000);
END;
$$;
COMMENT ON FUNCTION public.pos_document_settlement_pending(int, uuid[]) IS
  'Pont commandes/BL (service role) : règlements en attente au format pos_settle_documents (p_transaction_ids : envoi ciblé).';
REVOKE EXECUTE ON FUNCTION public.pos_document_settlement_pending(int, uuid[]) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Résultat : done | rejected (définitif) | pending (failed après 100 tentatives).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_document_settlement_mark(
  p_transaction_ids uuid[],
  p_status          text,
  p_error           text DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM public.pos_require_service_role();
  IF p_status NOT IN ('done', 'rejected', 'pending') THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION', DETAIL = '{"field":"p_status"}';
  END IF;
  UPDATE public.pos_document_settlements s
  SET attempts   = s.attempts + 1,
      status     = CASE
                     WHEN p_status = 'pending' AND s.attempts + 1 >= 100 THEN 'failed'
                     ELSE p_status
                   END,
      last_error = CASE WHEN p_status = 'done' THEN NULL ELSE left(p_error, 500) END,
      done_at    = CASE WHEN p_status = 'done' THEN now() ELSE s.done_at END
  WHERE s.transaction_id = ANY (coalesce(p_transaction_ids, '{}'::uuid[]))
    AND s.status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION public.pos_document_settlement_mark(uuid[], text, text) IS
  'Pont commandes/BL (service role) : résultat d''un envoi — done, rejected (définitif) ou pending (failed après 100 tentatives).';
REVOKE EXECUTE ON FUNCTION public.pos_document_settlement_mark(uuid[], text, text) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- ROLLBACK :
--   DROP FUNCTION IF EXISTS public.pos_document_settlement_mark(uuid[], text, text);
--   DROP FUNCTION IF EXISTS public.pos_document_settlement_pending(int, uuid[]);
--   DROP FUNCTION IF EXISTS public.pos_document_settlement_record(uuid, jsonb);
--   DROP TABLE IF EXISTS public.pos_document_settlements;
-- =============================================================================
