# Runbook ingénierie — Ma Papeterie POS

## Prérequis

- Node ≥ 20, pnpm 10 (`corepack enable`), Deno 2 (`npm i -g deno`) pour les Edge Functions.
- Deux projets Supabase : `Pos` (base fiscale, lié au dépôt GitHub `Neo52000/POS`, branche de production `main`) et `ma-papeterie` (`mgojmkzovqgpipybelrr`, données métier). Accès via le dashboard, la CLI (`supabase link`) ou le connecteur MCP.

## Commandes

| Commande                                                                          | Rôle                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm install`                                                                    | Installe tous les workspaces                                              |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm test` / `pnpm build` | Qualité (identique à la CI)                                               |
| `pnpm dev:pos`                                                                    | PWA en dev (`http://localhost:5173`)                                      |
| `pnpm dev:bridge`                                                                 | Pont TPE local (port 8787) — lit `services/tpe-bridge/bridge.config.json` |
| `pnpm dev:tpe-sim`                                                                | Simulateur de TPE Caisse-AP (TCP 8888)                                    |
| `pnpm e2e`                                                                        | Playwright (PWA + simulateur + Fiskaly mock)                              |
| `pnpm verify-chain [CODE]`                                                        | Vérifie la chaîne de hash d'une caisse (local + SQL)                      |
| `pnpm smoke:fiskaly [N] [CODE]`                                                   | Ventes de bout en bout via `pos-checkout`                                 |
| `cd supabase/functions && deno check */index.ts && deno lint`                     | Typecheck/lint des Edge Functions                                         |

## Variables d'environnement

- PWA (`apps/pos/.env`) : `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (projet Pos), `VITE_CATALOG_SUPABASE_URL`, `VITE_CATALOG_SUPABASE_ANON_KEY` (projet ma-papeterie, lecture catalogue), `VITE_BRIDGE_URL` (défaut `http://localhost:8787`), `VITE_APP_VERSION`.
- Edge Functions (secrets du projet Pos) : `FISKALY_MODE` (`mock` | `live`), `FISKALY_BASE_URL`, `FISKALY_API_KEY`, `FISKALY_API_SECRET`, `MAPAP_SUPABASE_URL`, `MAPAP_SERVICE_ROLE_KEY` (clé service de ma-papeterie) (+ `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` fournis par la plateforme).
- Scripts : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Migrations

1. **Projet Pos** : `supabase/migrations/` (préfixe `20260923…_pos_*`). Appliquées automatiquement par l'intégration GitHub Supabase à chaque fusion dans `main` (branche de production). En développement : `supabase db push` (CLI liée à Pos) ou connecteur MCP ; si elles sont appliquées manuellement, enregistrer leurs versions dans `supabase_migrations.schema_migrations` pour éviter une double application.
2. Le cron (`…_pos_cron.sql`) lit `current_setting('app.settings.functions_url')` et `app.settings.service_role_key` : à définir une fois par l'admin (`ALTER DATABASE postgres SET app.settings.functions_url = 'https://<ref>.supabase.co/functions/v1'` etc.). pg_cron/pg_net doivent être activés sur Pos (plan Pro recommandé avant la bascule).
3. **Projet ma-papeterie** : `supabase-mapapeterie/migrations/` (RPC catalogue anon, RPC service role clients/tarifs/devis/stock, table `pos_stock_movements`). Appliquer manuellement (SQL Editor ou connecteur) et **recopier** dans le dépôt `Neo52000/ma-papeterie` par PR.
4. Types : `supabase gen types typescript --project-id <ref Pos> --schema public > apps/pos/src/types/supabase.ts`.
5. Tests SQL : `scripts/sql-tests/pos/*.sql` (projet Pos) et `scripts/sql-tests/mapapeterie/*.sql`, rejouables, écrivent sur une caisse `TEST-01` (les données restent : immutabilité).

## Edge Functions

- Déploiement : `supabase functions deploy pos-checkout` (etc.) ou MCP `deploy_edge_function`. `verify_jwt=false` dans `config.toml` : l'auth est faite dans le code (`_shared/auth.ts`).
- `FISKALY_MODE=mock` par défaut : signatures déterministes, aucun appel réseau. Passer en `live` avec les clés du dashboard Fiskaly (TEST puis LIVE).
- Contrat Fiskaly : uniquement dans `_shared/fiskaly/types.ts` et `client.ts`.

## Rôle vendeur (projet Pos)

```sql
insert into public.pos_user_roles (user_id, role) values ('<uuid auth.users>', 'pos');
```

## Déploiement PWA

Site Netlify dédié (`pos.ma-papeterie.fr`), build défini dans `netlify.toml`. Variables `VITE_*` dans les settings Netlify.
