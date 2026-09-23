# Runbook ingénierie — Ma Papeterie POS

## Prérequis
- Node ≥ 20, pnpm 10 (`corepack enable`), Deno 2 (`npm i -g deno`) pour les Edge Functions.
- Accès au projet Supabase `ma-papeterie` (`mgojmkzovqgpipybelrr`) : CLI Supabase (`supabase link`) ou MCP.

## Commandes
| Commande | Rôle |
|---|---|
| `pnpm install` | Installe tous les workspaces |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm test` / `pnpm build` | Qualité (identique à la CI) |
| `pnpm dev:pos` | PWA en dev (`http://localhost:5173`) |
| `pnpm dev:bridge` | Pont TPE local (port 8787) — lit `services/tpe-bridge/bridge.config.json` |
| `pnpm dev:tpe-sim` | Simulateur de TPE Caisse-AP (TCP 8888) |
| `pnpm e2e` | Playwright (PWA + simulateur + Fiskaly mock) |
| `pnpm verify-chain [CODE]` | Vérifie la chaîne de hash d'une caisse (local + SQL) |
| `pnpm smoke:fiskaly [N] [CODE]` | Ventes de bout en bout via `pos-checkout` |
| `cd supabase/functions && deno check */index.ts && deno lint` | Typecheck/lint des Edge Functions |

## Variables d'environnement
- PWA (`apps/pos/.env`) : `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_BRIDGE_URL` (défaut `http://localhost:8787`), `VITE_APP_VERSION`.
- Edge Functions (secrets Supabase) : `FISKALY_MODE` (`mock` | `live`), `FISKALY_BASE_URL`, `FISKALY_API_KEY`, `FISKALY_API_SECRET` (+ `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` fournis par la plateforme).
- Scripts : `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

## Migrations
1. Les migrations vivent dans `supabase/migrations/` (préfixe `20260923…_pos_*`). Objets tous préfixés `pos_`.
2. Application : `supabase db push --include-all` (CLI liée) ou, depuis Claude Code, MCP Supabase `apply_migration` fichier par fichier dans l'ordre.
3. `20260923000008_pos_cron.sql` contient un placeholder `<SERVICE_ROLE_KEY>` : à remplacer avant application (jamais commité renseigné).
4. Après application : `supabase gen types typescript --project-id mgojmkzovqgpipybelrr --schema public > apps/pos/src/types/supabase.ts`.
5. **Recopier** chaque migration dans le dépôt `Neo52000/ma-papeterie` (`supabase/migrations/`) par PR pour garder `db reset` cohérent là-bas.
6. Tests SQL : `scripts/sql-tests/*.sql`, rejouables, écrivent sur une caisse `TEST-01` (les données restent : immutabilité).

## Edge Functions
- Déploiement : `supabase functions deploy pos-checkout` (etc.) ou MCP `deploy_edge_function`. `verify_jwt=false` dans `config.toml` : l'auth est faite dans le code (`_shared/auth.ts`).
- `FISKALY_MODE=mock` par défaut : signatures déterministes, aucun appel réseau. Passer en `live` avec les clés du dashboard Fiskaly (TEST puis LIVE).
- Contrat Fiskaly : uniquement dans `_shared/fiskaly/types.ts` et `client.ts`.

## Rôle vendeur
```sql
insert into public.user_roles (user_id, role) values ('<uuid auth.users>', 'pos');
```

## Déploiement PWA
Site Netlify dédié (`pos.ma-papeterie.fr`), build défini dans `netlify.toml`. Variables `VITE_*` dans les settings Netlify.
