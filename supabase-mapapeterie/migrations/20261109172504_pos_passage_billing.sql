-- =============================================================================
-- POS bridge (projet « ma-papeterie ») — coordonnées de facturation d'un contact de passage
-- -----------------------------------------------------------------------------
-- Une personne de passage qui veut une facture : la caisse saisit l'en-tête
-- (nom / raison sociale, adresse, SIRET, TVA, e-mail) sur la fiche passage_contacts.
-- Hors périmètre fiscal : le ticket NF525 reste inchangé ; l'ERP facture à partir de
-- ces coordonnées (vue pos_transactions_to_invoice).
--
--   passage_contacts.billing                       jsonb nullable
--   pos_passage_billing_get(p_contact_id)          lecture
--   pos_passage_billing_set(p_contact_id, p_billing) écriture validée
--
-- Service role uniquement. Idempotent.
-- =============================================================================

ALTER TABLE public.passage_contacts ADD COLUMN IF NOT EXISTS billing jsonb;
COMMENT ON COLUMN public.passage_contacts.billing IS 'Coordonnées de facturation saisies en caisse : {name, address, postal_code, city, siret, vat_number, email}.';

CREATE OR REPLACE FUNCTION public.pos_passage_billing_get(p_contact_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_billing jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  SELECT coalesce(c.billing, '{}'::jsonb) INTO v_billing
    FROM public.passage_contacts c WHERE c.id = p_contact_id;
  IF NOT FOUND THEN
    PERFORM public.pos_bridge_error('NOT_FOUND', '{"reason":"passage_contact"}'::jsonb);
  END IF;
  RETURN v_billing;
END;
$$;
COMMENT ON FUNCTION public.pos_passage_billing_get(uuid) IS 'POS bridge (service role) : coordonnées de facturation d''un contact de passage ({} si non renseignées). Erreur NOT_FOUND.';

CREATE OR REPLACE FUNCTION public.pos_passage_billing_set(p_contact_id uuid, p_billing jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_key     text;
  v_val     text;
  v_clean   jsonb := '{}'::jsonb;
  v_max     jsonb := '{"name":160,"address":300,"postal_code":16,"city":100,"siret":20,"vat_number":20,"email":160}'::jsonb;
BEGIN
  PERFORM public.pos_bridge_require_service_role();
  IF p_billing IS NULL OR jsonb_typeof(p_billing) <> 'object' THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"billing"}'::jsonb);
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_max) LOOP
    v_val := nullif(btrim(coalesce(p_billing ->> v_key, '')), '');
    IF v_val IS NOT NULL THEN
      IF length(v_val) > (v_max ->> v_key)::int THEN
        PERFORM public.pos_bridge_error('VALIDATION', jsonb_build_object('field', v_key));
      END IF;
      v_clean := v_clean || jsonb_build_object(v_key, v_val);
    END IF;
  END LOOP;
  IF v_clean ->> 'email' IS NOT NULL AND (v_clean ->> 'email') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    PERFORM public.pos_bridge_error('VALIDATION', '{"field":"email"}'::jsonb);
  END IF;
  UPDATE public.passage_contacts SET billing = v_clean, updated_at = now() WHERE id = p_contact_id;
  IF NOT FOUND THEN
    PERFORM public.pos_bridge_error('NOT_FOUND', '{"reason":"passage_contact"}'::jsonb);
  END IF;
  RETURN v_clean;
END;
$$;
COMMENT ON FUNCTION public.pos_passage_billing_set(uuid, jsonb) IS 'POS bridge (service role) : enregistre les coordonnées de facturation d''un contact de passage (clés name, address, postal_code, city, siret, vat_number, email ; valeurs vides ignorées). Erreurs VALIDATION, NOT_FOUND.';

REVOKE EXECUTE ON FUNCTION public.pos_passage_billing_get(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.pos_passage_billing_set(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pos_passage_billing_get(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.pos_passage_billing_set(uuid, jsonb) TO service_role;

-- =============================================================================
-- ROLLBACK :
--   DROP FUNCTION IF EXISTS public.pos_passage_billing_set(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.pos_passage_billing_get(uuid);
--   ALTER TABLE public.passage_contacts DROP COLUMN IF EXISTS billing;
-- =============================================================================
