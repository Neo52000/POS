-- POS NF525 : nettoyage des artefacts des tests SQL des lots 4-5 exécutés via le connecteur
-- (apply_migration) : table de résultats et versions zz_pos_test_* dans l'historique des migrations.
-- Idempotent ; les données des caisses TEST-01 et T08-* sont conservées (immutabilité NF525).
DROP TABLE IF EXISTS public.pos_test_results;
DELETE FROM supabase_migrations.schema_migrations WHERE name LIKE 'zz_pos_test_%';
