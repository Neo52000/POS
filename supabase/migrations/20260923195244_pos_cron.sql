-- =============================================================================
-- POS NF525 — 0008 (projet « Pos ») : jobs pg_cron -> Edge Functions (pg_net)
-- -----------------------------------------------------------------------------
-- Prérequis (une seule fois, par l'admin, dans le SQL editor du projet Pos) :
--   ALTER DATABASE postgres SET app.settings.functions_url     = 'https://<ref-projet-pos>.supabase.co/functions/v1';
--   ALTER DATABASE postgres SET app.settings.service_role_key  = '<clé service_role du projet Pos>';
-- Les jobs lisent ces paramètres à chaque exécution via current_setting(...,
-- true) : aucun secret dans les migrations. Si pg_cron ou pg_net n'est pas
-- activé (plan Free), cette migration ne fait rien (protégée par DO / IF EXISTS).
--
-- Jobs (UTC) :
--   pos-sign-pending     */2 * * * *   rejoue les signatures Fiskaly en attente
--   pos-stock-sync       * * * * *     pousse l'outbox pos_stock_sync vers ma-papeterie
--   pos-closings-sync    0 3 * * *     rapprochement clôtures Fiskaly <-> pos_closings
--   pos-closing-monthly  10 3 1 * *    clôture mensuelle (mois précédent)
--   pos-closing-annual   20 3 1 1 *    clôture annuelle (année précédente)
-- Idempotent : chaque job est dé-planifié s'il existe avant d'être replanifié.
-- =============================================================================

DO $$
DECLARE
  v_job  record;
  v_jobs CONSTANT jsonb := '[
    {"name": "pos-sign-pending",    "schedule": "*/2 * * * *", "fn": "pos-sign-pending",  "body": {"source": "pg_cron"}},
    {"name": "pos-stock-sync",      "schedule": "* * * * *",   "fn": "pos-stock-sync",    "body": {"source": "pg_cron"}},
    {"name": "pos-closings-sync",   "schedule": "0 3 * * *",   "fn": "pos-closings-sync", "body": {"source": "pg_cron"}},
    {"name": "pos-closing-monthly", "schedule": "10 3 1 * *",  "fn": "pos-closing",       "body": {"source": "pg_cron", "period_type": "monthly"}},
    {"name": "pos-closing-annual",  "schedule": "20 3 1 1 *",  "fn": "pos-closing",       "body": {"source": "pg_cron", "period_type": "annual"}}
  ]'::jsonb;
  v_cmd  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron absent : jobs POS non planifiés';
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_net absent : jobs POS non planifiés';
    RETURN;
  END IF;

  FOR v_job IN SELECT * FROM jsonb_to_recordset(v_jobs) AS j(name text, schedule text, fn text, body jsonb) LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job.name) THEN
      PERFORM cron.unschedule(v_job.name);
    END IF;

    -- Commande exécutée par pg_cron : URL et clé lues au moment de l'exécution.
    v_cmd := format(
      $cmd$SELECT net.http_post(
        url     := current_setting('app.settings.functions_url', true) || '/%s',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)),
        body    := %L::jsonb,
        timeout_milliseconds := 60000
      )$cmd$,
      v_job.fn, v_job.body::text);

    PERFORM cron.schedule(v_job.name, v_job.schedule, v_cmd);
    RAISE NOTICE 'job % planifié (%)', v_job.name, v_job.schedule;
  END LOOP;
END $$;
