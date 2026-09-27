-- =============================================================================
-- POS NF525 — pont des ventes vers le dashboard de ma-papeterie.fr (projet Pos)
-- -----------------------------------------------------------------------------
-- Les ventes de la caisse NF525 alimentent les indicateurs du site (CA boutique,
-- tickets, marge, corrélation météo) : sans ce pont, le dashboard ne voit que
-- Shopify POS et s'éteint à la bascule (BASCULE.md J0).
--
-- HORS PÉRIMÈTRE FISCAL (PERIMETRE-NF525.md §1.2) : ce pont ne fait que LIRE
-- les tables fiscales (pos_transactions, lignes, paiements), après validation.
-- pos_finalize_sale et pos-checkout ne sont pas modifiés : une panne du pont
-- n'affecte jamais une vente, et aucune ré-attestation n'est requise.
--
--   * pos_sales_sync            : journal d'envoi (1 ligne par ticket envoyé ou
--                                 en échec), propre au pont, jamais lu par le
--                                 calcul fiscal.
--   * pos_sales_sync_pending()  : tickets à envoyer (caisses live uniquement),
--                                 au format attendu par pos_record_sales
--                                 (projet ma-papeterie).
--   * pos_sales_sync_mark()     : résultat d'une tentative.
--   * cron pos-sales-sync       : toutes les 5 minutes.
--
-- Caisses de test exclues (fiskaly_env = 'test') : la répétition de la bascule
-- ressaisit sur TEST-01 des ventes déjà comptées côté Shopify POS.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_sales_sync (
  transaction_id uuid        PRIMARY KEY REFERENCES public.pos_transactions (id),
  status         text        NOT NULL CHECK (status IN ('done', 'pending', 'failed')),
  attempts       int         NOT NULL DEFAULT 0,
  last_error     text,
  first_try_at   timestamptz NOT NULL DEFAULT now(),
  done_at        timestamptz
);
COMMENT ON TABLE public.pos_sales_sync IS
  'Pont ventes → ma-papeterie (hors périmètre fiscal) : état d''envoi de chaque ticket vers pos_record_sales. Absence de ligne = jamais tenté.';
CREATE INDEX IF NOT EXISTS pos_sales_sync_status_idx ON public.pos_sales_sync (status);

ALTER TABLE public.pos_sales_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_sales_sync FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- Tickets à envoyer : jamais tentés ou encore `pending`, caisses live, par
-- ordre de réception. Montants en centimes (conversion en euros côté cible).
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
    WHERE (r.fiskaly_env = 'live' OR p_include_test)
      AND (s.transaction_id IS NULL OR s.status = 'pending')
    ORDER BY t.received_at, t.id
    LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000);
END;
$$;
COMMENT ON FUNCTION public.pos_sales_sync_pending(int, boolean) IS
  'Pont ventes (service role, hors périmètre fiscal) : tickets des caisses live à envoyer à ma-papeterie (pos_record_sales), avec lignes et paiements. p_include_test : contrôle manuel uniquement.';
REVOKE EXECUTE ON FUNCTION public.pos_sales_sync_pending(int, boolean) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Résultat d'une tentative : done, ou pending (nouvel essai) jusqu'à 100
-- tentatives, puis failed (visible, plus retenté).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_sales_sync_mark(
  p_transaction_ids uuid[],
  p_ok              boolean,
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
  INSERT INTO public.pos_sales_sync AS s (transaction_id, status, attempts, last_error, done_at)
  SELECT id,
         CASE WHEN p_ok THEN 'done' ELSE 'pending' END,
         1,
         CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
         CASE WHEN p_ok THEN now() END
  FROM unnest(coalesce(p_transaction_ids, '{}'::uuid[])) AS id
  ON CONFLICT (transaction_id) DO UPDATE
  SET attempts   = s.attempts + 1,
      status     = CASE
                     WHEN p_ok THEN 'done'
                     WHEN s.attempts + 1 >= 100 THEN 'failed'
                     ELSE 'pending'
                   END,
      last_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END,
      done_at    = CASE WHEN p_ok THEN now() ELSE s.done_at END
  WHERE s.status <> 'done';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
COMMENT ON FUNCTION public.pos_sales_sync_mark(uuid[], boolean, text) IS
  'Pont ventes (service role) : résultat d''un envoi — done, ou pending jusqu''à 100 tentatives puis failed.';
REVOKE EXECUTE ON FUNCTION public.pos_sales_sync_mark(uuid[], boolean, text) FROM PUBLIC, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Cron : toutes les 5 minutes (le dashboard est journalier ; 5 min suffisent
-- pour un « CA du jour » à jour sans solliciter ma-papeterie à chaque vente).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron absent : job pos-sales-sync non planifié';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pos-sales-sync') THEN
    PERFORM cron.unschedule('pos-sales-sync');
  END IF;
  PERFORM cron.schedule('pos-sales-sync', '*/5 * * * *',
    format('SELECT public.pos_cron_call(%L, %L::jsonb)', 'pos-sales-sync', '{"source":"pg_cron"}'));
END $$;

-- Vérification :
--   SET ROLE service_role; SELECT * FROM public.pos_sales_sync_pending(5, true); RESET ROLE;
--   SELECT status, count(*) FROM public.pos_sales_sync GROUP BY 1;
--   SELECT jobname, schedule FROM cron.job WHERE jobname = 'pos-sales-sync';
-- Rollback :
--   SELECT cron.unschedule('pos-sales-sync');
--   DROP FUNCTION public.pos_sales_sync_mark(uuid[], boolean, text);
--   DROP FUNCTION public.pos_sales_sync_pending(int, boolean);
--   DROP TABLE public.pos_sales_sync;
