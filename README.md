# Ma Papeterie POS

Caisse NF525 (PWA + pont TPE + Supabase + Fiskaly SIGN FR) pour la boutique Ma Papeterie, Chaumont.

- Architecture : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Spécification partagée (calculs, hash, payloads, API) : [`docs/SPEC.md`](docs/SPEC.md)
- Runbook : [`docs/ENGINEERING.md`](docs/ENGINEERING.md)

```bash
pnpm install
pnpm test && pnpm typecheck && pnpm lint
pnpm dev:tpe-sim   # simulateur de TPE (TCP 8888)
pnpm dev:bridge    # pont TPE (HTTP 8787)
pnpm dev:pos       # PWA (5173)
```
