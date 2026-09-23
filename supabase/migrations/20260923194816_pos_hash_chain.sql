-- =============================================================================
-- POS NF525 — 0004 : chaînage SHA-256 (tickets, clôtures, événements)
-- -----------------------------------------------------------------------------
-- Implémente docs/SPEC.md §3 (chaîne canonique v1), miroir de
-- packages/core/src/hashChain.ts. Toute divergence TS/SQL est un bug : les
-- vecteurs packages/core/src/__fixtures__/hash-vectors.json sont vérifiés par
-- scripts/sql-tests/03_hash_vectors.sql.
--
-- Deux familles de fonctions, volontairement construites l'une sur l'autre :
--   * variantes « from_json » (pures, IMMUTABLE) utilisées par pos_finalize_sale
--     pour calculer le hash AVANT l'insertion (les triggers d'immutabilité
--     interdisent un UPDATE ultérieur du hash) ;
--   * variantes par transaction_id (STABLE) utilisées par pos_verify_chain,
--     qui relisent les lignes/paiements en base et délèguent aux versions JSON.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pos_sha256(text) : SHA-256 hex minuscules d'une chaîne UTF-8
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_sha256(p_input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT encode(extensions.digest(convert_to(coalesce(p_input, ''), 'UTF8'), 'sha256'), 'hex');
$$;
COMMENT ON FUNCTION public.pos_sha256(text) IS 'POS NF525 : SHA-256 hexadécimal (minuscules) de la chaîne UTF-8 (pgcrypto).';

-- -----------------------------------------------------------------------------
-- pos_canonical_qty(numeric) : nombre sans zéros inutiles (1, 2.5, -1, 0.125)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_canonical_qty(p_qty numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT CASE WHEN p_qty < 0 THEN '-' ELSE '' END
      || trim(trailing '.' from trim(trailing '0' from to_char(abs(p_qty), 'FM999999990.000')));
$$;
COMMENT ON FUNCTION public.pos_canonical_qty(numeric) IS 'POS NF525 : quantité au format canonique du hash (3 décimales max, sans zéros inutiles ; ex. 1, 2.5, -1).';

-- -----------------------------------------------------------------------------
-- pos_canonical_discount(numeric) / pos_canonical_rate(numeric) : 2 décimales
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_canonical_discount(p_discount numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT to_char(coalesce(p_discount, 0), 'FM990.00');
$$;
COMMENT ON FUNCTION public.pos_canonical_discount(numeric) IS 'POS NF525 : remise en % au format canonique à 2 décimales (0.00, 10.00, 100.00).';

CREATE OR REPLACE FUNCTION public.pos_canonical_rate(p_rate numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT to_char(coalesce(p_rate, 0), 'FM990.00');
$$;
COMMENT ON FUNCTION public.pos_canonical_rate(numeric) IS 'POS NF525 : taux de TVA au format canonique à 2 décimales (20.00, 5.50, 0.00).';

-- -----------------------------------------------------------------------------
-- pos_canonical_ts(timestamptz) : ISO 8601 UTC avec millisecondes
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_canonical_ts(p_ts timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
COMMENT ON FUNCTION public.pos_canonical_ts(timestamptz) IS 'POS NF525 : horodatage canonique ISO 8601 UTC avec millisecondes (2026-09-23T14:05:07.123Z).';

-- -----------------------------------------------------------------------------
-- pos_canonical_vat_breakdown(jsonb) : "rate:base_ht:vat:ttc;..." trié par taux
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_canonical_vat_breakdown(p_breakdown jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT coalesce(
    string_agg(
      public.pos_canonical_rate((e ->> 'rate')::numeric)
        || ':' || (e ->> 'base_ht_cents')::bigint
        || ':' || (e ->> 'vat_cents')::bigint
        || ':' || (e ->> 'ttc_cents')::bigint,
      ';' ORDER BY (e ->> 'rate')::numeric
    ),
    ''
  )
  FROM jsonb_array_elements(coalesce(p_breakdown, '[]'::jsonb)) AS e;
$$;
COMMENT ON FUNCTION public.pos_canonical_vat_breakdown(jsonb) IS 'POS NF525 : ventilation TVA canonique (groupes triés numériquement par taux, rate:base_ht:vat:ttc joints par ;).';

-- -----------------------------------------------------------------------------
-- pos_lines_digest_from_json(jsonb) : SHA-256 des lignes (SPEC §3)
-- Attend [{line_no, product_id?, ean?, label, qty, unit_price_ttc_cents,
--          vat_rate, discount_percent, line_ttc_cents}]
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_lines_digest_from_json(p_lines jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.pos_sha256(coalesce(
    string_agg(
      (l ->> 'line_no')::int
        || '|' || coalesce(l ->> 'product_id', '')
        || '|' || coalesce(l ->> 'ean', '')
        || '|' || coalesce(l ->> 'label', '')
        || '|' || public.pos_canonical_qty((l ->> 'qty')::numeric)
        || '|' || (l ->> 'unit_price_ttc_cents')::bigint
        || '|' || public.pos_canonical_rate((l ->> 'vat_rate')::numeric)
        || '|' || public.pos_canonical_discount((l ->> 'discount_percent')::numeric)
        || '|' || (l ->> 'line_ttc_cents')::bigint,
      E'\n' ORDER BY (l ->> 'line_no')::int
    ),
    ''
  ))
  FROM jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) AS l;
$$;
COMMENT ON FUNCTION public.pos_lines_digest_from_json(jsonb) IS 'POS NF525 : lines_digest (SHA-256) calculé depuis un tableau JSON de lignes déjà calculées (utilisé avant insertion).';

-- -----------------------------------------------------------------------------
-- pos_payments_digest_from_json(jsonb) : SHA-256 des paiements (SPEC §3)
-- Attend [{method, amount_cents, reference?}]
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_payments_digest_from_json(p_payments jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.pos_sha256(coalesce(
    string_agg(
      (p ->> 'method')
        || '|' || (p ->> 'amount_cents')::bigint
        || '|' || coalesce(p ->> 'reference', ''),
      E'\n' ORDER BY (p ->> 'method') COLLATE "C", (p ->> 'amount_cents')::bigint, coalesce(p ->> 'reference', '') COLLATE "C"
    ),
    ''
  ))
  FROM jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) AS p;
$$;
COMMENT ON FUNCTION public.pos_payments_digest_from_json(jsonb) IS 'POS NF525 : payments_digest (SHA-256) depuis un tableau JSON de paiements, triés (method, amount_cents, reference).';

-- -----------------------------------------------------------------------------
-- Variantes par transaction_id (relecture des tables)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_lines_digest(p_transaction_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.pos_lines_digest_from_json((
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'line_no', l.line_no,
      'product_id', l.product_id,
      'ean', l.ean,
      'label', l.label,
      'qty', l.qty,
      'unit_price_ttc_cents', l.unit_price_ttc_cents,
      'vat_rate', l.vat_rate,
      'discount_percent', l.discount_percent,
      'line_ttc_cents', l.line_ttc_cents
    )), '[]'::jsonb)
    FROM public.pos_transaction_lines l
    WHERE l.transaction_id = p_transaction_id
  ));
$$;
COMMENT ON FUNCTION public.pos_lines_digest(uuid) IS 'POS NF525 : lines_digest recalculé depuis pos_transaction_lines (vérification de chaîne).';

CREATE OR REPLACE FUNCTION public.pos_payments_digest(p_transaction_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.pos_payments_digest_from_json((
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'method', p.method,
      'amount_cents', p.amount_cents,
      'reference', p.reference
    )), '[]'::jsonb)
    FROM public.pos_payments p
    WHERE p.transaction_id = p_transaction_id
  ));
$$;
COMMENT ON FUNCTION public.pos_payments_digest(uuid) IS 'POS NF525 : payments_digest recalculé depuis pos_payments (vérification de chaîne).';

-- -----------------------------------------------------------------------------
-- pos_build_canonical_txn(...) : chaîne canonique v1 à partir de ses composants
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_build_canonical_txn(
  p_ticket_number       bigint,
  p_register_code       text,
  p_client_txn_id       uuid,
  p_business_at         timestamptz,
  p_kind                text,
  p_total_ht_cents      bigint,
  p_total_vat_cents     bigint,
  p_total_ttc_cents     bigint,
  p_vat_breakdown       jsonb,
  p_customer_account_id uuid,
  p_lines_digest        text,
  p_payments_digest     text,
  p_prev_hash           text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT 'v1'
    || '|' || p_ticket_number
    || '|' || p_register_code
    || '|' || p_client_txn_id::text
    || '|' || public.pos_canonical_ts(p_business_at)
    || '|' || p_kind
    || '|' || p_total_ht_cents
    || '|' || p_total_vat_cents
    || '|' || p_total_ttc_cents
    || '|' || public.pos_canonical_vat_breakdown(p_vat_breakdown)
    || '|' || coalesce(p_customer_account_id::text, '')
    || '|' || p_lines_digest
    || '|' || p_payments_digest
    || '|' || coalesce(p_prev_hash, '');
$$;
COMMENT ON FUNCTION public.pos_build_canonical_txn(bigint, text, uuid, timestamptz, text, bigint, bigint, bigint, jsonb, uuid, text, text, text) IS
  'POS NF525 : chaîne canonique v1 d''un ticket (SPEC §3) construite depuis ses composants (utilisée avant insertion).';

-- -----------------------------------------------------------------------------
-- pos_canonical_txn(uuid) : chaîne canonique v1 relue depuis la base
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_canonical_txn(p_transaction_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.pos_build_canonical_txn(
    t.ticket_number,
    r.code,
    t.client_txn_id,
    t.business_at,
    t.kind,
    t.total_ht_cents,
    t.total_vat_cents,
    t.total_ttc_cents,
    t.vat_breakdown,
    t.customer_account_id,
    public.pos_lines_digest(t.id),
    public.pos_payments_digest(t.id),
    t.prev_hash
  )
  FROM public.pos_transactions t
  JOIN public.pos_registers r ON r.id = t.register_id
  WHERE t.id = p_transaction_id;
$$;
COMMENT ON FUNCTION public.pos_canonical_txn(uuid) IS 'POS NF525 : chaîne canonique v1 d''un ticket relue depuis pos_transactions/lines/payments (hash = pos_sha256(...)).';

CREATE OR REPLACE FUNCTION public.pos_compute_txn_hash(p_transaction_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.pos_sha256(public.pos_canonical_txn(p_transaction_id));
$$;
COMMENT ON FUNCTION public.pos_compute_txn_hash(uuid) IS 'POS NF525 : hash recalculé d''un ticket (doit être égal à pos_transactions.hash).';

-- -----------------------------------------------------------------------------
-- pos_verify_chain(register, from, to) : vérifie hash, prev_hash et continuité
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_verify_chain(
  p_register_id uuid,
  p_from        bigint DEFAULT NULL,
  p_to          bigint DEFAULT NULL
)
RETURNS TABLE (
  ok                 boolean,
  checked            int,
  first_break_ticket bigint,
  expected_hash      text,
  actual_hash        text,
  reason             text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_row            record;
  v_prev_hash      text;
  v_prev_ticket    bigint;
  v_recomputed     text;
  v_count          int := 0;
BEGIN
  IF NOT public.is_pos() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE';
  END IF;

  -- Point de départ : hash du ticket précédant p_from (ou '' si début de chaîne)
  IF p_from IS NULL OR p_from <= 1 THEN
    v_prev_hash   := '';
    v_prev_ticket := 0;
  ELSE
    SELECT t.hash, t.ticket_number INTO v_prev_hash, v_prev_ticket
    FROM public.pos_transactions t
    WHERE t.register_id = p_register_id AND t.ticket_number = p_from - 1;
    IF NOT FOUND THEN
      ok := false; checked := 0; first_break_ticket := p_from - 1;
      expected_hash := NULL; actual_hash := NULL; reason := 'MISSING_PREVIOUS_TICKET';
      RETURN NEXT; RETURN;
    END IF;
  END IF;

  FOR v_row IN
    SELECT t.id, t.ticket_number, t.prev_hash, t.hash
    FROM public.pos_transactions t
    WHERE t.register_id = p_register_id
      AND (p_from IS NULL OR t.ticket_number >= p_from)
      AND (p_to   IS NULL OR t.ticket_number <= p_to)
    ORDER BY t.ticket_number
  LOOP
    -- continuité de la numérotation
    IF v_row.ticket_number <> v_prev_ticket + 1 THEN
      ok := false; checked := v_count; first_break_ticket := v_row.ticket_number;
      expected_hash := NULL; actual_hash := NULL;
      reason := format('TICKET_GAP: expected %s, found %s', v_prev_ticket + 1, v_row.ticket_number);
      RETURN NEXT; RETURN;
    END IF;

    -- chaînage
    IF coalesce(v_row.prev_hash, '') <> coalesce(v_prev_hash, '') THEN
      ok := false; checked := v_count; first_break_ticket := v_row.ticket_number;
      expected_hash := v_prev_hash; actual_hash := v_row.prev_hash; reason := 'PREV_HASH_MISMATCH';
      RETURN NEXT; RETURN;
    END IF;

    -- intégrité du contenu
    v_recomputed := public.pos_compute_txn_hash(v_row.id);
    IF v_recomputed <> v_row.hash THEN
      ok := false; checked := v_count; first_break_ticket := v_row.ticket_number;
      expected_hash := v_recomputed; actual_hash := v_row.hash; reason := 'HASH_MISMATCH';
      RETURN NEXT; RETURN;
    END IF;

    v_prev_hash   := v_row.hash;
    v_prev_ticket := v_row.ticket_number;
    v_count       := v_count + 1;
  END LOOP;

  ok := true; checked := v_count; first_break_ticket := NULL;
  expected_hash := NULL; actual_hash := NULL; reason := NULL;
  RETURN NEXT;
  RETURN;
END;
$$;
COMMENT ON FUNCTION public.pos_verify_chain(uuid, bigint, bigint) IS
  'POS NF525 : vérifie la chaîne d''une caisse (numérotation continue, prev_hash, hash recalculé). Renvoie une ligne (ok, checked, première rupture, raison).';

-- -----------------------------------------------------------------------------
-- Journal des événements : chaînage BEFORE INSERT sur pos_events
--   hash = SHA-256("v1|id|register_id|event_type|payload::text|created_at ISO|prev_hash")
-- L'id est réassigné sous verrou global (max+1) pour garantir que l'ordre des
-- id est aussi l'ordre de chaînage ; l'identity ne sert que de secours.
-- event_number = compteur continu par caisse (pos_counters.event).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_event_hash(
  p_id          bigint,
  p_register_id uuid,
  p_event_type  text,
  p_payload     jsonb,
  p_created_at  timestamptz,
  p_prev_hash   text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
  SELECT public.pos_sha256(
    'v1|' || p_id
    || '|' || coalesce(p_register_id::text, '')
    || '|' || p_event_type
    || '|' || coalesce(p_payload::text, '')
    || '|' || public.pos_canonical_ts(p_created_at)
    || '|' || coalesce(p_prev_hash, '')
  );
$$;
COMMENT ON FUNCTION public.pos_event_hash(bigint, uuid, text, jsonb, timestamptz, text) IS 'POS NF525 : hash d''un événement du JET (SPEC §3, calculé uniquement côté SQL).';

CREATE OR REPLACE FUNCTION public.pos_events_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  -- Sérialisation globale des insertions d'événements (faible volume)
  PERFORM pg_advisory_xact_lock(hashtext('pos_events'));

  NEW.id         := (SELECT coalesce(max(e.id), 0) + 1 FROM public.pos_events e);
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.payload    := coalesce(NEW.payload, '{}'::jsonb);

  -- Chaîne par caisse (les événements sans caisse forment leur propre chaîne)
  SELECT e.hash INTO NEW.prev_hash
  FROM public.pos_events e
  WHERE e.register_id IS NOT DISTINCT FROM NEW.register_id
  ORDER BY e.id DESC
  LIMIT 1;
  NEW.prev_hash := coalesce(NEW.prev_hash, '');

  -- Numéro continu par caisse
  IF NEW.register_id IS NOT NULL THEN
    UPDATE public.pos_counters
    SET value = value + 1
    WHERE register_id = NEW.register_id AND kind = 'event'
    RETURNING value INTO NEW.event_number;
  ELSE
    NEW.event_number := NULL;
  END IF;

  NEW.hash := public.pos_event_hash(NEW.id, NEW.register_id, NEW.event_type, NEW.payload, NEW.created_at, NEW.prev_hash);
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_events_before_insert() IS 'POS NF525 : trigger BEFORE INSERT sur pos_events ; assigne id continu, event_number, prev_hash et hash sous verrou.';

DROP TRIGGER IF EXISTS trg_pos_events_before_insert ON public.pos_events;
CREATE TRIGGER trg_pos_events_before_insert
  BEFORE INSERT ON public.pos_events
  FOR EACH ROW EXECUTE FUNCTION public.pos_events_before_insert();

-- -----------------------------------------------------------------------------
-- pos_verify_events_chain(register) : vérification du JET d'une caisse
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pos_verify_events_chain(p_register_id uuid)
RETURNS TABLE (
  ok             boolean,
  checked        int,
  first_break_id bigint,
  reason         text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_row       record;
  v_prev_hash text := '';
  v_count     int := 0;
BEGIN
  IF NOT public.is_pos() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'FORBIDDEN_ROLE';
  END IF;

  FOR v_row IN
    SELECT e.id, e.register_id, e.event_type, e.payload, e.created_at, e.prev_hash, e.hash
    FROM public.pos_events e
    WHERE e.register_id IS NOT DISTINCT FROM p_register_id
    ORDER BY e.id
  LOOP
    IF coalesce(v_row.prev_hash, '') <> v_prev_hash THEN
      ok := false; checked := v_count; first_break_id := v_row.id; reason := 'PREV_HASH_MISMATCH';
      RETURN NEXT; RETURN;
    END IF;
    IF public.pos_event_hash(v_row.id, v_row.register_id, v_row.event_type, v_row.payload, v_row.created_at, v_row.prev_hash) <> v_row.hash THEN
      ok := false; checked := v_count; first_break_id := v_row.id; reason := 'HASH_MISMATCH';
      RETURN NEXT; RETURN;
    END IF;
    v_prev_hash := v_row.hash;
    v_count := v_count + 1;
  END LOOP;

  ok := true; checked := v_count; first_break_id := NULL; reason := NULL;
  RETURN NEXT;
  RETURN;
END;
$$;
COMMENT ON FUNCTION public.pos_verify_events_chain(uuid) IS 'POS NF525 : vérifie la chaîne du journal des événements (JET) d''une caisse (NULL = événements globaux).';

REVOKE EXECUTE ON FUNCTION public.pos_events_before_insert() FROM PUBLIC, anon, authenticated;

-- Fonctions de hash : pures, exécutables par les rôles applicatifs (vérification côté client autorisée)
REVOKE EXECUTE ON FUNCTION
  public.pos_sha256(text), public.pos_canonical_qty(numeric), public.pos_canonical_discount(numeric), public.pos_canonical_rate(numeric),
  public.pos_canonical_ts(timestamptz), public.pos_canonical_vat_breakdown(jsonb), public.pos_lines_digest_from_json(jsonb),
  public.pos_payments_digest_from_json(jsonb), public.pos_lines_digest(uuid), public.pos_payments_digest(uuid),
  public.pos_build_canonical_txn(bigint, text, uuid, timestamptz, text, bigint, bigint, bigint, jsonb, uuid, text, text, text),
  public.pos_canonical_txn(uuid), public.pos_compute_txn_hash(uuid), public.pos_verify_chain(uuid, bigint, bigint),
  public.pos_event_hash(bigint, uuid, text, jsonb, timestamptz, text), public.pos_verify_events_chain(uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.pos_sha256(text), public.pos_canonical_qty(numeric), public.pos_canonical_discount(numeric), public.pos_canonical_rate(numeric),
  public.pos_canonical_ts(timestamptz), public.pos_canonical_vat_breakdown(jsonb), public.pos_lines_digest_from_json(jsonb),
  public.pos_payments_digest_from_json(jsonb), public.pos_lines_digest(uuid), public.pos_payments_digest(uuid),
  public.pos_build_canonical_txn(bigint, text, uuid, timestamptz, text, bigint, bigint, bigint, jsonb, uuid, text, text, text),
  public.pos_canonical_txn(uuid), public.pos_compute_txn_hash(uuid), public.pos_verify_chain(uuid, bigint, bigint),
  public.pos_event_hash(bigint, uuid, text, jsonb, timestamptz, text), public.pos_verify_events_chain(uuid)
TO authenticated, service_role;
