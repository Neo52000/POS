-- POS NF525 (projet ma-papeterie) : nettoyage des artefacts des tests SQL exécutés via le connecteur
-- (apply_migration) : table de résultats et versions zz_pos_test_* dans l'historique des migrations.
-- Idempotent ; les mouvements pos_stock_movements de test (effet net nul) sont conservés.
DROP TABLE IF EXISTS public.pos_test_results;
DELETE FROM supabase_migrations.schema_migrations WHERE name LIKE 'zz_pos_test_%';
