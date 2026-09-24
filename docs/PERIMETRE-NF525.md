# Périmètre fiscal — Ma Papeterie POS

Document de référence pour l'attestation individuelle de l'éditeur (`docs/ATTESTATION-EDITEUR.md`)
et pour un contrôle de l'administration fiscale (art. 286-I-3° bis CGI, BOI-TVA-DECLA-30-10-30).
Il délimite ce qui enregistre, conserve et restitue les données de règlement (périmètre fiscal)
et ce qui n'est qu'un périphérique ou une source de données non fiscales.

Version du logiciel couverte : **Ma Papeterie POS 0.1.0** (valeur `pos_settings.software`,
imprimée sur chaque ticket `compliance.software` / `compliance.version`).

## 1. Composants

### 1.1 Dans le périmètre fiscal

| Composant                            | Emplacement                                                                                                                                                                                                        | Version        | Rôle fiscal                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Base fiscale Supabase **Pos**        | projet `jntngwbdsaexustzmaii`, `supabase/migrations/`                                                                                                                                                              | schéma lot 1-6 | enregistrement, numérotation continue, chaînage, clôtures, JET, archives                                                        |
| Tables `pos_*`                       | `pos_transactions`, `pos_transaction_lines`, `pos_payments`, `pos_sessions`, `pos_closings`, `pos_events`, `pos_archives`, `pos_counters`, `pos_registers`, `pos_settings`, `pos_user_roles`                       | —              | données de règlement et de traçabilité ; UPDATE/DELETE interdits par trigger (hors colonnes de signature)                       |
| RPC `SECURITY DEFINER`               | `pos_finalize_sale`, `pos_open_session`, `pos_close_session`, `pos_compute_closing`, `pos_log_event`, `pos_mark_signature`, `pos_archive_data`, `pos_register_archive`, `pos_period_bounds`, `pos_client_settings` | —              | seules voies d'écriture (REVOKE sur les tables)                                                                                 |
| Fonctions de preuve                  | `pos_canonical_txn`, `pos_compute_txn_hash`, `pos_event_hash`, `pos_verify_chain`, `pos_verify_events_chain`, `pos_verify_closings_chain`, `pos_verify_archives_chain`                                             | hash `v1`      | recalcul et contrôle d'intégrité                                                                                                |
| Edge Functions fiscales (Deno)       | `pos-checkout`, `pos-sign-pending`, `pos-closing`, `pos-closings-sync`, `pos-export-archive`                                                                                                                       | 0.1.0          | validation et enregistrement des ventes, signature Fiskaly, clôtures, archivage                                                 |
| `@pos/core`                          | `packages/core`                                                                                                                                                                                                    | 0.1.0          | calcul panier/TVA et hash canonique `v1` (miroir exact du SQL, vecteurs `hash-vectors.json`), format d'archive `pos-archive/v1` |
| PWA caisse                           | `apps/pos` (`pos.ma-papeterie.fr`)                                                                                                                                                                                 | 0.1.0          | saisie, affichage, ticket, file hors ligne ; n'attribue ni numéro ni hash (serveur seul)                                        |
| Service de signature Fiskaly SIGN FR | API Fiskaly (TEST puis LIVE)                                                                                                                                                                                       | —              | signature des transactions et clôtures, archive SAFE                                                                            |
| Scripts d'audit                      | `scripts/verify-chain.ts`, `scripts/verify-archive.ts`                                                                                                                                                             | 0.1.0          | vérification indépendante (auditeur)                                                                                            |

### 1.2 Hors périmètre fiscal

| Composant                              | Rôle                                                                                                     | Pourquoi hors périmètre                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pont TPE `services/tpe-bridge` (0.1.0) | pilote de périphériques local : TPE (Caisse-AP), imprimante ESC/POS, tiroir                              | n'enregistre ni ne conserve aucune donnée ; ne décide pas du montant (reçu de la PWA) ; la réponse TPE est stockée par la caisse dans `pos_payments.tpe_response` |
| Projet Supabase **ma-papeterie**       | catalogue, prix, clients pro, devis, stock boutique (`products.stock_boutique`, `pos_stock_movements`)   | données de gestion ; les prix appliqués et la snapshot client sont **figés** dans la transaction Pos au moment de la vente                                        |
| Edge Functions non fiscales            | `pos-customer-search`, `pos-customer-quotes`, `pos-resolve-prices`, `pos-stock-sync`, `pos-stock-adjust` | lecture de données métier ou synchronisation de stock (non fiscal, idempotent)                                                                                    |
| TPE bancaire, imprimante, tiroir       | matériel                                                                                                 | périphériques                                                                                                                                                     |
| Shopify / site ma-papeterie.fr         | vente en ligne                                                                                           | jamais appelé par la caisse                                                                                                                                       |

## 2. Flux de données

```
PWA ──(CheckoutPayload, JWT vendeur)──▶ pos-checkout ──▶ pos_finalize_sale (transaction SQL unique)
 │                                          │              numéro continu, recalcul des totaux,
 │                                          │              prev_hash + hash v1, JET, outbox stock
 │                                          ├──▶ Fiskaly SIGN FR (signature ; échec → pending_signature, rejoué 2 min)
 │                                          └──▶ ma-papeterie pos_apply_stock_movements (non fiscal, rejoué 1 min)
 ├──(montant)──▶ pont TPE ──TCP Caisse-AP──▶ TPE   (réponse stockée dans pos_payments.tpe_response)
 └──(TicketPayload)──▶ pont TPE ──ESC/POS──▶ imprimante
pg_cron ──▶ pos-closing (mensuelle 1er 03:10 UTC, annuelle 1er janvier 03:20 UTC) ──▶ pos_compute_closing
pg_cron ──▶ pos-export-archive (1er 04:00 UTC) ──▶ pos_archive_data ──▶ ZIP ──▶ Storage pos-archives ──▶ pos_register_archive
```

Lectures ma-papeterie par la PWA : catalogue uniquement (clé anon, RPC `pos_search_products`,
`pos_product_by_ean`).

## 3. Ce qui est signé, haché, chaîné

| Objet                         | Empreinte                                                                                                                                                                                   | Chaînage                                                    | Vérification                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| Ticket (vente, remboursement) | SHA-256 de la chaîne canonique `v1` (SPEC §3 : numéro, caisse, `client_txn_id`, `business_at`, type, totaux, ventilation TVA, client, digest des lignes, digest des paiements, `prev_hash`) | `prev_hash` = hash du ticket précédent de la caisse         | `pos_verify_chain`, `@pos/core verifyChain`, `pnpm verify-chain` |
| Ticket                        | signature Fiskaly SIGN FR (`fiskaly_signature`, `fiskaly_record_id`)                                                                                                                        | —                                                           | tableau de bord / API Fiskaly                                    |
| Événement du JET              | SHA-256 `v1\|id\|register_id\|event_type\|payload\|created_at\|prev_hash` (SQL uniquement)                                                                                                  | par caisse                                                  | `pos_verify_events_chain`                                        |
| Clôture (Z, mois, année)      | SHA-256 `v1\|closing\|numéro\|type\|début\|fin\|nb tickets\|total TTC\|grand total perpétuel\|prev_hash` (SQL) ; signature Fiskaly de la clôture                                            | par caisse                                                  | `pos_verify_closings_chain`                                      |
| Archive mensuelle             | `manifest_sha256` (SHA-256 du manifeste canonique, qui contient le SHA-256 de chaque fichier) ; `hash = SHA-256(v1\|archive\|caisse\|début\|fin\|manifest_sha256\|prev_hash)`               | par caisse ; ancre = dernier ticket de l'archive précédente | `pos_verify_archives_chain`, `pnpm verify-archive`               |

Horodatages canoniques : ISO 8601 UTC à la milliseconde (`pos_canonical_ts` ≡ `canonicalIsoDate`).
Bornes de périodes (jour, mois, année) : heure légale de Paris (`pos_period_bounds`).

## 4. Règle de numérotation des versions

Format `MAJEURE.MINEURE.CORRECTIF` (ex. `0.1.0`), identique dans `pos_settings.software.version`,
les `package.json` des composants du périmètre et le ticket.

- **MAJEURE** : toute modification du périmètre fiscal ayant un effet sur l'enregistrement, la
  sécurisation, la conservation ou l'archivage (formule de hash, champs chaînés, règles de
  numérotation, clôtures, format d'archive, RPC d'écriture, suppression d'un contrôle). Elle impose
  une **nouvelle attestation individuelle** et une mise à jour de ce document.
- **MINEURE** : évolution fonctionnelle sans effet sur ces exigences (écran, ergonomie, nouveau
  moyen de recherche, périphérique).
- **CORRECTIF** : correction d'anomalie sans effet fonctionnel.

Les versions `0.x` sont antérieures à la mise en service ; la mise en service (bascule, voir
`docs/BASCULE.md`) se fait en **1.0.0**, date à laquelle l'attestation est signée. Les formats
versionnés (`v1` pour les hash, `pos-archive/v1` pour les archives) ne changent qu'avec une
version majeure, et les anciens formats restent vérifiables.

## 5. Traçabilité des versions

- Chaque ticket porte `compliance.version` ; chaque transaction `app_version` (version de la PWA
  qui l'a saisie) ; chaque archive `software.name/version` dans son manifeste.
- Le dépôt Git (`Neo52000/POS`, branche `main`) est la référence du code ; les migrations SQL sont
  appliquées par l'intégration GitHub Supabase à la fusion et leur historique est consultable dans
  `supabase_migrations.schema_migrations`.
