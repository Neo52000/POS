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
   │ Supabase projet `ma-papeterie` (partagé avec le site)                       │
   │  • Edge Functions pos-* (Deno)  ──▶  Fiskaly SIGN FR (signature, clôtures) │
   │  • RPC SECURITY DEFINER pos_*  ──▶  tables pos_* (immutables, chaînées)    │
   │  • products.stock_boutique (source de vérité stock boutique)               │
   │  • customer_360 / customer_pricing / client_quotes (B2B, via RPC)          │
   └────────────────────────────────────────────────────────────────────────────┘
```

Shopify n'est **jamais** appelé par la caisse : le canal web garde `stock_online`, la boutique garde `stock_boutique`.

## Workspaces
| Workspace | Rôle |
|---|---|
| `packages/core` (`@pos/core`) | Logique pure et isomorphe : montants, TVA, calcul panier (SPEC §2), hash canonique (SPEC §3), codec Caisse-AP (SPEC §7), types `CheckoutPayload` / `TicketPayload`. Portée à l'identique en plpgsql. |
| `apps/pos` (`@pos/app`) | PWA caisse : recherche/scan, panier, paiements, ticket, sessions, historique, B2B. |
| `services/tpe-bridge` | Service local : pont HTTP ↔ TCP Caisse-AP (TPE), impression ESC/POS, tiroir, simulateur de TPE. |
| `supabase/migrations` | Schéma `pos_*`, immutabilité, chaînage, RPC, RLS, vues, crons. |
| `supabase/functions` | `pos-checkout`, `pos-sign-pending`, `pos-closing`, `pos-closings-sync`, `pos-customer-search`, `pos-customer-quotes` + `_shared/fiskaly` (adaptateur). |
| `scripts` | `verify-chain.ts` (audit de chaîne), `fiskaly-sandbox-smoke.ts`, tests SQL. |

## Flux d'une vente
1. La PWA construit le panier (`@pos/core.computeCart`) et encaisse : CB via le pont (`POST /payment` → trame Caisse-AP → `AE=10`), espèces, chèque, bon UCIA (= chèque avec référence), virement.
2. `POST /functions/v1/pos-checkout` avec `CheckoutPayload` (idempotent par `client_txn_id`).
3. `pos_finalize_sale` (une transaction Postgres) : verrou de caisse, numéro de ticket continu (`pos_counters`), recalcul serveur des totaux, contrôle des paiements, insertion transaction/lignes/paiements, décrément `stock_boutique` (négatif toléré et journalisé), `prev_hash` + `hash` SHA-256.
4. Signature Fiskaly (Record TRANSACTION/RECEIPT). Échec → `pending_signature`, rejoué par `pos-sign-pending` (cron 2 min). La vente reste valide.
5. Retour du `TicketPayload` → impression ESC/POS via le pont, ouverture tiroir si espèces.

## Garanties NF525 (ISCA)
- **Inaltérabilité** : écritures uniquement via RPC `SECURITY DEFINER` (REVOKE sur les tables), triggers interdisant UPDATE/DELETE (hors colonnes de signature), numérotation continue, chaîne SHA-256 par caisse (`pos_verify_chain`), JET local chaîné (`pos_events`).
- **Sécurisation** : signature Fiskaly de chaque transaction et des clôtures ; RLS `is_pos()` ; secrets uniquement côté Edge Functions.
- **Conservation** : Postgres (sauvegardes Supabase) + archives Fiskaly SAFE (7 ans).
- **Archivage** : export périodique signé (`pos-export-archive`, lot 5) + `pos_verify_chain`.

## Hors ligne (lot 4)
File locale IndexedDB, ticket provisoire `OFF-…`, rejeu FIFO ; numéro/hash/signature attribués au rejeu. Limites 50 transactions / 24 h ; clôture et remboursement interdits hors ligne.

## Décisions et alternatives écartées
- Stripe Terminal / TPE cloud : écarté (CDC) ; Caisse-AP over IP via pont local.
- `SEQUENCE` Postgres pour les tickets : écartée (trous en cas de rollback) → compteur verrouillé.
- Création de factures depuis la caisse : reportée ; vue `pos_transactions_to_invoice` pour l'ERP.
