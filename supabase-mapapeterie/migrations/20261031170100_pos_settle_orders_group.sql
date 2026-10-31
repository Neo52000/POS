-- NB (31/10/2026) : appliquée en prod. Ancien modèle (pos_order_settlements) ; la caisse
-- règle désormais à la ligne (pos_settle_documents, 20261031154237). Conservée pour la
-- compatibilité des rejeux : un ticket ancien modèle peut lier plusieurs commandes.
-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — encaissement groupé de commandes
-- -----------------------------------------------------------------------------
-- Un ticket de caisse peut régler PLUSIEURS commandes sales_orders (regroupées
-- dans le panier, une seule facture). pos_order_settlements passe d'une ligne
-- par ticket à une ligne par (ticket, commande) ; pos_settle_orders devient
-- idempotente par couple (transaction_id, order_id) et renvoie order_id dans
-- chaque résultat (la fonction edge s'en sert pour marquer chaque couple).
-- amount_ttc_cents reste le total TTC du ticket (qui peut couvrir plusieurs
-- commandes) ; group_size = nombre de commandes réglées par ce ticket.
-- sales_orders n'est toujours PAS modifiée.
-- À appliquer AVANT le déploiement des fonctions edge Pos (sinon une 2e
-- commande du même ticket serait vue « already_applied » : la fonction edge
-- la laisse alors en attente faute d'order_id dans la réponse).
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
      ADD CONSTRAINT pos_order_settlements_pkey PRIMARY KEY (pos_transaction_id, order_id);
  END IF;
END;
$$;
ALTER TABLE public.pos_order_settlements ADD COLUMN IF NOT EXISTS group_size int NOT NULL DEFAULT 1;
COMMENT ON TABLE public.pos_order_settlements IS 'POS bridge : commandes sales_orders réglées en caisse NF525 (1 ligne par ticket et par commande, idempotent ; un ticket peut regrouper plusieurs commandes). Une commande présente ici n''est plus proposée à l''encaissement.';
COMMENT ON COLUMN public.pos_order_settlements.amount_ttc_cents IS 'Total TTC du ticket de caisse (peut couvrir plusieurs commandes : voir group_size).';
COMMENT ON COLUMN public.pos_order_settlements.group_size IS 'Nombre de commandes réglées par ce ticket (encaissement groupé).';

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
  v_group    int;
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
        'transaction_id', v_s ->> 'transaction_id', 'order_id', v_s ->> 'order_id',
        'applied', false, 'error', 'VALIDATION');
      CONTINUE;
    END IF;

    IF EXISTS (SELECT 1 FROM public.pos_order_settlements x
               WHERE x.pos_transaction_id = v_txn AND x.order_id = v_order) THEN
      v_result := v_result || jsonb_build_object(
        'transaction_id', v_txn, 'order_id', v_order, 'applied', false, 'already_applied', true);
      CONTINUE;
    END IF;

    v_found := false;
    SELECT true, so.account_id INTO v_found, v_owner
    FROM public.sales_orders so WHERE so.id = v_order;
    IF NOT coalesce(v_found, false) THEN
      v_result := v_result || jsonb_build_object(
        'transaction_id', v_txn, 'order_id', v_order, 'applied', false, 'error', 'ORDER_NOT_FOUND');
      CONTINUE;
    END IF;
    IF v_owner IS NOT NULL AND v_owner IS DISTINCT FROM v_account THEN
      v_result := v_result || jsonb_build_object(
        'transaction_id', v_txn, 'order_id', v_order, 'applied', false, 'error', 'ACCOUNT_MISMATCH');
      CONTINUE;
    END IF;

    -- Taille du groupe : commandes de ce ticket dans le lot (+ déjà inscrites lors d'un envoi antérieur).
    SELECT count(DISTINCT o) INTO v_group FROM (
      SELECT e ->> 'order_id' AS o FROM jsonb_array_elements(p_settlements) e
      WHERE e ->> 'transaction_id' = v_txn::text
      UNION
      SELECT x.order_id::text FROM public.pos_order_settlements x WHERE x.pos_transaction_id = v_txn
    ) g;

    INSERT INTO public.pos_order_settlements
      (pos_transaction_id, order_id, register_code, ticket_number, amount_ttc_cents, business_at, group_size)
    VALUES
      (v_txn, v_order, nullif(v_s ->> 'register_code', ''),
       nullif(v_s ->> 'ticket_number', '')::bigint, v_amount, v_at, greatest(v_group, 1))
    ON CONFLICT (pos_transaction_id, order_id) DO NOTHING;

    v_result := v_result || jsonb_build_object('transaction_id', v_txn, 'order_id', v_order, 'applied', true);
  END LOOP;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_settle_orders(jsonb) IS 'POS bridge (service role) : marque réglées en caisse les commandes [{transaction_id, order_id, customer_account_id, register_code, ticket_number, total_ttc_cents, business_at}] — plusieurs commandes possibles par ticket ; idempotent par (transaction_id, order_id) ; renvoie [{transaction_id, order_id, applied, already_applied?, error?}] (ORDER_NOT_FOUND, ACCOUNT_MISMATCH, VALIDATION).';

REVOKE EXECUTE ON FUNCTION public.pos_settle_orders(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_settle_orders(jsonb) TO authenticated, service_role;
