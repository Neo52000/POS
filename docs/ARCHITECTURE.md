# Architecture — Ma Papeterie POS (NF525)

Caisse mono-poste, mono-vendeur pour la boutique Ma Papeterie (Reine & Fils SAS, 10 rue Toupot de Béveaux, Chaumont), en remplacement de Shopify POS. Éditeur : micro-entreprise d'Élie (attestation individuelle BOI-LETTRE-000242, volets 1 et 2).

## Vue d'ensemble

```
iPad (PWA Safari plein écran)           PC comptoir tactile (Chrome kiosque)
        │                                          │
        └──────────── HTTPS ───────────────────────┤
                                                   │  http://localhost:8787
   ┌───────────────────────────┐        ┌──────────▼──────────┐      TCP 8888 (Caisse-AP)
   │ apps/pos — PWA React      │        │ services/tpe-bridge │ ───────────────────────▶ TPE Ingenico/Verifone
   │ Vite · Tailwind · Zustand │        │ Node 20 · Fastify   │ ── TCP 9100 (ESC/POS) ──▶ Imprimante ticket + tiroir
   └─────────────┬─────────────┘        └─────────────────────┘
                 │ JWT vendeur (rôle pos)
   ┌─────────────▼──────────────────────────────────────────────────────────────┐
   │ Supabase projet `Pos` (base fiscale, dédiée à la caisse)                    │
   │  • Auth vendeur + pos_user_roles                                           │
   │  • Edge Functions pos-* (Deno)  ──▶  Fiskaly SIGN FR (signature, clôtures) │
   │  • RPC SECURITY DEFINER pos_*  ──▶  tables pos_* (immutables, chaînées)    │
   │  • pos_stock_sync (file idempotente vers ma-papeterie)                     │
   └─────────────┬──────────────────────────────────────────────────────────────┘
                 │ clé service ma-papeterie (secret Edge uniquement)
   ┌─────────────▼──────────────────────────────────────────────────────────────┐
   │ Supabase projet `ma-papeterie` (données métier du site)                     │
   │  • RPC catalogue pos_search_products / pos_product_by_ean (anon, lues aussi │
   │    directement par la PWA)                                                 │
   │  • RPC service role : pos_customer_get / lookup / open_quotes,             │
   │    pos_resolve_cart_prices (→ resolve_price), pos_apply_stock_movements    │
   │  • products.stock_boutique (source de vérité stock boutique)               │
   └────────────────────────────────────────────────────────────────────────────┘
```

Deux projets Supabase (décision utilisateur) : la base fiscale `Pos` est isolée ; `ma-papeterie` reste la source de vérité produits/prix/clients/stock et n'est jamais modifiée en dehors de `products.stock_boutique` (via `pos_apply_stock_movements`, idempotent). Shopify n'est **jamais** appelé par la caisse.

## Workspaces

| Workspace                         | Rôle                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` (`@pos/core`)     | Logique pure et isomorphe : montants, TVA, calcul panier (SPEC §2), hash canonique (SPEC §3), codec Caisse-AP (SPEC §7), types `CheckoutPayload` / `TicketPayload`. Portée à l'identique en plpgsql.                                                                                                                                                                                           |
| `apps/pos` (`@pos/app`)           | PWA caisse : recherche/scan, panier, paiements, ticket, sessions, historique, B2B.                                                                                                                                                                                                                                                                                                             |
| `services/tpe-bridge`             | Service local : pont HTTP ↔ TCP Caisse-AP (TPE), impression ESC/POS, tiroir, simulateur de TPE.                                                                                                                                                                                                                                                                                                |
| `supabase/migrations`             | Projet `Pos` : schéma `pos_*`, immutabilité, chaînage, RPC, RLS, vues, crons. Appliqué automatiquement par l'intégration GitHub Supabase à la fusion dans `main`.                                                                                                                                                                                                                              |
| `supabase-mapapeterie/migrations` | Projet `ma-papeterie` : RPC catalogue (anon), RPC service role (clients, tarifs, devis, stock) et table `pos_stock_movements`. Appliqué manuellement (connecteur ou SQL Editor).                                                                                                                                                                                                               |
| `supabase/functions`              | `pos-checkout`, `pos-sign-pending`, `pos-stock-sync`, `pos-closing`, `pos-closings-sync`, `pos-customer-search`, `pos-customer-quotes`, `pos-resolve-prices`, `pos-export-archive`, `pos-stock-adjust` + `_shared/fiskaly` (adaptateur), `_shared/mapapeterie` (client service role ma-papeterie), `_shared/periods` (bornes Europe/Paris), `_shared/archive` (miroir de `@pos/core` archive). |
| `scripts`                         | `verify-chain.ts` (audit tickets, JET, clôtures, archives), `verify-archive.ts` (contrôle d'un ZIP d'archive), `fiskaly-sandbox-smoke.ts`, tests SQL.                                                                                                                                                                                                                                          |

## Flux d'une vente

1. La PWA construit le panier (`@pos/core.computeCart`) et encaisse : CB via le pont (`POST /payment` → trame Caisse-AP → `AE=10`), espèces, chèque, bon UCIA (= chèque avec référence), virement.
2. `POST /functions/v1/pos-checkout` avec `CheckoutPayload` (idempotent par `client_txn_id`).
3. `pos-checkout` fige la snapshot du client pro (RPC ma-papeterie `pos_customer_get`) puis appelle `pos_finalize_sale` (une transaction Postgres) : verrou de caisse, numéro de ticket continu (`pos_counters`), recalcul serveur des totaux, contrôle des paiements, insertion transaction/lignes/paiements, file `pos_stock_sync`, `prev_hash` + `hash` SHA-256.
4. Stock : `pos_apply_stock_movements` sur ma-papeterie (décrément `stock_boutique`, négatif toléré et journalisé dans `pos_stock_movements`) ; en cas d'échec la file est rejouée par `pos-stock-sync` (cron 1 min). Le stock n'est pas une donnée fiscale.
5. Signature Fiskaly (Record TRANSACTION/RECEIPT). Échec → `pending_signature`, rejoué par `pos-sign-pending` (cron 2 min). La vente reste valide.
6. Retour du `TicketPayload` → impression ESC/POS via le pont, ouverture tiroir si espèces.

## Garanties NF525 (ISCA)

- **Inaltérabilité** : écritures uniquement via RPC `SECURITY DEFINER` (REVOKE sur les tables), triggers interdisant UPDATE/DELETE (hors colonnes de signature), numérotation continue, chaîne SHA-256 par caisse (`pos_verify_chain`), JET local chaîné (`pos_events`).
- **Sécurisation** : signature Fiskaly de chaque transaction et des clôtures ; RLS `is_pos()` ; secrets uniquement côté Edge Functions.
- **Conservation** : Postgres sans purge (sauvegardes Supabase) + archives Fiskaly SAFE + ZIP mensuels copiés hors ligne par l'exploitant.
- **Archivage** : archive mensuelle chaînée (`pos-export-archive`, `pos_archives`), vérifiable seule (`pnpm verify-archive`).

Procédures et preuves : `docs/ISCA-PROCEDURES.md` ; périmètre fiscal : `docs/PERIMETRE-NF525.md`.

## Hors ligne (lot 4)

Détail opérationnel : `docs/HORS-LIGNE.md`.

- Connectivité : sonde `auth/v1/health` (15 s hors ligne, 60 s en ligne) + événements navigateur +
  erreurs réseau des Edge Functions ; transitions journalisées (`offline_enter` / `offline_exit`).
- File IndexedDB (Dexie `queue`, clé `client_txn_id`, ordre `local_seq`), ticket provisoire
  `OFF-<caisse>-<YYYYMMDD>-<nnn>` ; numéro, hash et signature attribués **au rejeu** par le serveur.
- Limites `pos_client_settings()` : 50 ventes / 24 h ; remboursement, ouverture/clôture de
  session, recherche de nouveau client pro et inventaire interdits hors ligne.
- Rejeu FIFO idempotent (`pos-checkout`) ; session fermée → rattachement à la session ouverte
  (`offline_reattached`) ; échecs métier → `failed` + `offline_replay_failed`, bloquent le Z.
- Anti-antidatage serveur : `clock_tolerance` (10 min en ligne, 72 h / +5 min hors ligne) →
  `BUSINESS_AT_OUT_OF_RANGE`.

## Clôtures et archives (lot 5)

- Bornes de période calculées en SQL en heure de Paris (`pos_period_bounds`) ; `pos-closing`
  (crons mensuel / annuel) n'effectue plus aucun calcul de fuseau.
- `pos-export-archive` (cron le 1er à 04:00 UTC) : pour chaque caisse, partition contiguë depuis
  l'archive précédente (`pos_archive_data`) → fichiers `pos-archive/v1` (`@pos/core`
  `buildArchiveFiles`, miroir Deno) → ZIP fflate → bucket privé `pos-archives/<caisse>/<AAAA-MM>.zip`
  (jamais écrasé) → `pos_register_archive` (table immuable `pos_archives`, chaîne `prev_hash`/`hash`,
  JET `archive`). Idempotent : une archive existante est renvoyée (`already_exists`).
- Vérification : `pos_verify_closings_chain`, `pos_verify_archives_chain`, `pnpm verify-archive`
  (recalcul complet hors base, y compris la chaîne des tickets ancrée sur l'archive précédente).

```
pg_cron ─▶ pos-export-archive ─▶ pos_period_bounds ─▶ pos_archive_data ─▶ buildArchiveFiles ─▶ zipSync
                                                                              │
                        pos_register_archive ◀── Storage pos-archives/<caisse>/<AAAA-MM>.zip
```

## Inventaire (lot 6)

- Page `/inventory` de la PWA (admin) : comptage par scan, lignes conservées localement avec une
  clé d'idempotence par ligne, envoi par tranches à `pos-stock-adjust`.
- `pos-stock-adjust` (admin ou service role) appelle la RPC ma-papeterie `pos_set_stock_boutique`
  (stock fixé au compté, idempotent, tracé dans `pos_stock_movements` reason `inventory`) par
  paquets de 10, puis journalise un événement JET `stock_adjustment` par lot.
- Le stock reste hors périmètre fiscal ; seule la trace JET est chaînée.

## Pont TPE en HTTPS (iPad)

Le pont termine TLS lui-même (`tls: {certPath, keyPath}` → Fastify `https`), certificat Let's
Encrypt DNS-01 pour `bridge.ma-papeterie.fr` résolu vers l'IP LAN du PC comptoir ; plus de reverse
proxy (`docs/TPE-CAISSE-AP.md` §9).

## Décisions et alternatives écartées

- Stripe Terminal / TPE cloud : écarté (CDC) ; Caisse-AP over IP via pont local.
- `SEQUENCE` Postgres pour les tickets : écartée (trous en cas de rollback) → compteur verrouillé.
- Création de factures depuis la caisse : reportée ; vue `pos_transactions_to_invoice` pour l'ERP.
