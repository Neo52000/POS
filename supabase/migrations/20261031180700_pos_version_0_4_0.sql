-- =============================================================================
-- POS — version 0.4.0 (PERIMETRE-NF525.md §4 et §6)
-- -----------------------------------------------------------------------------
-- Évolution de nature MAJEURE avant la mise en service (règle §4 : versions 0.x,
-- second chiffre) : effets sur la sécurisation (signature Fiskaly sans repli
-- mock pour une caisse live), l'enregistrement (SESSION_STALE, paramétrage
-- fiscal par RPC tracées, TRUNCATE interdit, compteurs strictement +1,
-- références hors ligne contrôlées) et les clôtures (hash v2 ancrant le JET et
-- les archives). Hash ticket v1, numérotation et format d'archive inchangés.
-- Aligne pos_settings.software (imprimé sur chaque ticket, compliance.version) ;
-- le changement est tracé au JET (settings_change, lot 3) avec ce motif.
-- =============================================================================

DO $$
BEGIN
  PERFORM set_config('pos.change_reason', 'Version 0.4.0 (attestabilité NF525, migration)', true);
  PERFORM set_config('pos.change_via', 'migration', true);
  UPDATE public.pos_settings
  SET value = jsonb_set(value, '{version}', to_jsonb('0.4.0'::text))
  WHERE key = 'software'
    AND value ->> 'version' IS DISTINCT FROM '0.4.0';
  PERFORM set_config('pos.change_reason', '', true);
  PERFORM set_config('pos.change_via', '', true);
END $$;

-- Vérification :
--   SELECT value FROM public.pos_settings WHERE key = 'software';  -- version 0.4.0
--   SELECT register_id, payload FROM public.pos_events
--   WHERE event_type = 'settings_change' AND payload ->> 'key' = 'software' ORDER BY id DESC;
-- Rollback (tracé de la même façon) :
--   UPDATE public.pos_settings SET value = jsonb_set(value, '{version}', '"0.3.0"') WHERE key = 'software';
