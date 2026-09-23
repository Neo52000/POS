-- =============================================================================
-- POS NF525 — 0008 : jobs pg_cron -> Edge Functions (via pg_net)
-- -----------------------------------------------------------------------------
-- !!! À APPLIQUER MANUELLEMENT, après remplacement du placeholder            !!!
-- !!! '<SERVICE_ROLE_KEY>' par la clé service_role du projet (jamais         !!!
-- !!! commitée). Cette migration est volontairement exclue de l'application  !!!
-- !!! automatique : elle contient un secret une fois renseignée.             !!!
--
-- Alternative recommandée (Supabase Vault) : stocker la clé sous le nom
-- 'pos_service_role_key' puis remplacer le header par
--   'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pos_service_role_key')
-- dans chaque commande.
--
-- Jobs (UTC) :
--   pos-sign-pending    */2 * * * *   rejoue les signatures Fiskaly en attente
--   pos-closings-sync   0 3 * * *     rapprochement clôtures Fiskaly <-> pos_closings
--   pos-closing-monthly 10 3 1 * *    clôture mensuelle (mois précédent)
--   pos-closing-annual  20 3 1 1 *    clôture annuelle (année précédente)
-- Idempotent : chaque job est dé-planifié s'il existe avant d'être replanifié.
-- =============================================================================

-- ---------------------------------------------------------- pos-sign-pending
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pos-sign-pending') THEN
    PERFORM cron.unschedule('pos-sign-pending');
  END IF;
END $$;

SELECT cron.schedule(
  'pos-sign-pending',
  '*/2 * * * *',
  $cmd$
    SELECT net.http_post(
      url     := 'https://mgojmkzovqgpipybelrr.supabase.co/functions/v1/pos-sign-pending',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
      body    := '{"source": "pg_cron"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$
);

-- --------------------------------------------------------- pos-closings-sync
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pos-closings-sync') THEN
    PERFORM cron.unschedule('pos-closings-sync');
  END IF;
END $$;

SELECT cron.schedule(
  'pos-closings-sync',
  '0 3 * * *',
  $cmd$
    SELECT net.http_post(
      url     := 'https://mgojmkzovqgpipybelrr.supabase.co/functions/v1/pos-closings-sync',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
      body    := '{"source": "pg_cron"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$
);

-- ------------------------------------------------------- pos-closing-monthly
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pos-closing-monthly') THEN
    PERFORM cron.unschedule('pos-closing-monthly');
  END IF;
END $$;

SELECT cron.schedule(
  'pos-closing-monthly',
  '10 3 1 * *',
  $cmd$
    SELECT net.http_post(
      url     := 'https://mgojmkzovqgpipybelrr.supabase.co/functions/v1/pos-closing',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
      body    := '{"source": "pg_cron", "period_type": "monthly"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$
);

-- -------------------------------------------------------- pos-closing-annual
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pos-closing-annual') THEN
    PERFORM cron.unschedule('pos-closing-annual');
  END IF;
END $$;

SELECT cron.schedule(
  'pos-closing-annual',
  '20 3 1 1 *',
  $cmd$
    SELECT net.http_post(
      url     := 'https://mgojmkzovqgpipybelrr.supabase.co/functions/v1/pos-closing',
      headers := '{"Content-Type": "application/json", "Authorization": "Bearer <SERVICE_ROLE_KEY>"}'::jsonb,
      body    := '{"source": "pg_cron", "period_type": "annual"}'::jsonb,
      timeout_milliseconds := 60000
    );
  $cmd$
);
