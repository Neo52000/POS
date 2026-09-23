-- POS NF525 : nettoyage des artefacts des tests SQL exécutés via le connecteur (apply_migration) :
-- table de résultats et versions zz_pos_test_* dans l'historique des migrations.
-- Idempotent ; les données de la caisse TEST-01 sont conservées (immutabilité NF525).
DROP TABLE IF EXISTS public.pos_test_results;
DELETE FROM supabase_migrations.schema_migrations WHERE name LIKE 'zz_pos_test_%';
