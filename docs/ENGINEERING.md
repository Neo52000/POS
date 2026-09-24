# Runbook ingénierie — Ma Papeterie POS

## Prérequis

- Node ≥ 20, pnpm 10 (`corepack enable`), Deno 2 (`npm i -g deno`) pour les Edge Functions.
- Deux projets Supabase : `Pos` (base fiscale, lié au dépôt GitHub `Neo52000/POS`, branche de production `main`) et `ma-papeterie` (`mgojmkzovqgpipybelrr`, données métier). Accès via le dashboard, la CLI (`supabase link`) ou le connecteur MCP.

## Commandes

| Commande                                                                          | Rôle                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm install`                                                                    | Installe tous les workspaces                                                                |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm test` / `pnpm build` | Qualité (identique à la CI)                                                                 |
| `pnpm dev:pos`                                                                    | PWA en dev (`http://localhost:5173`)                                                        |
| `pnpm dev:bridge`                                                                 | Pont TPE local (port 8787) — lit `services/tpe-bridge/bridge.config.json`                   |
| `pnpm dev:tpe-sim`                                                                | Simulateur de TPE Caisse-AP (TCP 8888)                                                      |
| `pnpm e2e`                                                                        | Playwright (PWA + simulateur + Fiskaly mock)                                                |
| `pnpm verify-chain [CODE]`                                                        | Audit tickets (local + SQL), JET, clôtures, archives ; toutes les caisses actives sans code |
| `pnpm verify-archive <zip> [--manifest-sha256 <hex>]`                             | Vérifie un ZIP d'archive `pos-archive/v1` (code de sortie 0/1/2)                            |
| `pnpm --filter @pos/core gen:archive-vector`                                      | Régénère le vecteur d'archive (uniquement pour un nouveau format)                           |
| `pnpm smoke:fiskaly [N] [CODE]`                                                   | Ventes de bout en bout via `pos-checkout`                                                   |
| `cd supabase/functions && deno check */index.ts && deno lint`                     | Typecheck/lint des Edge Functions (`deno.lock` à jour, `npm:fflate@0.8`)                    |

## Variables d'environnement

- PWA (`apps/pos/.env`) : `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (projet Pos), `VITE_CATALOG_SUPABASE_URL`, `VITE_CATALOG_SUPABASE_ANON_KEY` (projet ma-papeterie, lecture catalogue), `VITE_BRIDGE_URL` (défaut `http://localhost:8787`), `VITE_APP_VERSION`.
- Edge Functions (secrets du projet Pos) : `FISKALY_MODE` (`mock` | `live`), `FISKALY_BASE_URL`, `FISKALY_API_KEY`, `FISKALY_API_SECRET`, `MAPAP_SUPABASE_URL`, `MAPAP_SERVICE_ROLE_KEY` (clé service de ma-papeterie) (+ `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` fournis par la plateforme).
- Vault (projet Pos) : `pos_functions_url` (créé par migration), `pos_service_role_key` (à créer par l'admin, même valeur que `SUPABASE_SERVICE_ROLE_KEY` des Edge Functions) — utilisés par `pos_cron_call`.
- Scripts : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (`verify-archive` : facultatifs, pour lire l'empreinte attendue dans `pos_archives`).
- Pont TPE : `bridge.config.json` (dont `tls` pour l'iPad), `BRIDGE_TOKEN`, `LOG_LEVEL`.

## Migrations

1. **Projet Pos** : `supabase/migrations/`. Appliquées automatiquement par l'intégration GitHub Supabase à chaque fusion dans `main` (branche de production). **Règle de nommage** : quand une migration est appliquée via le connecteur MCP (`apply_migration`), Supabase enregistre une version = horodatage d'application ; le fichier du dépôt doit porter **exactement cette version** (`SELECT version, name FROM supabase_migrations.schema_migrations`) sinon `supabase db push` refuse l'historique. Toutes les migrations sont idempotentes.
2. Le cron (`…_pos_cron_vault.sql`) lit l'URL des fonctions et la clé service dans **Vault** (`ALTER DATABASE … SET` est interdit sur Supabase). À faire une fois par l'admin dans le SQL Editor de Pos :
   `SELECT vault.create_secret('<service_role_key du projet Pos>', 'pos_service_role_key');`
   Tant que ce secret manque, `pos_cron_call` journalise un NOTICE et n'appelle rien.
3. `…_pos_hash_vectors_check.sql` rejoue les vecteurs de hash de `@pos/core` : la migration **échoue** si l'implémentation SQL diverge du TypeScript (garde-fou). Après `pnpm --filter @pos/core gen:vectors`, régénérer le JSON avec `python3 scripts/gen-hash-vectors-sql.py` et créer une nouvelle migration.
4. **Projet ma-papeterie** : `supabase-mapapeterie/migrations/` (RPC catalogue anon, RPC service role clients/tarifs/devis/stock, table `pos_stock_movements`). Appliquées via le connecteur (même règle de nommage) ; **recopier** dans le dépôt `Neo52000/ma-papeterie` par PR.
5. Types : `supabase gen types typescript --project-id jntngwbdsaexustzmaii --schema public > apps/pos/src/types/supabase.ts` (la PWA utilise pour l'instant des types maison dans `src/types/pos.ts`).
6. Tests SQL : `scripts/sql-tests/pos/*.sql` (projet Pos) et `scripts/sql-tests/mapapeterie/*.sql`, rejouables, écrivent sur une caisse `TEST-01` (les données restent : immutabilité). Via le SQL Editor : coller le script tel quel. Via le connecteur (lecture seule pour `execute_sql`) : les exécuter avec `apply_migration` en remplaçant la table temporaire par `public.pos_test_results`, puis rejouer `…_pos_test_cleanup.sql`. Résultat de la session du 23/09/2026 : Pos 60 étapes vertes (01, 02, 04, 05, 06) + 6 vecteurs de hash ; ma-papeterie 6 étapes vertes (`01_bridge_functions`, effet net nul sur le stock), nettoyage par `…_pos_bridge_test_cleanup.sql`.

## Edge Functions

- Déploiement : `supabase functions deploy pos-checkout` (etc.) ou MCP `deploy_edge_function`. `verify_jwt=false` dans `config.toml` : l'auth est faite dans le code (`_shared/auth.ts`).
- `FISKALY_MODE=mock` par défaut : signatures déterministes, aucun appel réseau. Passer en `live` avec les clés du dashboard Fiskaly (TEST puis LIVE).
- Contrat Fiskaly : uniquement dans `_shared/fiskaly/types.ts` et `client.ts`.
- Les Edge Functions n'importent pas `packages/core` (spécificateurs `.js`, déploiement limité à `supabase/functions`) : le code partagé est recopié dans `_shared/` (`ticket.ts`, `archive.ts`). `_shared/archive.ts` est un **miroir exact** sans import de `@pos/core` `archive.ts` : toute modification se fait des deux côtés, `pnpm --filter @pos/core test` (bloc « miroir Deno ») compare les deux sur `archive-vector.json`.
- Fonctions du lot 4-6 :

  | Fonction             | Auth                             | Appel                                                                                    |
  | -------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- |
  | `pos-closing`        | vendeur / admin / service        | `{period_type, period_start?, register_id?}` ; bornes `pos_period_bounds` (Europe/Paris) |
  | `pos-export-archive` | admin (`is_pos_admin`) / service | `{register_id?, period_start?}` ; cron `0 4 1 * *` UTC ; bucket `pos-archives`           |
  | `pos-stock-adjust`   | admin / service                  | `{items[1..200], reason, register_id?}` → RPC ma-papeterie `pos_set_stock_boutique`      |

  Relance manuelle d'une archive (idempotente) :
  `curl -X POST "$SUPABASE_URL/functions/v1/pos-export-archive" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" -H 'Content-Type: application/json' -d '{"period_start":"2026-10-15T12:00:00+02:00"}'`
  (une période non terminée est renvoyée dans `skipped` avec `PERIOD_NOT_ENDED`).

## Rôle vendeur (projet Pos)

```sql
insert into public.pos_user_roles (user_id, role) values ('<uuid auth.users>', 'pos');
```

## Déploiement PWA

Site Netlify dédié (`pos.ma-papeterie.fr`), build défini dans `netlify.toml`. Variables `VITE_*` dans les settings Netlify.

## Documents d'exploitation

- `docs/HORS-LIGNE.md` — fonctionnement et dépannage hors ligne.
- `docs/PERIMETRE-NF525.md` — périmètre fiscal, flux, empreintes, règle de version.
- `docs/ISCA-PROCEDURES.md` — preuves et procédures (auditeur : `pnpm verify-chain`, `pnpm verify-archive`, `pos_verify_*`).
- `docs/ATTESTATION-EDITEUR.md` — gabarit d'attestation (lire l'avertissement).
- `docs/BASCULE.md` — check-list de mise en service J-7 → J+7 et retour arrière.
