-- =============================================================================
-- POS NF525 — 0.4.0 lot 4 : TRUNCATE interdit, compteurs monotones (projet Pos)
-- -----------------------------------------------------------------------------
-- Les triggers ligne (UPDATE/DELETE) ne voient pas TRUNCATE : un TRUNCATE (même
-- par service_role) effaçait tickets, JET ou clôtures sans laisser de trace.
-- 1. Trigger BEFORE TRUNCATE FOR EACH STATEMENT (« NF525: … is immutable ») sur
--    les tables fiscales, les outbox fiscales présentes, pos_settings et
--    pos_registers (paramétrage tracé, lot 3) ; s'applique aussi à TRUNCATE …
--    CASCADE (le trigger de chaque table tronquée est déclenché).
-- 2. REVOKE TRUNCATE de service_role, authenticated et anon sur ces tables.
-- 3. pos_counters : DELETE interdit ; UPDATE accepté seulement si
--    NEW.value = OLD.value + 1 (ni retour arrière, ni saut, ni changement de clé).
-- Hash v1, numérotation et clôtures inchangés. Idempotent.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pos_forbid_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'NF525: % is immutable', TG_TABLE_NAME
    USING ERRCODE = 'P0001',
          DETAIL  = format('{"table":"%s","op":"TRUNCATE"}', TG_TABLE_NAME),
          HINT    = 'Les enregistrements fiscaux NF525 ne peuvent pas être tronqués.';
END;
$$;
COMMENT ON FUNCTION public.pos_forbid_truncate() IS 'POS NF525 : trigger BEFORE TRUNCATE (par instruction) qui interdit de vider une table fiscale.';
REVOKE EXECUTE ON FUNCTION public.pos_forbid_truncate() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_t text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY[
    'pos_transactions', 'pos_transaction_lines', 'pos_payments', 'pos_events', 'pos_closings',
    'pos_sessions', 'pos_archives', 'pos_counters', 'pos_stock_sync',
    'pos_order_settlements', 'pos_document_settlements', 'pos_transaction_passage_contacts',
    'pos_settings', 'pos_registers'
  ] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      RAISE NOTICE 'table % absente : ignorée', v_t;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', 'trg_' || v_t || '_no_truncate', v_t);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.pos_forbid_truncate()',
                   'trg_' || v_t || '_no_truncate', v_t);
    EXECUTE format('REVOKE TRUNCATE ON public.%I FROM service_role, authenticated, anon', v_t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- pos_counters : +1 uniquement, jamais supprimé
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_counters_guard_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.register_id IS DISTINCT FROM OLD.register_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.value IS DISTINCT FROM OLD.value + 1 THEN
    RAISE EXCEPTION 'NF525: pos_counters can only be incremented by 1'
      USING ERRCODE = 'P0001',
            DETAIL  = format('{"table":"pos_counters","register_id":"%s","kind":"%s","old":%s,"new":%s}',
                             OLD.register_id, OLD.kind, OLD.value, coalesce(NEW.value::text, 'null'));
  END IF;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_counters_guard_update() IS 'POS NF525 : trigger BEFORE UPDATE sur pos_counters ; seul value = value + 1 est accepté.';
REVOKE EXECUTE ON FUNCTION public.pos_counters_guard_update() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pos_counters_guard_update ON public.pos_counters;
CREATE TRIGGER trg_pos_counters_guard_update
  BEFORE UPDATE ON public.pos_counters
  FOR EACH ROW EXECUTE FUNCTION public.pos_counters_guard_update();

DROP TRIGGER IF EXISTS trg_pos_counters_no_delete ON public.pos_counters;
CREATE TRIGGER trg_pos_counters_no_delete
  BEFORE DELETE ON public.pos_counters
  FOR EACH ROW EXECUTE FUNCTION public.pos_forbid_change();
