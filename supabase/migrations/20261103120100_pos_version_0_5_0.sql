-- =============================================================================
-- POS — version 0.5.0 (PERIMETRE-NF525.md §4 et §6)
-- -----------------------------------------------------------------------------
-- Évolution de nature MAJEURE (règle §4 : versions 0.x, second chiffre) : effet
-- sur l'enregistrement (nouveau registre immuable pos_cash_movements, événement
-- JET cash_movement) et sur les clôtures (espèces attendues de la lecture X et
-- du Z1 incluant les mouvements d'espèces). Chiffre d'affaires, TVA, grand total
-- perpétuel, hash ticket v1, hash de clôture v2, numérotation et format
-- d'archive inchangés.
-- Aligne pos_settings.software (imprimé sur chaque ticket, compliance.version) ;
-- le changement est tracé au JET (settings_change) avec ce motif.
-- =============================================================================

DO $$
BEGIN
  PERFORM set_config('pos.change_reason', 'Version 0.5.0 (mouvements d''espèces, migration)', true);
  PERFORM set_config('pos.change_via', 'migration', true);
  UPDATE public.pos_settings
  SET value = jsonb_set(value, '{version}', to_jsonb('0.5.0'::text))
  WHERE key = 'software'
    AND value ->> 'version' IS DISTINCT FROM '0.5.0';
  PERFORM set_config('pos.change_reason', '', true);
  PERFORM set_config('pos.change_via', '', true);
END $$;

-- Vérification :
--   SELECT value FROM public.pos_settings WHERE key = 'software';  -- version 0.5.0
-- Rollback (tracé de la même façon) :
--   UPDATE public.pos_settings SET value = jsonb_set(value, '{version}', '"0.4.0"') WHERE key = 'software';
