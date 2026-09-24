-- POS NF525 (projet ma-papeterie) : nettoyage des artefacts des tests SQL du lot 6 exécutés via le
-- connecteur (table de résultats, versions zz_pos_test_* de l'historique). Idempotent ; les
-- mouvements pos_stock_movements de test (effet net nul) sont conservés.
DROP TABLE IF EXISTS public.pos_test_results;
DELETE FROM supabase_migrations.schema_migrations WHERE name LIKE 'zz_pos_test_%';
