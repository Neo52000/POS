-- =============================================================================
-- POS NF525 — 0007 (projet « Pos ») : vues d'exploitation
-- -----------------------------------------------------------------------------
-- * pos_transactions_to_invoice : ventes avec « facture pro » demandée, pour
--   rapprochement par l'ERP (ma-papeterie) — V1 : ticket + rapprochement, pas
--   de création de sales_orders depuis le POS (plan A11).
-- * pos_daily_summary : synthèse par caisse et date métier (compteurs, totaux,
--   ventilation par moyen de paiement).
-- Les deux vues sont security_invoker : la RLS de pos_transactions s'applique
-- (lecture réservée à is_pos()).
-- =============================================================================

CREATE OR REPLACE VIEW public.pos_transactions_to_invoice
WITH (security_invoker = true)
AS
SELECT
  t.id                                   AS transaction_id,
  r.code                                 AS register_code,
  t.ticket_number,
  t.business_at,
  t.business_date,
  t.customer_account_id,
  t.customer_snapshot,
  t.customer_snapshot ->> 'display_name' AS customer_display_name,
  t.customer_snapshot ->> 'company_name' AS customer_company_name,
  t.customer_snapshot ->> 'siret'        AS customer_siret,
  t.customer_snapshot ->> 'vat_number'   AS customer_vat_number,
  t.quote_id,
  t.total_ht_cents,
  t.total_vat_cents,
  t.total_ttc_cents,
  t.vat_breakdown,
  t.signature_status,
  t.hash,
  t.received_at,
  EXISTS (SELECT 1 FROM public.pos_transactions rf WHERE rf.refund_of_transaction_id = t.id) AS has_refunds
FROM public.pos_transactions t
JOIN public.pos_registers r ON r.id = t.register_id
WHERE t.kind = 'sale'
  AND t.invoice_requested;
COMMENT ON VIEW public.pos_transactions_to_invoice IS 'POS NF525 : ventes avec facture pro demandée (invoice_requested), avec snapshot client, pour rapprochement ERP.';

CREATE OR REPLACE VIEW public.pos_daily_summary
WITH (security_invoker = true)
AS
WITH pay AS (
  SELECT t.register_id, t.business_date, p.method, sum(p.amount_cents)::bigint AS amount_cents
  FROM public.pos_payments p
  JOIN public.pos_transactions t ON t.id = p.transaction_id
  GROUP BY t.register_id, t.business_date, p.method
)
SELECT
  t.register_id,
  r.code                                                              AS register_code,
  t.business_date,
  count(*)::int                                                       AS txn_count,
  count(*) FILTER (WHERE t.kind = 'sale')::int                        AS sales_count,
  count(*) FILTER (WHERE t.kind = 'refund')::int                      AS refunds_count,
  min(t.ticket_number)                                                AS first_ticket_number,
  max(t.ticket_number)                                                AS last_ticket_number,
  sum(t.total_ht_cents)::bigint                                       AS total_ht_cents,
  sum(t.total_vat_cents)::bigint                                      AS total_vat_cents,
  sum(t.total_ttc_cents)::bigint                                      AS total_ttc_cents,
  coalesce(sum(t.total_ttc_cents) FILTER (WHERE t.kind = 'refund'), 0)::bigint AS refunds_ttc_cents,
  sum(t.change_cents)::bigint                                         AS change_cents,
  coalesce((SELECT amount_cents FROM pay WHERE pay.register_id = t.register_id AND pay.business_date = t.business_date AND pay.method = 'cb'), 0)        AS cb_cents,
  coalesce((SELECT amount_cents FROM pay WHERE pay.register_id = t.register_id AND pay.business_date = t.business_date AND pay.method = 'cash'), 0)      AS cash_cents,
  coalesce((SELECT amount_cents FROM pay WHERE pay.register_id = t.register_id AND pay.business_date = t.business_date AND pay.method = 'cheque'), 0)    AS cheque_cents,
  coalesce((SELECT amount_cents FROM pay WHERE pay.register_id = t.register_id AND pay.business_date = t.business_date AND pay.method = 'gift_ucia'), 0) AS gift_ucia_cents,
  coalesce((SELECT amount_cents FROM pay WHERE pay.register_id = t.register_id AND pay.business_date = t.business_date AND pay.method = 'transfer'), 0)  AS transfer_cents,
  count(*) FILTER (WHERE t.signature_status <> 'signed')::int         AS unsigned_count
FROM public.pos_transactions t
JOIN public.pos_registers r ON r.id = t.register_id
GROUP BY t.register_id, r.code, t.business_date;
COMMENT ON VIEW public.pos_daily_summary IS 'POS NF525 : synthèse par caisse et date métier (Europe/Paris) : nombre de tickets, totaux, remboursements, rendu monnaie, ventilation par moyen de paiement, tickets non signés.';

REVOKE ALL ON public.pos_transactions_to_invoice, public.pos_daily_summary FROM anon;
GRANT SELECT ON public.pos_transactions_to_invoice, public.pos_daily_summary TO authenticated, service_role;
