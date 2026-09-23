# Scripts

| Script | Usage |
|---|---|
| `verify-chain.ts` | `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… pnpm verify-chain [CODE_CAISSE]` — recalcule la chaîne de hash localement (`@pos/core`) et via `pos_verify_chain`. |
| `fiskaly-sandbox-smoke.ts` | `… pnpm smoke:fiskaly [N] [CODE_CAISSE]` — N ventes + 1 remboursement via `pos-checkout`, vérification de chaîne, clôture de session. |
| `sql-tests/*.sql` | Tests SQL rejouables (exécuter dans l'ordre via SQL Editor / MCP `execute_sql`). Écrivent sur une caisse `TEST-01` dédiée. |
