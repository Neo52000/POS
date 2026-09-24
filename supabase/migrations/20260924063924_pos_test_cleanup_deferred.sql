-- POS NF525 : nettoyage des artefacts du test SQL 09 (deferred_capture) exécuté via le connecteur :
-- table de résultats et versions zz_pos_test_* de l'historique. Idempotent ; données TEST-01 conservées.
DROP TABLE IF EXISTS public.pos_test_results;
DELETE FROM supabase_migrations.schema_migrations WHERE name LIKE 'zz_pos_test_%';
