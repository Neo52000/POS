-- =============================================================================
-- POS NF525 : jobs pg_cron alimentés par Vault.
-- ALTER DATABASE ... SET est interdit sur Supabase (rôle postgres non superuser) :
-- l'URL des Edge Functions et la clé service sont lues dans vault.decrypted_secrets.
-- Secrets attendus :
--   * pos_functions_url     : créé ici (URL publique, non sensible)
--   * pos_service_role_key  : à créer UNE FOIS par l'admin (jamais dans une migration) :
--       SELECT vault.create_secret('<service_role_key du projet Pos>', 'pos_service_role_key');
-- Remplace les jobs planifiés par 20260923195244_pos_cron.sql. Idempotent.
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'pos_functions_url') THEN
    PERFORM vault.create_secret('https://jntngwbdsaexustzmaii.supabase.co/functions/v1', 'pos_functions_url', 'URL des Edge Functions du projet Pos (cron)');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.pos_cron_call(p_fn text, p_body jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_url text;
  v_key text;
  v_id  bigint;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'pos_functions_url';
  SELECT decrypted_secret INTO v_key FROM vault.decrypted_secrets WHERE name = 'pos_service_role_key';
  IF v_url IS NULL OR v_key IS NULL THEN
    RAISE NOTICE 'pos_cron_call(%): secrets vault manquants (pos_functions_url / pos_service_role_key)', p_fn;
    RETURN NULL;
  END IF;
  SELECT net.http_post(
    url     := v_url || '/' || p_fn,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body    := coalesce(p_body, '{}'::jsonb),
    timeout_milliseconds := 60000
  ) INTO v_id;
  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.pos_cron_call(text, jsonb) IS 'POS NF525 : appelle une Edge Function pos-* depuis pg_cron (URL et clé service lues dans Vault).';
REVOKE EXECUTE ON FUNCTION public.pos_cron_call(text, jsonb) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_job record;
  v_jobs CONSTANT jsonb := '[
    {"name": "pos-sign-pending",    "schedule": "*/2 * * * *", "fn": "pos-sign-pending",  "body": {"source": "pg_cron"}},
    {"name": "pos-stock-sync",      "schedule": "* * * * *",   "fn": "pos-stock-sync",    "body": {"source": "pg_cron"}},
    {"name": "pos-closings-sync",   "schedule": "0 3 * * *",   "fn": "pos-closings-sync", "body": {"source": "pg_cron"}},
    {"name": "pos-closing-monthly", "schedule": "10 3 1 * *",  "fn": "pos-closing",       "body": {"source": "pg_cron", "period_type": "monthly"}},
    {"name": "pos-closing-annual",  "schedule": "20 3 1 1 *",  "fn": "pos-closing",       "body": {"source": "pg_cron", "period_type": "annual"}}
  ]'::jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    RAISE NOTICE 'pg_cron / pg_net absents : jobs POS non planifiés';
    RETURN;
  END IF;
  FOR v_job IN SELECT * FROM jsonb_to_recordset(v_jobs) AS j(name text, schedule text, fn text, body jsonb) LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = v_job.name) THEN
      PERFORM cron.unschedule(v_job.name);
    END IF;
    PERFORM cron.schedule(v_job.name, v_job.schedule,
      format('SELECT public.pos_cron_call(%L, %L::jsonb)', v_job.fn, v_job.body::text));
  END LOOP;
END $$;
