# SPEC partagée — Ma Papeterie POS (NF525)

Ce document fait foi pour tous les workspaces (`packages/core`, `apps/pos`, `services/tpe-bridge`, `supabase/`).
Toute divergence entre code et SPEC est un bug. Voir aussi le plan d'architecture (`docs/ARCHITECTURE.md`).

## 1. Conventions

- Montants : **entiers en centimes** (`number` côté TS, `bigint` côté SQL). Jamais de flottant pour un montant.
- Taux de TVA : chaîne canonique à 2 décimales (`"20.00"`, `"5.50"`, `"10.00"`, `"2.10"`, `"0.00"`) dans les payloads et le hash ; `numeric(5,2)` en SQL. En TS, `vatRate: number` (20, 5.5) est accepté en entrée et normalisé par `normalizeVatRate()` → `"20.00"`.
- Quantités : `number` (jusqu'à 3 décimales) ; SQL `numeric(10,3)`. Négatives sur un `refund`.
- Dates : ISO 8601 UTC avec millisecondes (`2026-09-23T14:05:07.123Z`). `business_at` = heure de la vente (poste), `received_at` = heure serveur.
- Identifiants : UUID v4 générés côté client pour `client_txn_id` (idempotence).
- Fuseau métier : `Europe/Paris` (`business_date`).

## 2. Calcul panier (`@pos/core` `cart.ts`) — porté à l'identique en plpgsql (`pos_finalize_sale`)

Entrée `CartLineInput` : `{ line_no, product_id?, ean?, sku?, label, qty, unit_price_ttc_cents, vat_rate, discount_percent (0..100, 2 déc.), eco_tax_cents (inclus dans le TTC, informatif), pricing_rule_id?, price_tier_title?, public_price_ttc_cents? }`.

Par ligne (arrondi = `Math.round` half-up sur valeur positive ; pour négatif, arrondir la valeur absolue puis réappliquer le signe → `roundHalfAwayFromZero`) :

1. `unit_after_discount_cents = round(unit_price_ttc_cents × (100 − discount_percent) / 100)`
2. `line_ttc_cents = round(unit_after_discount_cents × qty)`
3. `line_ht_cents = round(line_ttc_cents × 10000 / (10000 + rate_bp))` où `rate_bp = round(vat_rate × 100)` (20.00 → 2000)
4. `line_vat_cents = line_ttc_cents − line_ht_cents`
5. `unit_price_ht_cents = round(unit_price_ttc_cents × 10000 / (10000 + rate_bp))` (informatif)

Totaux : `vat_breakdown` = groupes par `vat_rate` triés par taux croissant (ordre lexical des chaînes canoniques équivaut à l'ordre numérique pour nos taux, mais **trier numériquement**), chaque groupe `{ rate: "20.00", base_ht_cents, vat_cents, ttc_cents }` = sommes des lignes. `total_ttc_cents = Σ line_ttc`, `total_vat_cents = Σ line_vat`, `total_ht_cents = total_ttc − total_vat`.

Paiements : `Σ payments.amount_cents − change_cents = total_ttc_cents` sinon erreur `PAYMENTS_MISMATCH`. `change_cents` ≥ 0 uniquement s'il existe un paiement `cash`. `tendered_cents = Σ amount_cents`.

## 3. Hash canonique v1 (`@pos/core` `hashChain.ts` ≡ SQL `pos_canonical_txn`)

Chaîne UTF-8, champs séparés par `|`, aucun espace, `null` → chaîne vide :

```
v1|<ticket_number>|<register_code>|<client_txn_id>|<business_at ISO ms UTC>|<kind>|<total_ht_cents>|<total_vat_cents>|<total_ttc_cents>|<vat_breakdown_canon>|<customer_account_id ou vide>|<lines_digest>|<payments_digest>|<prev_hash ou vide>
```

- `vat_breakdown_canon` = groupes triés par taux, chacun `rate:base_ht:vat:ttc`, joints par `;` (ex. `5.50:1000:55:1055;20.00:2500:500:3000`).
- `lines_digest` = SHA-256 hex de la concaténation, séparée par `\n`, des lignes triées par `line_no` : `line_no|product_id ou vide|ean ou vide|label|qty (format canonique : nombre sans zéros inutiles, ex. 1, 2.5, -1)|unit_price_ttc_cents|vat_rate|discount_percent (2 déc. ex. 0.00, 10.00)|line_ttc_cents`.
- `payments_digest` = SHA-256 hex des paiements triés par (`method`, `amount_cents`, `reference ou vide`) : `method|amount_cents|reference ou vide`, séparés par `\n`.
- `hash = SHA-256 hex (minuscules) de la chaîne`. Premier ticket d'une caisse : `prev_hash = ''`.
- Vecteurs de test : `packages/core/src/__fixtures__/hash-vectors.json` (générés par le TS, vérifiés par SQL dans `scripts/sql-tests/03_hash_vectors.sql`).

Événements (`pos_events`) : `hash = SHA-256("v1|" + id + "|" + register_id + "|" + event_type + "|" + payload::text canonique (jsonb::text Postgres) + "|" + created_at ISO + "|" + prev_hash)` — calculé **uniquement côté SQL** (pas de miroir TS requis).

## 4. `CheckoutPayload` (PWA → `pos-checkout` → `pos_finalize_sale`) — zod dans `@pos/core` `types.ts`

```ts
{
  client_txn_id: uuid,
  register_id: uuid,
  session_id: uuid,
  kind: 'sale' | 'refund',
  refund_of_transaction_id?: uuid,      // requis si refund
  refund_reason?: string,               // requis si refund
  business_at: string (ISO),
  offline_queued: boolean,
  provisional_ref?: string,
  customer_account_id?: uuid,
  quote_id?: uuid,
  invoice_requested: boolean,
  lines: CartLineInput[] (≥1),
  payments: { method: 'cb'|'cash'|'cheque'|'gift_ucia'|'transfer', amount_cents: int, reference?: string, tpe_response?: unknown, manual_fallback?: boolean }[] (≥1),
  change_cents: int ≥ 0,
  totals: { total_ht_cents, total_vat_cents, total_ttc_cents }  // contrôle ; écart serveur → 422 TOTALS_MISMATCH
  app_version: string
}
```

Règles : `gift_ucia` et `cheque` exigent `reference` non vide ; `transfer` exige `reference` ; `cb` avec `manual_fallback=true` exige `tpe_response.reason`.

## 5. Réponse `pos-checkout` = `CheckoutResult`

```ts
{ transaction: PosTransaction, lines: PosTransactionLine[], payments: PosPayment[], ticket: TicketPayload, idempotent_replay: boolean }
```

Codes d'erreur (HTTP 4xx, corps `{ error: { code, message, details? } }`) : `UNAUTHORIZED`, `FORBIDDEN_ROLE`, `VALIDATION` (zod), `SESSION_NOT_OPEN`, `TOTALS_MISMATCH`, `PAYMENTS_MISMATCH`, `REFUND_EXCEEDS_SOLD`, `REFUND_TARGET_NOT_FOUND`, `QUOTE_NOT_FOUND`, `REGISTER_NOT_FOUND` (404), `BUSINESS_AT_OUT_OF_RANGE` (422), `CHAIN_INCONSISTENT` (409) — voir §11. 5xx : `DB_ERROR`, `FISKALY_ERROR` (n'annule PAS la vente : le résultat est renvoyé avec `signature_status='pending_signature'`).

## 6. `TicketPayload` (`@pos/core` `ticket.ts`) — rendu ESC/POS par le bridge, aperçu HTML par la PWA

```ts
{
  version: 1,
  register_code: string, ticket_number: number | null, ticket_code: string, // 'T-2026-000123' ou provisional_ref
  duplicate: boolean, kind: 'sale'|'refund', refund_of_ticket_code?: string,
  business_at: string, cashier_name: string,
  header: { company_name, address_lines: string[], siret, vat_number, phone?: string },
  customer?: { display_name, company_name?, siret?, vat_number? },
  lines: { label, qty, unit_price_ttc_cents, discount_percent, line_ttc_cents, vat_rate, price_tier_title?, public_price_ttc_cents? }[],
  vat_breakdown: { rate, base_ht_cents, vat_cents, ttc_cents }[],
  total_ht_cents, total_vat_cents, total_ttc_cents,
  payments: { method, label, amount_cents, reference? }[], change_cents,
  footer: { lines: string[] },
  compliance: { hash_short: string (8 premiers hex), signature_status, fiskaly_signature_short?: string, software: 'Ma Papeterie POS', version: string, provisional?: boolean },
  quote_number?: string, invoice_requested: boolean
}
```

Libellés paiements : cb → « Carte bancaire », cash → « Espèces », cheque → « Chèque », gift_ucia → « Bon cadeau UCIA », transfer → « Virement ».

## 7. Codec Caisse-AP (`@pos/core` `caisseAp.ts`)

- `encodeFields(fields: Array<[tag: string, value: string]>): string` → concat `tag(2) + len(3, zéro-paddée) + value` ; erreur si tag ≠ 2 car., value > 999 car. ou non ASCII.
- `decodeFields(frame: string): CaisseApFields` (`Map<string,string>` + ordre) ; tolérant : s'arrête proprement si trame tronquée (`truncated: true`).
- `buildPaymentRequest({ posNumber = '01', amountCents, action: 'debit'|'credit'|'cancel', currency = '978', protocolVersion = '0300', protocolId = '012' })` → champs dans l'ordre `CZ, CJ, CA, CB, CD, CE` avec `CB = String(amountCents)` sans padding (le préfixe de longueur suffit), `CD` = `'0'` débit, `'1'` crédit, `'2'` annulation (constantes exportées `CAISSE_AP_ACTIONS`, à ajuster depuis la spec AP sans toucher au reste).
- `parsePaymentResponse(fields)` → `{ status: 'approved'|'declined'|'pending'|'unknown', ae, af, raw }` : `AE='10'` approved, `'01'` declined, `'11'` pending, autre → unknown.
- Codes `AF` connus (exportés) : `09` format, `10` sélection, `11` abandon, `12` action inconnue, `13` devise.

## 8. API du pont TPE (`services/tpe-bridge`)

Port 8787, JSON, header `X-Bridge-Token` obligatoire (sauf `/health`), CORS strict (`allowedOrigins`) + `Access-Control-Allow-Private-Network: true`.

- `GET /health` → `{ ok, version, tpe: { host, port, reachable }, printer: { type, reachable }, simulate: boolean }`
- `POST /payment` `{ txn_id, amount_cents, kind: 'debit'|'credit' }` → `{ status: 'approved'|'declined'|'timeout'|'error'|'busy', code?: string, tpe_raw?: Record<string,string>, request_frame?: string, response_frame?: string, duration_ms }` (HTTP 200 même en refus ; 409 si un paiement est en cours → `status:'busy'`).
- `POST /payment/cancel` `{ txn_id }` → `{ ok }` ou 409.
- `POST /print` `TicketPayload` → `{ ok }` ; `POST /print/raw` `{ base64 }` → `{ ok }` ; `POST /drawer/open` `{ reason }` → `{ ok }`.
- `WS /events` : messages `{ type: 'payment', txn_id, phase: 'connecting'|'sent'|'waiting'|'done', result? }`.
  Config `bridge.config.json` (zod) : `{ http: { port, host }, token, allowedOrigins[], tpe: { host, port: 8888, posNumber: '01', timeoutMs: 90000, currency: '978', simulate: false }, printer: { type: 'network'|'none', host?, port: 9100, codepage: 'CP858', width: 42 }, drawer: { pin: 0 } }`.

## 9. Deux projets Supabase et auth des Edge Functions

- **Projet `Pos`** (base fiscale) : auth vendeur, `pos_user_roles`, tables `pos_*`, RPC de session/vente/clôture, Edge Functions `pos-*`. La PWA s'y connecte avec `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
- **Projet `ma-papeterie`** (données métier) : la PWA lit le catalogue directement (clé anon `VITE_CATALOG_SUPABASE_URL` / `VITE_CATALOG_SUPABASE_ANON_KEY`, RPC `pos_search_products`, `pos_product_by_ean`, SECURITY INVOKER). Les données protégées passent par les Edge Functions de Pos qui appellent les RPC ma-papeterie (`pos_customer_lookup`, `pos_customer_open_quotes`, `pos_resolve_cart_prices`, `pos_apply_stock_movements`) avec le secret `MAPAP_SERVICE_ROLE_KEY` (+ `MAPAP_SUPABASE_URL`).
- **Stock** : `pos_finalize_sale` écrit une file `pos_stock_sync` (une ligne par ligne de vente, `idempotency_key = transaction_id:line_no`). `pos-checkout` tente l'application immédiate via `pos_apply_stock_movements` ; le cron `pos-stock-sync` (1 min) rejoue les lignes `pending`. Le stock n'est pas une donnée fiscale : un retard est toléré, jamais une double application.
- **Auth** : header `Authorization: Bearer <JWT utilisateur Pos>` ; la fonction appelle `auth.getUser(jwt)` puis `rpc('is_pos')` (`pos_user_roles`). Les crons appellent avec le service role de Pos (comparaison stricte).
- Secrets Pos (Edge) : `FISKALY_MODE` (`mock` | `live`), `FISKALY_BASE_URL`, `FISKALY_API_KEY`, `FISKALY_API_SECRET`, `MAPAP_SUPABASE_URL`, `MAPAP_SERVICE_ROLE_KEY` (+ `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` fournis par la plateforme).
- Edge Function supplémentaire `pos-resolve-prices` : `{account_id, lines:[{product_id, qty}]}` → `{prices:[...]}` (proxy de `pos_resolve_cart_prices`).

## 10. Design (PWA)

Palette Data Noir : `bg #0a0a0f`, `surface #111118`, `border #1e1e2e`, `text #e2e8f0`, `muted #64748b`, `accent #6366f1`, `success #22c55e`, `warning #f59e0b`, `danger #ef4444`. Police Poppins (fallback system-ui). Cibles tactiles ≥ 56 px, boutons de paiement ≥ 72 px, total TTC ≥ 40 px. Format prix `fr-FR` EUR (`1 234,56 €`).

## 11. Lots 4 à 6 — hors ligne, clôtures Europe/Paris, archives, inventaire

### 11.1 Codes d'erreur ajoutés (`_shared/http.ts` ≡ `CHECKOUT_ERROR_CODES`)

| Code                       | HTTP | Origine                                                                           |
| -------------------------- | ---- | --------------------------------------------------------------------------------- |
| `BUSINESS_AT_OUT_OF_RANGE` | 422  | `business_at` hors `pos_settings.clock_tolerance` (§11.2)                         |
| `CHAIN_INCONSISTENT`       | 409  | ticket précédent introuvable au chaînage ; ZIP d'archive existant et différent    |
| `REGISTER_NOT_FOUND`       | 404  | caisse inconnue                                                                   |
| `PERIOD_NOT_ENDED`         | 409  | archive demandée pour une période non terminée (ignorée par `pos-export-archive`) |

### 11.2 Hors ligne (lot 4) — détail : `docs/HORS-LIGNE.md`

- `pos_settings.clock_tolerance = {"online_minutes":10,"offline_hours":72,"future_minutes":5}`.
- `pos_finalize_sale`, **après** l'idempotence (un `client_txn_id` connu renvoie toujours
  `idempotent_replay: true`) : `offline_queued` + `refund` → `VALIDATION` ; en ligne
  `|business_at − now()| > online_minutes` → `BUSINESS_AT_OUT_OF_RANGE` ; hors ligne
  `business_at < now() − offline_hours` ou `> now() + future_minutes` → `BUSINESS_AT_OUT_OF_RANGE`.
- Vente hors ligne dont la session est fermée : rattachée à la session **ouverte** de la caisse
  (JET `offline_reattached`) ; aucune session ouverte → `SESSION_NOT_OPEN` (la PWA garde la vente).
- `pos_client_settings()` → `{offline_max_txns, offline_max_hours, clock_tolerance, server_now}`.
- Référence provisoire `OFF-<code caisse>-<YYYYMMDD>-<nnn>` ; JET `offline_enter`, `offline_exit`,
  `offline_replay_failed`.

### 11.3 Clôtures (lot 5)

- `pos_period_bounds(p_type, p_ref) → (period_start, period_end)` : période `daily|monthly|annual`
  contenant `p_ref`, bornes en Europe/Paris, fin exclusive. Période précédente : appeler avec
  `period_start − 1 ms` de la période courante.
- `pos-closing` : sans `period_start` (cron) → période précédente ; avec `period_start` → période
  qui le contient. Plus aucun calcul de fuseau en TypeScript (`_shared/periods.ts`).
- `pos_verify_closings_chain(register) → (ok, checked, first_break_number, reason)`.

### 11.4 Archives (lot 5) — `pos-archive/v1`

- **Partition contiguë** par caisse : tickets `ticket_number >` dernier archivé et
  `received_at < period_end` ; JET `id >` dernier archivé et `created_at < period_end` ; clôtures
  `closing_number >` dernière archivée et `created_at < period_end`. Première archive : depuis l'origine.
- `pos_archive_data(register, start, end)` (admin / service) →
  `{register:{id,code,label}, period_start, period_end, transactions:[row + lines + payments],
events, closings, chain_heads:{anchor_ticket_number, anchor_ticket_hash, last_ticket_number,
last_ticket_hash, last_event_id, last_event_hash, last_closing_number, last_closing_hash},
previous_archive:{id, period_start, hash, manifest_sha256, last_ticket_number, last_event_id,
last_closing_number}|null, software:{name, version}}` (`last_*` = `null` si aucun élément).
- ZIP (fflate, date d'entrée fixe) : `transactions.jsonl`, `events.jsonl`, `closings.jsonl` (une
  ligne JSON **canonique** par enregistrement — clés triées récursivement, sans espaces —, `\n`
  final, fichier vide si aucun) et `manifest.json` =
  `{format:"pos-archive/v1", register_code, period_start, period_end, generated_at, software,
files:[{name, sha256, bytes, records}], chain_heads, previous_archive:{hash, manifest_sha256}|null,
first_ticket_number, last_ticket_number}` sérialisé canoniquement (sans `\n` final).
  Horodatages du manifeste en ISO UTC ms.
- `manifest_sha256` = SHA-256 hex de `manifest.json`.
- `pos_register_archive(register, start, end, storage_path, manifest, manifest_sha256)` (service
  role) → `{archive, already_exists}` ; lit `manifest.chain_heads.last_*` ;
  `hash = SHA-256('v1|archive|' || code || '|' || start || '|' || end || '|' || manifest_sha256 || '|' || prev_hash)` ;
  JET `archive`. `pos_verify_archives_chain(register) → (ok, checked, first_break_id, reason)`.
- Stockage : bucket privé `pos-archives`, chemin `<register_code>/<YYYY-MM>.zip` (mois de Paris de
  `period_start`), jamais écrasé ; lecture admin (`is_pos_admin`).
- Implémentation : `@pos/core` `archive.ts` (`canonicalJson`, `toJsonl`, `buildArchiveFiles`,
  `verifyArchive`) ; miroir Deno `supabase/functions/_shared/archive.ts`, égalité vérifiée par
  Vitest sur `packages/core/src/__fixtures__/archive-vector.json`.
- `verifyArchive(files)` : manifeste canonique, SHA-256 / taille / nombre d'enregistrements par
  fichier, `first/last_ticket_number`, premier ticket = `anchor_ticket_number + 1` avec
  `prev_hash = anchor_ticket_hash`, chaîne des tickets recalculée (`verifyChainAsync`, mêmes règles
  que `verifyChain`), liaison `prev_hash` du JET et des clôtures, têtes `last_*`, dates de
  réception < `period_end`.

### 11.5 Edge Functions ajoutées

- `pos-export-archive` — POST, service role ou admin (`requirePosAdmin`). Entrée
  `{register_id?: uuid, period_start?: ISO, source?}` (défaut : mois précédent Europe/Paris, toutes
  les caisses actives ; cron `0 4 1 * *` UTC `{"source":"pg_cron"}`). Sortie
  `{period_start, period_end, archives:[{register_code, period_start, period_end, storage_path,
manifest_sha256, hash, already_exists, counts:{transactions, events, closings}}],
skipped:[{register_code, reason}]}`.
- `pos-stock-adjust` — POST, admin ou service role. Entrée `{items:[{product_id: uuid, counted:
int ≥ 0, idempotency_key: string(8..80), label?}] (1..200, clés uniques), reason: string(3..200),
register_id?: uuid}`. Appelle par paquets de 10 la RPC ma-papeterie
  `pos_set_stock_boutique(p_product_id, p_counted, p_reason, p_idempotency_key)` →
  `{product_id, applied, already_applied, stock_before, stock_after, delta}` (erreurs par article
  `PRODUCT_NOT_FOUND`, `VALIDATION`). Sortie `{results:[{…, error?}], event_id}` ; un événement JET
  `stock_adjustment` par lot (`items`, `applied`, `already_applied`, `errors`, `delta_sum`, `reason`).

### 11.6 Pont TPE

Option `tls: {certPath, keyPath}` (PEM) → HTTPS natif Fastify (`docs/TPE-CAISSE-AP.md` §9) ; les
clés de premier niveau de `bridge.config.json` commençant par `//` sont ignorées (commentaires).
