-- =============================================================================
-- POS — lot d'inventaire partagé entre les postes (projet Pos, HORS PÉRIMÈTRE FISCAL)
-- -----------------------------------------------------------------------------
-- Le lot d'inventaire en cours (comptages saisis, pas encore envoyés à pos-stock-adjust) vivait
-- dans le seul navigateur du poste (Dexie). Il est désormais synchronisé ici : une saisie
-- commencée sur un poste se retrouve et se poursuit sur n'importe quel autre poste administrateur.
--
--   pos_inventory_lines   1 ligne par produit (clé = product_id), réservée aux RPC ci-dessous.
--   pos_inventory_sync    envoie les lignes modifiées du poste (dernière écriture gagnante, par
--                         produit, sur updated_at horodaté par le poste) et renvoie les lignes
--                         modifiées sur le serveur depuis p_since. Les suppressions voyagent comme
--                         lignes `deleted` (retirées après 30 jours).
--
-- Le stock n'est modifié que par pos-stock-adjust (inchangé, idempotent par ligne : la clé
-- d'idempotence suit la ligne d'un poste à l'autre, un double envoi n'applique pas deux fois).
-- Administrateurs de la caisse uniquement. Idempotent.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pos_inventory_lines (
  product_id        uuid        PRIMARY KEY,
  idempotency_key   uuid        NOT NULL,
  label             text        NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  ean               text        CHECK (ean IS NULL OR length(ean) <= 20),
  stock_seen        integer     NOT NULL,
  counted           integer     NOT NULL CHECK (counted >= 0 AND counted <= 999999),
  added_at          timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  deleted           boolean     NOT NULL DEFAULT false,
  server_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by        uuid
);
COMMENT ON TABLE public.pos_inventory_lines IS
  'POS : lot d''inventaire en cours, partagé entre les postes administrateurs (hors périmètre fiscal). Accès par pos_inventory_sync uniquement.';
CREATE INDEX IF NOT EXISTS pos_inventory_lines_server_updated_idx
  ON public.pos_inventory_lines (server_updated_at);

ALTER TABLE public.pos_inventory_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pos_inventory_lines FROM PUBLIC, anon, authenticated;
-- deny-all volontaire : lecture / écriture par la RPC SECURITY DEFINER.

CREATE OR REPLACE FUNCTION public.pos_inventory_sync(
  p_lines jsonb DEFAULT '[]'::jsonb,
  p_since timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_line jsonb;
  v_now  timestamptz := clock_timestamp();
BEGIN
  IF NOT public.is_pos_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN_ROLE' USING ERRCODE = '42501';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) > 1000 THEN
    RAISE EXCEPTION 'VALIDATION' USING ERRCODE = 'P0001', DETAIL = '{"field":"p_lines"}';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO public.pos_inventory_lines (
      product_id, idempotency_key, label, ean, stock_seen, counted,
      added_at, updated_at, deleted, server_updated_at, updated_by)
    VALUES (
      (v_line ->> 'product_id')::uuid,
      (v_line ->> 'idempotency_key')::uuid,
      left(coalesce(nullif(btrim(v_line ->> 'label'), ''), 'Article'), 300),
      nullif(left(coalesce(v_line ->> 'ean', ''), 20), ''),
      (v_line ->> 'stock_seen')::integer,
      (v_line ->> 'counted')::integer,
      (v_line ->> 'added_at')::timestamptz,
      (v_line ->> 'updated_at')::timestamptz,
      coalesce((v_line ->> 'deleted')::boolean, false),
      clock_timestamp(),
      auth.uid())
    ON CONFLICT (product_id) DO UPDATE
      SET idempotency_key   = EXCLUDED.idempotency_key,
          label             = EXCLUDED.label,
          ean               = EXCLUDED.ean,
          stock_seen        = EXCLUDED.stock_seen,
          counted           = EXCLUDED.counted,
          added_at          = EXCLUDED.added_at,
          updated_at        = EXCLUDED.updated_at,
          deleted           = EXCLUDED.deleted,
          server_updated_at = clock_timestamp(),
          updated_by        = EXCLUDED.updated_by
      WHERE EXCLUDED.updated_at > public.pos_inventory_lines.updated_at;
  END LOOP;

  -- Suppressions anciennes : plus aucun poste n'en a besoin.
  DELETE FROM public.pos_inventory_lines
   WHERE deleted AND server_updated_at < v_now - interval '30 days';

  RETURN jsonb_build_object(
    'server_time', v_now,
    'lines', coalesce((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'product_id', l.product_id,
                 'idempotency_key', l.idempotency_key,
                 'label', l.label,
                 'ean', l.ean,
                 'stock_seen', l.stock_seen,
                 'counted', l.counted,
                 'added_at', l.added_at,
                 'updated_at', l.updated_at,
                 'deleted', l.deleted)
               ORDER BY l.server_updated_at)
        FROM public.pos_inventory_lines l
       WHERE p_since IS NULL OR l.server_updated_at > p_since), '[]'::jsonb));
END;
$$;
COMMENT ON FUNCTION public.pos_inventory_sync(jsonb, timestamptz) IS
  'POS : synchronise le lot d''inventaire partagé (admin) : applique les lignes du poste (dernière écriture gagnante par produit) et renvoie celles modifiées depuis p_since. Erreurs FORBIDDEN_ROLE, VALIDATION.';

REVOKE EXECUTE ON FUNCTION public.pos_inventory_sync(jsonb, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pos_inventory_sync(jsonb, timestamptz) TO authenticated, service_role;

-- =============================================================================
-- ROLLBACK :
--   DROP FUNCTION IF EXISTS public.pos_inventory_sync(jsonb, timestamptz);
--   DROP TABLE IF EXISTS public.pos_inventory_lines;
-- =============================================================================
