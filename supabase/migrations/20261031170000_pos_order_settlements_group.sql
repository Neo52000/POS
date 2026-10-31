-- =============================================================================
-- POS NF525 — encaissement groupé de commandes ma-papeterie (projet Pos)
-- -----------------------------------------------------------------------------
-- Un ticket peut désormais régler PLUSIEURS commandes sales_orders (regroupées
-- dans le panier, une seule facture). pos_order_settlements passe d'une ligne
-- par vente à une ligne par (vente, commande).
--
-- HORS PÉRIMÈTRE FISCAL (PERIMETRE-NF525.md §1.2), inchangé : les identifiants
-- de commande n'entrent ni dans pos_transactions ni dans le hash.
--
--   * PK (transaction_id, order_id) ;
--   * pos_order_settlement_record_many(txn, order_ids[]) : inscription atomique
--     et idempotente — l'ensemble des commandes d'une vente est figé à la
--     première inscription (un rejeu ne peut ni en ajouter ni en retirer) ;
--   * pos_order_settlement_record(txn, order) : conservée (rejeux / ventes en
--     file hors ligne antérieures), délègue à _many ;
--   * pos_order_settlement_pending : inchangée (1 ligne par commande) ;
--   * pos_order_settlement_mark(..., p_order_ids) : résultat par couple
--     (vente, commande) ; sans p_order_ids, toutes les commandes des ventes
--     (compatibilité avec l'ancienne fonction edge pendant le déploiement).
-- Ordre de déploiement : cette migration + celle du projet ma-papeterie
-- (20261031170100_pos_settle_orders_group.sql), puis les fonctions edge.
-- Idempotent.
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.pos_order_settlements'::regclass
      AND c.contype = 'p'
      AND array_length(c.conkey, 1) = 1
  ) THEN
    ALTER TABLE public.pos_order_settlements DROP CONSTRAINT pos_order_settlements_pkey;
    ALTER TABLE public.pos_order_settlements
      ADD CONSTRAINT pos_order_settlements_pkey PRIMARY KEY (transaction_id, order_id);
  END IF;
END;
$$;
COMMENT ON TABLE public.pos_order_settlements IS
  'Pont commandes → ma-papeterie (hors périmètre fiscal) : 1 ligne par (vente, commande sales_orders) réglée par cette vente — plusieurs commandes possibles par ticket (encaissement groupé). rejected = refus métier (commande inconnue / autre client), failed = 100 échecs techniques.';

-- -----------------------------------------------------------------------------
-- Inscription groupée (pos-checkout, après pos_finalize_sale, rejeux compris).
-- Retourne le nombre de commandes inscrites : 0 si la transaction n'est pas une
-- vente, si la liste est vide, ou si la vente est déjà liée (ensemble figé).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_order_settlement_record_many(
  p_transaction_id uuid,
  p_order_ids      uuid[]
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
  IF p_transaction_id IS NULL OR coalesce(cardinality(p_order_ids), 0) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_order_ids) > 50 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION', DETAIL = '{"field":"p_order_ids","reason":"max 50"}';
  END IF;
  -- Sérialise les inscriptions concurrentes d'une même vente (rejeu simultané).
  PERFORM pg_advisory_xact_lock(hashtextextended('pos_order_settlement:' || p_transaction_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.pos_order_settlements s WHERE s.transaction_id = p_transaction_id) THEN
    RETURN 0;
  END IF;
  INSERT INTO public.pos_order_settlements (transaction_id, order_id)
  SELECT t.id, o.order_id
  FROM public.pos_transactions t
  CROSS JOIN (SELECT DISTINCT u AS order_id FROM unnest(p_order_ids) u WHERE u IS NOT NULL) o
  WHERE t.id = p_transaction_id AND t.kind = 'sale'
  ON CONFLICT (transaction_id, order_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION public.pos_order_settlement_record_many(uuid, uuid[]) IS
  'Pont commandes (service role) : lie une vente validée aux commandes ma-papeterie qu''elle règle (≤ 50, ventes uniquement, ensemble figé à la première inscription). Retourne le nombre de commandes inscrites.';
REVOKE EXECUTE ON FUNCTION public.pos_order_settlement_record_many(uuid, uuid[]) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pos_order_settlement_record(p_transaction_id uuid, p_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  PERFORM public.pos_require_service_role();
  IF p_order_id IS NULL THEN
    RETURN false;
  END IF;
  RETURN public.pos_order_settlement_record_many(p_transaction_id, ARRAY[p_order_id]) > 0;
END;
$$;
COMMENT ON FUNCTION public.pos_order_settlement_record(uuid, uuid) IS
  'Pont commandes (service role) : lie une vente validée à UNE commande ma-papeterie (idempotent, ventes uniquement) — voir pos_order_settlement_record_many.';
REVOKE EXECUTE ON FUNCTION public.pos_order_settlement_record(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Résultat par couple (vente, commande).
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.pos_order_settlement_mark(uuid[], text, text);
CREATE OR REPLACE FUNCTION public.pos_order_settlement_mark(
  p_transaction_ids uuid[],
  p_status          text,
  p_error           text   DEFAULT NULL,
  p_order_ids       uuid[] DEFAULT NULL
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
  IF p_order_ids IS NOT NULL
     AND cardinality(p_order_ids) <> coalesce(cardinality(p_transaction_ids), 0) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION',
      DETAIL = '{"field":"p_order_ids","reason":"same length as p_transaction_ids"}';
  END IF;

  UPDATE public.pos_order_settlements s
  SET attempts   = s.attempts + 1,
      status     = CASE
                     WHEN p_status = 'pending' AND s.attempts + 1 >= 100 THEN 'failed'
                     ELSE p_status
                   END,
      last_error = CASE WHEN p_status = 'done' THEN NULL ELSE left(p_error, 500) END,
      done_at    = CASE WHEN p_status = 'done' THEN now() ELSE s.done_at END
  WHERE s.status = 'pending'
    AND (
      (p_order_ids IS NULL AND s.transaction_id = ANY (coalesce(p_transaction_ids, '{}'::uuid[])))
      OR (p_order_ids IS NOT NULL AND (s.transaction_id, s.order_id) IN (
            SELECT k.txn, k.ord FROM unnest(p_transaction_ids, p_order_ids) AS k (txn, ord)))
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION public.pos_order_settlement_mark(uuid[], text, text, uuid[]) IS
  'Pont commandes (service role) : résultat d''un envoi — done, rejected (définitif) ou pending (failed après 100 tentatives). p_order_ids (même longueur que p_transaction_ids) : couples (vente, commande) ; sinon toutes les commandes des ventes.';
REVOKE EXECUTE ON FUNCTION public.pos_order_settlement_mark(uuid[], text, text, uuid[]) FROM PUBLIC, anon, authenticated;
