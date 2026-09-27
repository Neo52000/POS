-- =============================================================================
-- POS — version 0.2.0 (MINEURE, PERIMETRE-NF525.md §4)
-- -----------------------------------------------------------------------------
-- Évolutions fonctionnelles sans effet sur l'enregistrement, la sécurisation,
-- la conservation ou l'archivage (hash v1, numérotation, clôtures, JET et
-- archives inchangés) :
--   * PWA : remise globale (répartie sur les lignes, totaux recalculés et
--     contrôlés par pos_finalize_sale), garde-fous de clôture Z, écran client,
--     tickets en attente, favoris, encaissement sans perte de CB, KPI du jour
--     avec météo ;
--   * pont non fiscal pos-sales-sync (lecture seule des tables fiscales).
-- Aligne pos_settings.software (imprimé sur chaque ticket, compliance.version)
-- sur les package.json du périmètre (§5).
-- =============================================================================

UPDATE public.pos_settings
SET value = jsonb_set(value, '{version}', to_jsonb('0.2.0'::text))
WHERE key = 'software'
  AND value ->> 'version' IS DISTINCT FROM '0.2.0';

-- Vérification :
--   SELECT value FROM public.pos_settings WHERE key = 'software';  -- version 0.2.0
-- Rollback :
--   UPDATE public.pos_settings SET value = jsonb_set(value, '{version}', '"0.1.0"') WHERE key = 'software';
