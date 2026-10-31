-- =============================================================================
-- POS NF525 — test SQL (projet « ma-papeterie ») : contacts de passage
-- -----------------------------------------------------------------------------
-- pos_passage_upsert (création, reprise par téléphone, validation),
-- pos_passage_lookup (nom, téléphone tous formats, contacts basculés exclus),
-- pos_passage_open_orders (filtre contact), pos_customer_lookup (fiche passage
-- exclue), pos_record_sales (passage_contact_id posé puis complété), droits.
-- Aucun effet persistant : le bloc se termine par l'exception ALL_OK qui
-- annule toutes les écritures (résultat attendu : ALL_OK).
-- =============================================================================
DO $$
DECLARE
  v_passage uuid;
  v_a       jsonb;
  v_b       jsonb;
  v_other   uuid;
  v_order   uuid;
  v_txn     uuid := gen_random_uuid();
  v_open    jsonb;
  v_n       int;
  v_raised  boolean;
BEGIN
  IF has_function_privilege('anon', 'public.pos_passage_upsert(text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_passage_lookup(text, int)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pos_passage_open_orders(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'droits trop ouverts';
  END IF;
  SELECT id INTO v_passage FROM public.customer_accounts WHERE is_passage;
  IF v_passage IS NULL THEN RAISE EXCEPTION 'fiche passage absente'; END IF;

  -- Création puis reprise par téléphone (autre format)
  v_a := public.pos_passage_upsert('Zoé Testcaisse', '06 98 76 54 32');
  IF (v_a ->> 'existing')::boolean OR (v_a ->> 'passage_account_id')::uuid <> v_passage THEN
    RAISE EXCEPTION 'création KO : %', v_a;
  END IF;
  v_b := public.pos_passage_upsert('Zoé T.', '+33 6 98 76 54 32');
  IF NOT (v_b ->> 'existing')::boolean OR v_b ->> 'id' <> v_a ->> 'id' THEN
    RAISE EXCEPTION 'reprise par téléphone KO : %', v_b;
  END IF;
  v_raised := false;
  BEGIN PERFORM public.pos_passage_upsert('  ', NULL);
  EXCEPTION WHEN OTHERS THEN v_raised := true; END;
  IF NOT v_raised THEN RAISE EXCEPTION 'nom vide accepté'; END IF;
  v_raised := false;
  BEGIN PERFORM public.pos_passage_upsert('X', '12');
  EXCEPTION WHEN OTHERS THEN v_raised := true; END;
  IF NOT v_raised THEN RAISE EXCEPTION 'téléphone invalide accepté'; END IF;

  -- Recherche nom / téléphone
  SELECT count(*) INTO v_n FROM public.pos_passage_lookup('testcaisse', 10) l WHERE l.id = (v_a ->> 'id')::uuid;
  IF v_n <> 1 THEN RAISE EXCEPTION 'recherche nom KO'; END IF;
  SELECT count(*) INTO v_n FROM public.pos_passage_lookup('0698 76', 10) l WHERE l.id = (v_a ->> 'id')::uuid;
  IF v_n <> 1 THEN RAISE EXCEPTION 'recherche téléphone KO'; END IF;

  -- Commandes du contact uniquement
  INSERT INTO public.passage_contacts (full_name) VALUES ('Autre Testcaisse') RETURNING id INTO v_other;
  INSERT INTO public.sales_orders (account_id, customer_email, origin, status, passage_contact_id, total_ttc)
    VALUES (v_passage, 'client.caisse@ma-papeterie.fr', 'erp', 'confirmed', (v_a ->> 'id')::uuid, 12) RETURNING id INTO v_order;
  INSERT INTO public.sales_orders (account_id, customer_email, origin, status, passage_contact_id, total_ttc)
    VALUES (v_passage, 'client.caisse@ma-papeterie.fr', 'erp', 'confirmed', v_other, 34);
  v_open := public.pos_passage_open_orders((v_a ->> 'id')::uuid);
  IF jsonb_array_length(v_open) <> 1 OR (v_open -> 0 ->> 'id')::uuid <> v_order THEN
    RAISE EXCEPTION 'open orders KO : %', v_open;
  END IF;
  SELECT l.open_orders_count INTO v_n FROM public.pos_passage_lookup('testcaisse', 10) l WHERE l.id = (v_a ->> 'id')::uuid;
  IF v_n <> 1 THEN RAISE EXCEPTION 'open_orders_count KO : %', v_n; END IF;

  -- Fiche passage absente de la recherche client pro
  IF EXISTS (SELECT 1 FROM public.pos_customer_lookup('client passage', 50) c WHERE c.id = v_passage) THEN
    RAISE EXCEPTION 'fiche passage exposée par pos_customer_lookup';
  END IF;

  -- Ticket : sans contact, puis complété par la synchro suivante
  PERFORM public.pos_record_sales(jsonb_build_array(jsonb_build_object(
    'transaction_id', v_txn, 'register_code', 'TEST-PASSAGE', 'ticket_number', 999999001,
    'kind', 'sale', 'business_at', now(), 'business_date', current_date,
    'total_ttc_cents', 1200, 'total_ht_cents', 1000, 'total_vat_cents', 200,
    'customer_account_id', v_passage, 'lines', '[]'::jsonb)));
  IF (SELECT passage_contact_id FROM public.pos_nf525_sales WHERE transaction_id = v_txn) IS NOT NULL THEN
    RAISE EXCEPTION 'contact posé à tort';
  END IF;
  PERFORM public.pos_record_sales(jsonb_build_array(jsonb_build_object(
    'transaction_id', v_txn, 'passage_contact_id', v_a ->> 'id')));
  IF (SELECT passage_contact_id FROM public.pos_nf525_sales WHERE transaction_id = v_txn) <> (v_a ->> 'id')::uuid THEN
    RAISE EXCEPTION 'complément contact KO';
  END IF;

  -- Contact basculé : plus proposé
  PERFORM public.convert_passage_contact((v_a ->> 'id')::uuid);
  IF EXISTS (SELECT 1 FROM public.pos_passage_lookup('testcaisse', 10) l WHERE l.id = (v_a ->> 'id')::uuid) THEN
    RAISE EXCEPTION 'contact basculé encore proposé';
  END IF;
  IF (SELECT customer_account_id FROM public.pos_nf525_sales WHERE transaction_id = v_txn) = v_passage THEN
    RAISE EXCEPTION 'ticket non déplacé à la bascule';
  END IF;

  RAISE EXCEPTION 'ALL_OK';
END;
$$;
