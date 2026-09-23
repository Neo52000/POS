-- =============================================================================
-- POS NF525 — 0006 (projet « Pos ») : Row Level Security
-- -----------------------------------------------------------------------------
-- * RLS activée sur toutes les tables pos_* ;
-- * SELECT autorisé aux utilisateurs pour lesquels is_pos() est vrai ;
-- * aucune policy d'écriture, sauf pos_registers / pos_settings (is_pos_admin()),
--   pour lesquelles les droits INSERT/UPDATE sont re-accordés à authenticated
--   (retirés globalement en 0003) ; pos_user_roles est géré en 0001 ;
-- * les RPC SECURITY DEFINER (propriétaire postgres, BYPASSRLS) ne sont pas
--   affectées.
-- Idempotent : DROP POLICY IF EXISTS avant chaque CREATE POLICY.
-- =============================================================================

ALTER TABLE public.pos_registers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_counters          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_sessions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_transaction_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_payments          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_stock_sync        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_closings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_events            ENABLE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------ lecture
DROP POLICY IF EXISTS pos_registers_select ON public.pos_registers;
CREATE POLICY pos_registers_select ON public.pos_registers
  FOR SELECT TO authenticated USING (public.is_pos());

DROP POLICY IF EXISTS pos_settings_select ON public.pos_settings;
CREATE POLICY pos_settings_select ON public.pos_settings
  FOR SELECT TO authenticated USING (public.is_pos());

DROP POLICY IF EXISTS pos_counters_select ON public.pos_counters;
CREATE POLICY pos_counters_select ON public.pos_counters
  FOR SELECT TO authenticated USING (public.is_pos());

DROP POLICY IF EXISTS pos_sessions_select ON public.pos_sessions;
CREATE POLICY pos_sessions_select ON public.pos_sessions
  FOR SELECT TO authenticated USING (public.is_pos());

DROP POLICY IF EXISTS pos_transactions_select ON public.pos_transactions;
CREATE POLICY pos_transactions_select ON public.pos_transactions
  FOR SELECT TO authenticated USING (public.is_pos());

DROP POLICY IF EXISTS pos_transaction_lines_select ON public.pos_transaction_lines;
CREATE POLICY pos_transaction_lines_select ON public.pos_transaction_lines
  FOR SELECT TO authenticated USING (public.is_pos());

DROP POLICY IF EXISTS pos_payments_select ON public.pos_payments;
CREATE POLICY pos_payments_select ON public.pos_payments
  FOR SELECT TO authenticated USING (public.is_pos());

DROP POLICY IF EXISTS pos_stock_sync_select ON public.pos_stock_sync;
CREATE POLICY pos_stock_sync_select ON public.pos_stock_sync
  FOR SELECT TO authenticated USING (public.is_pos());

DROP POLICY IF EXISTS pos_closings_select ON public.pos_closings;
CREATE POLICY pos_closings_select ON public.pos_closings
  FOR SELECT TO authenticated USING (public.is_pos());

DROP POLICY IF EXISTS pos_events_select ON public.pos_events;
CREATE POLICY pos_events_select ON public.pos_events
  FOR SELECT TO authenticated USING (public.is_pos());

-- ------------------------------------------- écriture admin (référentiel)
GRANT INSERT, UPDATE ON public.pos_registers TO authenticated;
GRANT INSERT, UPDATE ON public.pos_settings  TO authenticated;

DROP POLICY IF EXISTS pos_registers_admin_insert ON public.pos_registers;
CREATE POLICY pos_registers_admin_insert ON public.pos_registers
  FOR INSERT TO authenticated WITH CHECK (public.is_pos_admin());

DROP POLICY IF EXISTS pos_registers_admin_update ON public.pos_registers;
CREATE POLICY pos_registers_admin_update ON public.pos_registers
  FOR UPDATE TO authenticated USING (public.is_pos_admin()) WITH CHECK (public.is_pos_admin());

DROP POLICY IF EXISTS pos_settings_admin_insert ON public.pos_settings;
CREATE POLICY pos_settings_admin_insert ON public.pos_settings
  FOR INSERT TO authenticated WITH CHECK (public.is_pos_admin());

DROP POLICY IF EXISTS pos_settings_admin_update ON public.pos_settings;
CREATE POLICY pos_settings_admin_update ON public.pos_settings
  FOR UPDATE TO authenticated USING (public.is_pos_admin()) WITH CHECK (public.is_pos_admin());

-- updated_at automatique sur pos_settings
CREATE OR REPLACE FUNCTION public.pos_settings_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_settings_touch() IS 'POS NF525 : trigger BEFORE UPDATE sur pos_settings, met à jour updated_at.';
REVOKE EXECUTE ON FUNCTION public.pos_settings_touch() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pos_settings_touch ON public.pos_settings;
CREATE TRIGGER trg_pos_settings_touch
  BEFORE UPDATE ON public.pos_settings
  FOR EACH ROW EXECUTE FUNCTION public.pos_settings_touch();
