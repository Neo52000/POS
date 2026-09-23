-- =============================================================================
-- POS NF525 — 0001 (projet Supabase « Pos ») : extensions, rôles caisse, is_pos()
-- -----------------------------------------------------------------------------
-- Le module POS vit dans un projet Supabase dédié et vide (« Pos »). Les données
-- ma-papeterie (produits, clients, devis, tarifs) ne sont PAS accessibles ici :
-- elles sont interrogées par les Edge Functions de Pos via l'API PostgREST de
-- ma-papeterie (fonctions « bridge », voir supabase-mapapeterie/migrations).
--
-- Cette migration :
--   * active pgcrypto (SHA-256) dans le schéma extensions ; tente pg_cron /
--     pg_net (facultatifs : non activables sur certains plans, le cron 0008
--     est protégé) ;
--   * crée pos_user_roles (rôle caisse par utilisateur auth) ;
--   * crée is_pos(), is_pos_admin(), pos_is_service_role().
-- Idempotent.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_cron;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron non activable ici (%): les jobs 0008 seront ignorés', SQLERRM;
  END;
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_net;   -- impose son schéma « net »
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_net non activable ici (%): les jobs 0008 seront ignorés', SQLERRM;
  END;
END $$;

-- -----------------------------------------------------------------------------
-- pos_user_roles : qui peut utiliser la caisse (pos) / l'administrer (admin)
-- Le premier admin est inséré par le service role (dashboard / MCP).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_user_roles (
  user_id    uuid        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('pos', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pos_user_roles IS 'POS NF525 : rôle caisse par utilisateur (pos = vendeur, admin = administrateur de la caisse).';

-- -----------------------------------------------------------------------------
-- is_pos() : l'appelant peut utiliser la caisse.
--   * session_user <> 'authenticator' : connexion directe (psql, MCP, pg_cron,
--     dashboard) -> opérateur de confiance ;
--   * JWT service_role (Edge Functions) ;
--   * utilisateur authentifié présent dans pos_user_roles (pos ou admin).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_pos()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT session_user <> 'authenticator'
      OR coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      OR EXISTS (SELECT 1 FROM public.pos_user_roles r WHERE r.user_id = auth.uid());
$$;
COMMENT ON FUNCTION public.is_pos() IS 'POS NF525 : vrai si l''appelant peut utiliser la caisse (pos_user_roles, service_role ou connexion directe hors PostgREST).';

CREATE OR REPLACE FUNCTION public.is_pos_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT session_user <> 'authenticator'
      OR coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      OR EXISTS (SELECT 1 FROM public.pos_user_roles r WHERE r.user_id = auth.uid() AND r.role = 'admin');
$$;
COMMENT ON FUNCTION public.is_pos_admin() IS 'POS NF525 : vrai si l''appelant administre la caisse (pos_user_roles.role = admin, service_role ou connexion directe).';

CREATE OR REPLACE FUNCTION public.pos_is_service_role()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      OR session_user <> 'authenticator';
$$;
COMMENT ON FUNCTION public.pos_is_service_role() IS 'POS NF525 : vrai pour le service role (Edge Functions / crons) ou une connexion directe hors PostgREST.';

-- -----------------------------------------------------------------------------
-- RLS pos_user_roles : chacun lit sa ligne, l'admin lit et écrit tout
-- -----------------------------------------------------------------------------
ALTER TABLE public.pos_user_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pos_user_roles FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pos_user_roles TO authenticated;

DROP POLICY IF EXISTS pos_user_roles_select ON public.pos_user_roles;
CREATE POLICY pos_user_roles_select ON public.pos_user_roles
  FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_pos_admin());

DROP POLICY IF EXISTS pos_user_roles_admin_insert ON public.pos_user_roles;
CREATE POLICY pos_user_roles_admin_insert ON public.pos_user_roles
  FOR INSERT TO authenticated WITH CHECK (public.is_pos_admin());

DROP POLICY IF EXISTS pos_user_roles_admin_update ON public.pos_user_roles;
CREATE POLICY pos_user_roles_admin_update ON public.pos_user_roles
  FOR UPDATE TO authenticated USING (public.is_pos_admin()) WITH CHECK (public.is_pos_admin());

DROP POLICY IF EXISTS pos_user_roles_admin_delete ON public.pos_user_roles;
CREATE POLICY pos_user_roles_admin_delete ON public.pos_user_roles
  FOR DELETE TO authenticated USING (public.is_pos_admin());

-- PUBLIC a EXECUTE par défaut sur les fonctions : on le retire et on accorde
-- explicitement aux rôles applicatifs (is_pos() est évalué par les policies RLS).
REVOKE EXECUTE ON FUNCTION public.is_pos(), public.is_pos_admin(), public.pos_is_service_role() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.is_pos(), public.is_pos_admin(), public.pos_is_service_role() TO authenticated, service_role;
