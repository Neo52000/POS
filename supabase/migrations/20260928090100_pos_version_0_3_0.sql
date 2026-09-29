-- =============================================================================
-- POS — version 0.3.0 (PERIMETRE-NF525.md §4 et §6)
-- -----------------------------------------------------------------------------
-- Ajouts au périmètre fiscal (hash v1, numérotation, calcul des clôtures, JET et
-- archives inchangés) :
--   * RPC pos_x_report (lecture X tracée au JET) et pos_close_period (Z2 / Z3 à
--     la demande, garde-fous avant pos_compute_closing) ;
--   * PWA : mode formation (aucune donnée envoyée au serveur, tickets marqués
--     « FORMATION »), écran Rapports X / Z1 / Z2 / Z3, thème clair / sombre,
--     mode tactile ;
--   * pont (hors périmètre) : imprimantes Star (mPOP), 58 mm, USB.
-- Aligne pos_settings.software (imprimé sur chaque ticket, compliance.version).
-- =============================================================================

UPDATE public.pos_settings
SET value = jsonb_set(value, '{version}', to_jsonb('0.3.0'::text))
WHERE key = 'software'
  AND value ->> 'version' IS DISTINCT FROM '0.3.0';

-- Vérification :
--   SELECT value FROM public.pos_settings WHERE key = 'software';  -- version 0.3.0
-- Rollback :
--   UPDATE public.pos_settings SET value = jsonb_set(value, '{version}', '"0.2.0"') WHERE key = 'software';
