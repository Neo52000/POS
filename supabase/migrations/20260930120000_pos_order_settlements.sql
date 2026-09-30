-- =============================================================================
-- POS NF525 — règlement en caisse des commandes ma-papeterie (projet Pos)
-- -----------------------------------------------------------------------------
-- Une commande ma-papeterie (sales_orders) transférée dans le panier puis
-- encaissée doit être marquée réglée côté ma-papeterie (pos_settle_orders), pour
-- ne plus être proposée à l'encaissement (double encaissement).
--
-- HORS PÉRIMÈTRE FISCAL (PERIMETRE-NF525.md §1.2) : l'identifiant de commande
-- n'entre ni dans pos_transactions ni dans le hash. pos-checkout le retire du
-- payload avant pos_finalize_sale, puis l'inscrit ici après validation du
-- ticket. Une panne du pont n'affecte jamais une vente.
--
--   * pos_order_settlements          : outbox (1 ligne par vente liée à une commande).
--   * pos_order_settlement_record()  : inscription idempotente (ventes uniquement).
--   * pos_order_settlement_pending() : règlements à envoyer (caisses live).
--   * pos_order_settlement_mark()    : résultat d'une tentative.
-- Rejeu : cron pos-sales-sync (5 min), après l'envoi immédiat par pos-checkout.
-- Toutes caisses (contrairement au pont ventes) : le transfert d'une commande est
-- un acte explicite du vendeur, et CHAUMONT-01 reste en fiskaly_env = 'test'
-- jusqu'à la bascule. Le mode formation n'atteint jamais le serveur.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_order_settlements (
  transaction_id uuid        PRIMARY KEY REFERENCES public.pos_transactions (id),
  order_id       uuid        NOT NULL,                        -- sales_orders.id ma-papeterie (sans FK)
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'done', 'rejected', 'failed')),
  attempts       int         NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  done_at        timestamptz
);
COMMENT ON TABLE public.pos_order_settlements IS
  'Pont commandes → ma-papeterie (hors périmètre fiscal) : vente liée à une commande sales_orders, à marquer réglée via pos_settle_orders. rejected = refus métier (commande inconnue / autre client), failed = 100 échecs techniques.';
CREATE INDEX IF NOT EXISTS pos_order_settlements_status_idx ON public.pos_order_settlements (status);

ALTER TABLE public.pos_order_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_order_settlements FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- Inscription (appelée par pos-checkout après pos_finalize_sale, rejeux compris).
-- Retourne false si la transaction n'est pas une vente ou est déjà inscrite.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_order_settlement_record(p_transaction_id uuid, p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  PERFORM public.pos_require_service_role();
  IF p_transaction_id IS NULL OR p_order_id IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.pos_order_settlements (transaction_id, order_id)
  SELECT t.id, p_order_id
  FROM public.pos_transactions t
  WHERE t.id = p_transaction_id AND t.kind = 'sale'
  ON CONFLICT (transaction_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;
COMMENT ON FUNCTION public.pos_order_settlement_record(uuid, uuid) IS
  'Pont commandes (service role) : lie une vente validée à une commande ma-papeterie (idempotent, ventes uniquement).';
REVOKE EXECUTE ON FUNCTION public.pos_order_settlement_record(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Règlements à envoyer (pending), au format de pos_settle_orders.
-- p_transaction_ids : restreint l'envoi (envoi immédiat depuis pos-checkout).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_order_settlement_pending(
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
      'order_id',            s.order_id,
      'customer_account_id', t.customer_account_id,
      'register_code',       r.code,
      'ticket_number',       t.ticket_number,
      'total_ttc_cents',     t.total_ttc_cents,
      'business_at',         t.business_at
    )
    FROM public.pos_order_settlements s
    JOIN public.pos_transactions t ON t.id = s.transaction_id
    JOIN public.pos_registers r ON r.id = t.register_id
    WHERE s.status = 'pending'
      AND (p_transaction_ids IS NULL OR s.transaction_id = ANY (p_transaction_ids))
    ORDER BY s.created_at, s.transaction_id
    LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000);
END;
$$;
COMMENT ON FUNCTION public.pos_order_settlement_pending(int, uuid[]) IS
  'Pont commandes (service role) : règlements en attente au format pos_settle_orders (p_transaction_ids : envoi ciblé).';
REVOKE EXECUTE ON FUNCTION public.pos_order_settlement_pending(int, uuid[]) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Résultat : done | rejected (refus métier, définitif) | pending (nouvel essai,
-- failed après 100 tentatives).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_order_settlement_mark(
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
  UPDATE public.pos_order_settlements s
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
COMMENT ON FUNCTION public.pos_order_settlement_mark(uuid[], text, text) IS
  'Pont commandes (service role) : résultat d''un envoi — done, rejected (définitif) ou pending (failed après 100 tentatives).';
REVOKE EXECUTE ON FUNCTION public.pos_order_settlement_mark(uuid[], text, text) FROM PUBLIC, anon, authenticated;
