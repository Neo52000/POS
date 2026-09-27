-- =============================================================================
-- POS bridge — ventes de la caisse NF525 (projet ma-papeterie)
-- -----------------------------------------------------------------------------
-- Copie de lecture des tickets de la caisse NF525 (projet Pos) pour le
-- dashboard /admin : CA boutique, tickets, marge, corrélation météo.
-- Alimentée par l'Edge Function Pos `pos-sales-sync` (service role, cron 5 min)
-- via pos_record_sales. La source de vérité fiscale reste le projet Pos : ces
-- lignes ne servent qu'aux indicateurs, jamais à une déclaration.
--
-- Pourquoi des tables dédiées et pas shopify_orders / sales_orders :
--   * shopify_orders est le registre des commandes Shopify (webhook +
--     réconciliation, upsert sur shopify_order_id) : y glisser des tickets
--     NF525 fausserait customer_360, le P&L et l'écran de pointage caisse ;
--   * sales_orders origin='pos' ferait apparaître chaque ticket dans la file
--     « À traiter » (BL / facture à émettre) du dashboard.
--
-- Montants en EUROS (numeric), comme les vues du site. Un remboursement est un
-- ticket distinct, de montant négatif, daté du jour du remboursement (même
-- sémantique que le Z de la caisse) ; il ne compte pas comme une commande.
--
-- Idempotent : un ticket NF525 est immuable, pos_record_sales ignore un
-- transaction_id déjà reçu (signature_status seul est rafraîchi, informatif).
-- Même fichier dans Neo52000/POS (supabase-mapapeterie/migrations) et
-- Neo52000/ma-papeterie-v1 (supabase/migrations).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_nf525_sales (
  transaction_id           uuid          PRIMARY KEY,               -- pos_transactions.id (projet Pos)
  register_code            text          NOT NULL,
  ticket_number            bigint        NOT NULL,
  kind                     text          NOT NULL CHECK (kind IN ('sale', 'refund')),
  refund_of_transaction_id uuid,
  business_at              timestamptz   NOT NULL,
  business_date            date          NOT NULL,                  -- date Europe/Paris
  total_ttc                numeric(12,2) NOT NULL,                  -- négatif sur un remboursement
  total_ht                 numeric(12,2) NOT NULL,
  total_vat                numeric(12,2) NOT NULL,
  vat_breakdown            jsonb         NOT NULL DEFAULT '[]'::jsonb,
  payments                 jsonb         NOT NULL DEFAULT '[]'::jsonb, -- [{method, amount_cents}]
  customer_account_id      uuid,
  signature_status         text,
  synced_at                timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (register_code, ticket_number)
);
COMMENT ON TABLE public.pos_nf525_sales IS
  'POS bridge : tickets de la caisse NF525 (projet Pos), copie de lecture pour le dashboard /admin. Source fiscale = projet Pos. Montants en euros, remboursements négatifs.';
CREATE INDEX IF NOT EXISTS pos_nf525_sales_business_date_idx ON public.pos_nf525_sales (business_date);
CREATE INDEX IF NOT EXISTS pos_nf525_sales_business_at_idx ON public.pos_nf525_sales (business_at);

CREATE TABLE IF NOT EXISTS public.pos_nf525_sale_lines (
  transaction_id uuid          NOT NULL REFERENCES public.pos_nf525_sales (transaction_id) ON DELETE CASCADE,
  line_no        int           NOT NULL,
  product_id     uuid,                                              -- products.id (sans FK : produit supprimé toléré)
  ean            text,
  label          text          NOT NULL,
  qty            numeric(12,3) NOT NULL,                            -- négative sur un remboursement
  line_ttc       numeric(12,2) NOT NULL,
  line_ht        numeric(12,2) NOT NULL,
  vat_rate       numeric(5,2)  NOT NULL,
  PRIMARY KEY (transaction_id, line_no)
);
COMMENT ON TABLE public.pos_nf525_sale_lines IS
  'POS bridge : lignes des tickets NF525 (marge estimée et top produits du dashboard).';
CREATE INDEX IF NOT EXISTS pos_nf525_sale_lines_product_idx ON public.pos_nf525_sale_lines (product_id);

ALTER TABLE public.pos_nf525_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_nf525_sale_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_nf525_sales FROM anon, authenticated;
REVOKE ALL ON public.pos_nf525_sale_lines FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- pos_record_sales(p_sales jsonb) — service role uniquement.
-- Entrée : [{transaction_id, register_code, ticket_number, kind,
--           refund_of_transaction_id?, business_at, business_date,
--           total_ttc_cents, total_ht_cents, total_vat_cents, vat_breakdown?,
--           payments?, customer_account_id?, signature_status?,
--           lines: [{line_no, product_id?, ean?, label, qty, line_ttc_cents,
--                    line_ht_cents, vat_rate}]}]
-- Sortie : [{transaction_id, applied, already_applied?, error?}]
-- Un ticket invalide est signalé sans bloquer les autres.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_record_sales(p_sales jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_s      jsonb;
  v_id     uuid;
  v_result jsonb := '[]'::jsonb;
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

    IF EXISTS (SELECT 1 FROM public.pos_nf525_sales s WHERE s.transaction_id = v_id) THEN
      UPDATE public.pos_nf525_sales s
      SET signature_status = coalesce(v_s ->> 'signature_status', s.signature_status)
      WHERE s.transaction_id = v_id;
      v_result := v_result || jsonb_build_object('transaction_id', v_id, 'applied', false,
                                                 'already_applied', true);
      CONTINUE;
    END IF;

    BEGIN
      INSERT INTO public.pos_nf525_sales (
        transaction_id, register_code, ticket_number, kind, refund_of_transaction_id,
        business_at, business_date, total_ttc, total_ht, total_vat, vat_breakdown, payments,
        customer_account_id, signature_status)
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
        v_s ->> 'signature_status');

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
      -- Ticket invalide (champ manquant, type) : signalé, les autres passent.
      v_result := v_result || jsonb_build_object('transaction_id', v_id, 'applied', false,
                                                 'error', left(SQLERRM, 200));
    END;
  END LOOP;

  RETURN v_result;
END;
$$;
COMMENT ON FUNCTION public.pos_record_sales(jsonb) IS
  'POS bridge (service role) : enregistre les tickets NF525 non encore reçus (idempotent par transaction_id) ; renvoie [{transaction_id, applied, already_applied?, error?}].';
REVOKE EXECUTE ON FUNCTION public.pos_record_sales(jsonb) FROM PUBLIC, anon, authenticated;

-- Vérification :
--   SELECT count(*), min(business_date), max(business_date) FROM public.pos_nf525_sales;
--   SELECT has_table_privilege('anon', 'public.pos_nf525_sales', 'SELECT');  -- false
-- Rollback :
--   DROP FUNCTION public.pos_record_sales(jsonb);
--   DROP TABLE public.pos_nf525_sale_lines;
--   DROP TABLE public.pos_nf525_sales;
