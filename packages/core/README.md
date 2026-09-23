# `@pos/core`

Logique métier partagée du POS Ma Papeterie (NF525), **sans dépendance runtime** : calcul panier,
TVA, hash canonique chaîné, codec Caisse-AP, types du ticket et du `CheckoutPayload`.
Référence normative : [`docs/SPEC.md`](../../docs/SPEC.md) §1 à §7.

Consommé par Node (`services/tpe-bridge`, `scripts/`) et par Vite (`apps/pos`). Le SHA-256 est
isolé dans `src/sha256.ts` :

| Fonction                                                            | Runtime                                             |
| ------------------------------------------------------------------- | --------------------------------------------------- |
| `sha256Hex`, `computeTransactionHash`, `linesDigest`, `verifyChain` | Node (`node:crypto` via `process.getBuiltinModule`) |
| `sha256HexAsync`, `computeTransactionHashAsync`, `*DigestAsync`     | WebCrypto (navigateur **et** Node)                  |

Hors Node, `sha256Hex` lève `SHA256_SYNC_UNAVAILABLE` : la PWA doit utiliser les variantes `*Async`.

## Scripts

```sh
pnpm --filter @pos/core typecheck
pnpm --filter @pos/core test
pnpm --filter @pos/core build        # → dist/ (ESM + .d.ts)
pnpm --filter @pos/core gen:vectors  # régénère src/__fixtures__/hash-vectors.json (+ prettier)
```

## Modules

- `money.ts` — `roundHalfAwayFromZero`, `formatEurCents` (`1 234,56 €`), `parseEuroToCents`.
- `vat.ts` — `normalizeVatRate` (`20` → `"20.00"`), `vatRateToBasisPoints`, `ttcToHtCents`,
  `htToTtcCents`, `VAT_RATES_FR`.
- `cart.ts` — `computeLine`, `computeCart`, `validatePayments`, `PAYMENT_METHOD_LABELS` (SPEC §2).
- `hashChain.ts` — `buildCanonicalString`, `computeTransactionHash[Async]`, `linesDigest`,
  `paymentsDigest`, `canonicalQty`, `canonicalDiscount`, `canonicalVatBreakdown`, `verifyChain`
  (SPEC §3).
- `caisseAp.ts` — `encodeFields`, `decodeFields`, `buildPaymentRequest`, `parsePaymentResponse`
  (SPEC §7).
- `ticket.ts` — `TicketPayload` et types associés, `buildTicketCode`, `paymentMethodLabel`
  (SPEC §6).
- `types.ts` — `CheckoutPayload`, `CheckoutResult`, codes d'erreur, `validateCheckoutPayload`
  (SPEC §4, validation manuelle sans zod).

## Vecteurs de hash — `src/__fixtures__/hash-vectors.json`

Générés par `scripts/gen-hash-vectors.ts` (sortie déterministe), rejoués côté TS
(`src/hashChain.test.ts`) et côté SQL (`scripts/sql-tests/03_hash_vectors.sql`, fonction
`pos_canonical_txn`). Les 6 vecteurs forment **une chaîne continue** (`ticket_number` 1 → 6 sur
`CAISSE-01`, `prev_hash` du n+1 = `hash` du n, `prev_hash` du premier = `''`) : `verifyChain`
sur l'ensemble doit renvoyer `{ ok: true }`.

```jsonc
{
  "version": 1,
  "spec": "docs/SPEC.md §3 — hash canonique v1",
  "generator": "packages/core/scripts/gen-hash-vectors.ts",
  "register_code": "CAISSE-01",
  "vectors": [
    {
      "name": "sale_single_line_20", // identifiant stable du cas
      "description": "…",
      "input": {
        // CanonicalTxnInput complet
        "ticket_number": 1,
        "register_code": "CAISSE-01",
        "client_txn_id": "<uuid v4>",
        "business_at": "2026-09-23T08:15:07.123Z", // ISO 8601 UTC, millisecondes
        "kind": "sale", // 'sale' | 'refund'
        "total_ht_cents": 833,
        "total_vat_cents": 167,
        "total_ttc_cents": 1000,
        "vat_breakdown": [
          // triés par taux croissant (numérique)
          { "rate": "20.00", "base_ht_cents": 833, "vat_cents": 167, "ttc_cents": 1000 },
        ],
        "customer_account_id": null, // uuid ou null → '' dans la chaîne
        "lines": [
          // triées par line_no dans le digest
          {
            "line_no": 1,
            "product_id": "<uuid> | null", // null → ''
            "ean": "<string> | null", // null → ''
            "label": "Cahier 96p",
            "qty": 1, // number, ≤ 3 décimales
            "unit_price_ttc_cents": 1000,
            "vat_rate": "20.00", // chaîne canonique 2 décimales
            "discount_percent": 0, // number → "0.00" dans le digest
            "line_ttc_cents": 1000,
          },
        ],
        "payments": [
          // triés par (method, amount_cents, reference)
          { "method": "cash", "amount_cents": 1000, "reference": null }, // null → ''
        ],
        "prev_hash": "", // '' pour le premier ticket
      },
      "canonical_string": "v1|1|CAISSE-01|…|<lines_digest>|<payments_digest>|",
      "lines_digest": "<sha256 hex>", // SHA-256 du texte des lignes (séparateur \n)
      "payments_digest": "<sha256 hex>", // SHA-256 du texte des paiements (séparateur \n)
      "hash": "<sha256 hex minuscules>", // SHA-256(canonical_string)
    },
  ],
}
```

### Rappels pour le portage SQL (`pos_canonical_txn`)

- Chaîne : `v1|ticket_number|register_code|client_txn_id|business_at|kind|total_ht|total_vat|total_ttc|vat_breakdown|customer_account_id|lines_digest|payments_digest|prev_hash`,
  `null` → chaîne vide, aucun espace.
- `business_at` : `to_char(business_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.
- `vat_breakdown` : `rate:base_ht:vat:ttc` joints par `;`, taux trié **numériquement**, `rate`
  formaté à 2 décimales (`numeric(5,2)::text`).
- Ligne du `lines_digest` :
  `line_no|product_id|ean|label|qty|unit_price_ttc_cents|vat_rate|discount_percent|line_ttc_cents`
  - `qty` sans zéros inutiles : `1`, `2.5`, `-1`, `0.125` → en SQL
    `rtrim(rtrim(qty::text, '0'), '.')` sur un `numeric(10,3)` (attention à `0.000` → `0`) ;
  - `discount_percent` toujours à 2 décimales : `0.00`, `10.00` (`numeric(5,2)::text`) ;
  - `label` inséré tel quel (pas d'échappement de `|` ni de `\n`).
- Ligne du `payments_digest` : `method|amount_cents|reference`, tri par `method` (ordre des code
  units, i.e. `COLLATE "C"`), puis `amount_cents` numérique, puis `reference` (`''` si null).
- Digests et hash : `encode(digest(text, 'sha256'), 'hex')` (pgcrypto), minuscules.
- Liste vide de paiements ou de lignes → SHA-256 de la chaîne vide
  (`e3b0c442…b855`).

Les tests (`*.test.ts`) vivent à côté des sources ; `tsconfig.build.json` les exclut de `dist/`.
