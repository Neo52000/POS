-- =============================================================================
-- POS NF525 — 0002 (projet « Pos ») : schéma des tables pos_*
-- -----------------------------------------------------------------------------
-- Base dédiée : aucune FK vers les données ma-papeterie. product_id /
-- customer_account_id / quote_id sont de simples uuid (identifiants
-- ma-papeterie). Les mouvements de stock sont poussés vers ma-papeterie par une
-- outbox (pos_stock_sync) traitée par l'Edge Function pos-stock-sync.
--
-- Conventions (docs/SPEC.md §1) :
--   * montants en centimes -> bigint (jamais de flottant) ;
--   * taux de TVA -> numeric(5,2) (20.00, 5.50, 10.00, 2.10, 0.00) ;
--   * quantités -> numeric(10,3), négatives sur un remboursement ;
--   * business_at = heure de la vente (poste), received_at = heure serveur,
--     business_date = date métier en Europe/Paris.
-- Toutes les écritures passent par des RPC SECURITY DEFINER (migration 0005) ;
-- l'immutabilité est garantie par triggers (0003) et le chaînage SHA-256 (0004).
-- Idempotent : CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / ON CONFLICT.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pos_registers : les caisses (une par poste physique / système Fiskaly)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_registers (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  code              text        NOT NULL UNIQUE,                    -- ex. CHAUMONT-01 (entre dans le hash)
  label             text        NOT NULL,
  fiskaly_system_id text,                                           -- System Fiskaly SIGN FR (commissionné)
  fiskaly_env       text        NOT NULL DEFAULT 'test'
                                CHECK (fiskaly_env IN ('test', 'live')),
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pos_registers IS 'POS NF525 : caisses (registres). Le code entre dans la chaîne canonique des tickets.';

-- -----------------------------------------------------------------------------
-- pos_settings : paramètres clé/valeur (legal, ticket_footer, software, ...)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pos_settings IS 'POS NF525 : paramètres (legal, ticket_footer, offline_max_txns, offline_max_hours, software). Écriture is_pos_admin() uniquement.';

-- -----------------------------------------------------------------------------
-- pos_counters : numérotation continue par caisse, verrouillée par UPDATE ... RETURNING
-- (pas de SEQUENCE : une séquence laisse des trous en cas de rollback).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_counters (
  register_id uuid   NOT NULL REFERENCES public.pos_registers (id),
  kind        text   NOT NULL CHECK (kind IN ('ticket', 'session', 'closing', 'event')),
  value       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (register_id, kind)
);
COMMENT ON TABLE public.pos_counters IS 'POS NF525 : compteurs continus par caisse (ticket, session, closing, event). Incrémentés sous verrou de ligne.';

-- Un nouveau registre reçoit automatiquement ses 4 compteurs à zéro.
CREATE OR REPLACE FUNCTION public.pos_registers_init_counters()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  INSERT INTO public.pos_counters (register_id, kind, value)
  SELECT NEW.id, k, 0
  FROM unnest(ARRAY['ticket', 'session', 'closing', 'event']) AS k
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
COMMENT ON FUNCTION public.pos_registers_init_counters() IS 'POS NF525 : trigger AFTER INSERT sur pos_registers, crée les compteurs à 0.';
REVOKE EXECUTE ON FUNCTION public.pos_registers_init_counters() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_pos_registers_init_counters ON public.pos_registers;
CREATE TRIGGER trg_pos_registers_init_counters
  AFTER INSERT ON public.pos_registers
  FOR EACH ROW EXECUTE FUNCTION public.pos_registers_init_counters();

-- -----------------------------------------------------------------------------
-- pos_sessions : ouverture / fermeture de caisse (fond de caisse, comptage)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_sessions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id         uuid        NOT NULL REFERENCES public.pos_registers (id),
  session_number      bigint      NOT NULL,
  opened_by           uuid,                                          -- auth.users.id (sans FK stricte)
  opened_at           timestamptz NOT NULL DEFAULT now(),
  opening_float_cents bigint      NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
  closed_by           uuid,
  closed_at           timestamptz,
  counted_cash_cents  bigint,
  expected_cash_cents bigint,
  variance_cents      bigint,
  closing_id          uuid,                                          -- FK ajoutée après pos_closings
  notes               text,
  status              text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  UNIQUE (register_id, session_number)
);
COMMENT ON TABLE public.pos_sessions IS 'POS NF525 : sessions de caisse. Une seule session ouverte par caisse (index unique partiel).';

CREATE UNIQUE INDEX IF NOT EXISTS pos_sessions_one_open_per_register
  ON public.pos_sessions (register_id) WHERE status = 'open';

-- -----------------------------------------------------------------------------
-- pos_transactions : tickets (cœur NF525)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_transactions (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_txn_id            uuid        NOT NULL,                     -- idempotence (UUID v4 côté client)
  register_id              uuid        NOT NULL REFERENCES public.pos_registers (id),
  session_id               uuid        NOT NULL REFERENCES public.pos_sessions (id),
  ticket_number            bigint      NOT NULL,
  kind                     text        NOT NULL CHECK (kind IN ('sale', 'refund')),
  refund_of_transaction_id uuid        REFERENCES public.pos_transactions (id),
  refund_reason            text,
  business_at              timestamptz NOT NULL,                     -- heure de la vente (poste)
  business_date            date        NOT NULL,                     -- (business_at AT TIME ZONE 'Europe/Paris')::date
  received_at              timestamptz NOT NULL DEFAULT now(),       -- heure serveur
  cashier_id               uuid        NOT NULL,                     -- auth.users.id
  customer_account_id      uuid,                                     -- customer_accounts.id ma-papeterie (sans FK)
  customer_snapshot        jsonb,                                    -- {display_name, company_name, siret, vat_number, ...}
  quote_id                 uuid,                                     -- client_quotes.id ma-papeterie (sans FK)
  quote_number             text,                                     -- n° de devis (fourni par l'Edge Function, pour le ticket)
  invoice_requested        boolean     NOT NULL DEFAULT false,
  total_ht_cents           bigint      NOT NULL,
  total_vat_cents          bigint      NOT NULL,
  total_ttc_cents          bigint      NOT NULL,
  vat_breakdown            jsonb       NOT NULL,                     -- [{rate:"20.00", base_ht_cents, vat_cents, ttc_cents}]
  tendered_cents           bigint      NOT NULL,                     -- Σ payments.amount_cents
  change_cents             bigint      NOT NULL DEFAULT 0 CHECK (change_cents >= 0),
  offline_queued           boolean     NOT NULL DEFAULT false,
  provisional_ref          text,
  prev_hash                text,                                     -- NULL/'' pour le premier ticket d'une caisse
  hash                     text        NOT NULL,
  hash_version             smallint    NOT NULL DEFAULT 1,
  fiskaly_record_id        text,
  fiskaly_signature        text,
  fiskaly_signed_at        timestamptz,
  fiskaly_payload          jsonb,
  signature_status         text        NOT NULL DEFAULT 'pending_signature'
                                       CHECK (signature_status IN ('pending_signature', 'signed', 'failed')),
  signature_attempts       int         NOT NULL DEFAULT 0,
  last_signature_error     text,
  app_version              text,
  UNIQUE (register_id, ticket_number),
  CHECK (total_ttc_cents = total_ht_cents + total_vat_cents),
  CHECK (kind <> 'refund' OR refund_of_transaction_id IS NOT NULL)
);
COMMENT ON TABLE public.pos_transactions IS 'POS NF525 : tickets de vente / remboursement, numérotés en continu par caisse et chaînés par SHA-256 (hash, prev_hash).';

CREATE UNIQUE INDEX IF NOT EXISTS pos_transactions_client_txn_id_key ON public.pos_transactions (client_txn_id);
CREATE INDEX IF NOT EXISTS pos_transactions_register_ticket_idx ON public.pos_transactions (register_id, ticket_number);
CREATE INDEX IF NOT EXISTS pos_transactions_business_date_idx  ON public.pos_transactions (business_date);
CREATE INDEX IF NOT EXISTS pos_transactions_session_idx        ON public.pos_transactions (session_id);
CREATE INDEX IF NOT EXISTS pos_transactions_refund_of_idx      ON public.pos_transactions (refund_of_transaction_id) WHERE refund_of_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pos_transactions_unsigned_idx       ON public.pos_transactions (signature_status) WHERE signature_status <> 'signed';

-- -----------------------------------------------------------------------------
-- pos_transaction_lines : lignes de ticket (immutables)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_transaction_lines (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id        uuid          NOT NULL REFERENCES public.pos_transactions (id),
  line_no               int           NOT NULL,
  product_id            uuid,                                        -- products.id ma-papeterie (sans FK)
  ean                   text,
  sku                   text,
  label                 text          NOT NULL,
  qty                   numeric(10,3) NOT NULL CHECK (qty <> 0),
  unit_price_ttc_cents  bigint        NOT NULL,
  unit_price_ht_cents   bigint        NOT NULL,
  vat_rate              numeric(5,2)  NOT NULL CHECK (vat_rate >= 0),
  discount_percent      numeric(5,2)  NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  discount_reason       text,
  line_ttc_cents        bigint        NOT NULL,
  line_ht_cents         bigint        NOT NULL,
  line_vat_cents        bigint        NOT NULL,
  eco_tax_cents         bigint        NOT NULL DEFAULT 0,
  pricing_rule_id       uuid,
  price_tier_title      text,
  public_price_ttc_cents bigint,
  UNIQUE (transaction_id, line_no)
);
COMMENT ON TABLE public.pos_transaction_lines IS 'POS NF525 : lignes de ticket (recalculées côté serveur, immutables).';
CREATE INDEX IF NOT EXISTS pos_transaction_lines_transaction_idx ON public.pos_transaction_lines (transaction_id);
CREATE INDEX IF NOT EXISTS pos_transaction_lines_product_idx     ON public.pos_transaction_lines (product_id) WHERE product_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- pos_payments : moyens de paiement d'un ticket (immutables)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_payments (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid        NOT NULL REFERENCES public.pos_transactions (id),
  method          text        NOT NULL CHECK (method IN ('cb', 'cash', 'cheque', 'gift_ucia', 'transfer')),
  amount_cents    bigint      NOT NULL,                              -- négatif sur un remboursement
  reference       text,                                              -- obligatoire pour cheque / gift_ucia / transfer
  tpe_response    jsonb,
  manual_fallback boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.pos_payments IS 'POS NF525 : paiements (cb, cash, cheque, gift_ucia, transfer). Immutables.';
CREATE INDEX IF NOT EXISTS pos_payments_transaction_idx ON public.pos_payments (transaction_id);

-- -----------------------------------------------------------------------------
-- pos_stock_sync : outbox des mouvements de stock à appliquer côté ma-papeterie
-- (products.stock_boutique via la fonction bridge pos_apply_stock_movements).
-- Une ligne par ligne de ticket avec product_id ; idempotency_key =
-- transaction_id || ':' || line_no. Traitée par l'Edge Function pos-stock-sync.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_stock_sync (
  id                 bigserial   PRIMARY KEY,
  transaction_id     uuid        NOT NULL REFERENCES public.pos_transactions (id),
  product_id         uuid        NOT NULL,                             -- products.id (ma-papeterie)
  qty_delta          int         NOT NULL,                             -- vente : -qty ; remboursement : +|qty|
  idempotency_key    text        NOT NULL UNIQUE,
  status             text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts           int         NOT NULL DEFAULT 0,
  last_error         text,
  remote_stock_after int,                                              -- stock_boutique renvoyé par ma-papeterie
  created_at         timestamptz NOT NULL DEFAULT now(),
  done_at            timestamptz
);
COMMENT ON TABLE public.pos_stock_sync IS 'POS NF525 : outbox des mouvements de stock_boutique à synchroniser vers ma-papeterie (idempotent par idempotency_key).';
CREATE INDEX IF NOT EXISTS pos_stock_sync_pending_idx     ON public.pos_stock_sync (id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS pos_stock_sync_transaction_idx ON public.pos_stock_sync (transaction_id);

-- -----------------------------------------------------------------------------
-- pos_closings : clôtures Z (daily), mensuelles et annuelles, chaînées
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_closings (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id                 uuid        NOT NULL REFERENCES public.pos_registers (id),
  closing_number              bigint      NOT NULL,
  period_type                 text        NOT NULL CHECK (period_type IN ('daily', 'monthly', 'annual')),
  period_start                timestamptz NOT NULL,
  period_end                  timestamptz NOT NULL,
  session_id                  uuid        REFERENCES public.pos_sessions (id),
  txn_count                   int         NOT NULL DEFAULT 0,
  first_ticket_number         bigint,
  last_ticket_number          bigint,
  total_ht_cents              bigint      NOT NULL DEFAULT 0,
  total_vat_cents             bigint      NOT NULL DEFAULT 0,
  total_ttc_cents             bigint      NOT NULL DEFAULT 0,
  vat_breakdown               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  payments_breakdown          jsonb       NOT NULL DEFAULT '[]'::jsonb, -- [{method, amount_cents, count}]
  refunds_ttc_cents           bigint      NOT NULL DEFAULT 0,          -- somme (négative) des remboursements
  grand_total_perpetual_cents bigint      NOT NULL DEFAULT 0,          -- cumul perpétuel du TTC net depuis l'origine
  fiskaly_closing_id          text,
  fiskaly_payload             jsonb,
  prev_hash                   text,
  hash                        text        NOT NULL,
  created_by                  uuid,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (register_id, closing_number),
  UNIQUE (register_id, period_type, period_start),
  CHECK (period_end > period_start)
);
COMMENT ON TABLE public.pos_closings IS 'POS NF525 : clôtures (daily = Z de session, monthly, annual) avec grand total perpétuel et chaînage SHA-256.';
CREATE INDEX IF NOT EXISTS pos_closings_register_period_idx ON public.pos_closings (register_id, period_type, period_start);

-- FK différée : pos_sessions.closing_id -> pos_closings
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_sessions_closing_id_fkey'
  ) THEN
    ALTER TABLE public.pos_sessions
      ADD CONSTRAINT pos_sessions_closing_id_fkey
      FOREIGN KEY (closing_id) REFERENCES public.pos_closings (id);
  END IF;
END $$;

-- -----------------------------------------------------------------------------
-- pos_events : journal des événements techniques (JET), chaîné par caisse
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pos_events (
  id           bigint      GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  register_id  uuid        REFERENCES public.pos_registers (id),   -- NULL = événement global (login sans caisse...)
  session_id   uuid        REFERENCES public.pos_sessions (id),
  user_id      uuid,
  event_type   text        NOT NULL,                                -- login, logout, session_open, session_close, sale, refund,
                                                                    -- sale_abandoned, line_deleted, price_override, drawer_opened,
                                                                    -- reprint, offline_enter, offline_exit, signature_failed,
                                                                    -- manual_cb_fallback, stock_negative, stock_adjustment, closing
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  client_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  event_number bigint,                                              -- n° continu par caisse (pos_counters.event), NULL si global
  prev_hash    text,
  hash         text        NOT NULL DEFAULT ''                      -- renseigné par le trigger BEFORE INSERT (0004)
);
COMMENT ON TABLE public.pos_events IS 'POS NF525 : journal des événements techniques (JET), chaîné SHA-256 par caisse via trigger. Immutable.';
CREATE INDEX IF NOT EXISTS pos_events_register_id_idx ON public.pos_events (register_id, id);
CREATE INDEX IF NOT EXISTS pos_events_type_idx        ON public.pos_events (event_type, created_at);

-- =============================================================================
-- Seed : caisse par défaut, paramètres, compteurs
-- =============================================================================
INSERT INTO public.pos_registers (code, label, fiskaly_env)
VALUES ('CHAUMONT-01', 'Caisse comptoir Chaumont', 'test')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.pos_settings (key, value) VALUES
  ('legal', jsonb_build_object(
      'company_name', 'Reine & Fils SAS',
      'address_lines', jsonb_build_array('10 rue Toupot de Béveaux', '52000 Chaumont'),
      'siret', '',
      'vat_number', '',
      'phone', '')),
  ('ticket_footer', jsonb_build_object(
      'lines', jsonb_build_array('Merci de votre visite !', 'ma-papeterie.fr'))),
  ('offline_max_txns', to_jsonb(50)),
  ('offline_max_hours', to_jsonb(24)),
  ('software', jsonb_build_object('name', 'Ma Papeterie POS', 'version', '0.1.0'))
ON CONFLICT (key) DO NOTHING;

-- Compteurs pour tous les registres existants (le trigger couvre les suivants)
INSERT INTO public.pos_counters (register_id, kind, value)
SELECT r.id, k, 0
FROM public.pos_registers r
CROSS JOIN unnest(ARRAY['ticket', 'session', 'closing', 'event']) AS k
ON CONFLICT DO NOTHING;
