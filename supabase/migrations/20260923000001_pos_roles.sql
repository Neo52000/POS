-- =============================================================================
-- POS NF525 — 0001 : rôle applicatif « pos »
-- -----------------------------------------------------------------------------
-- Ajoute la valeur 'pos' à l'enum public.app_role (existant : admin, user).
-- Cette migration est volontairement isolée : une valeur d'enum ajoutée par
-- ALTER TYPE ... ADD VALUE ne peut pas être référencée dans la même
-- transaction. La fonction is_pos() (qui utilise 'pos'::app_role) est donc
-- créée dans la migration suivante (20260923000002_pos_schema.sql).
-- Idempotent : IF NOT EXISTS.
-- =============================================================================

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'pos';
