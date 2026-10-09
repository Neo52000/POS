# Réintégrer l'historique des ventes Shopify (caisse + boutique en ligne)

Objectif : retrouver **tout** l'historique Shopify — ventes de la caisse Shopify POS **et**
commandes de la boutique en ligne — dans le dashboard `/admin` de ma-papeterie.fr (CA par jour
et par canal, commandes, panier moyen, marge, top produits, fiche client).

**Hors périmètre fiscal.** L'import écrit uniquement dans `shopify_orders` (projet Supabase
ma-papeterie), le registre des commandes Shopify déjà lu par le dashboard. Rien n'entre dans la
base fiscale `Pos` (NF525), ni dans `pos_nf525_sales` (réservée aux tickets de la caisse NF525),
ni dans `sales_orders` (une commande rattrapée n'est pas une commande « à traiter »). La valeur
fiscale des ventes Shopify POS reste dans les archives Shopify, **à conserver 6 ans**.

## 1. Ce que le dashboard contient déjà (mesuré le 09/10/2026)

| Canal (`v_admin_revenue_daily`) | `Source` Shopify              | Commandes présentes | Première   |
| ------------------------------- | ----------------------------- | ------------------- | ---------- |
| `pos` — caisse                  | `pos`                         | 240                 | 01/08/2026 |
| `web` — boutique en ligne       | `web`, `channel:<id>`, `<id>` | 17                  | 30/05/2026 |
| `draft` — comptoir (brouillon)  | `shopify_draft_order`         | 37                  | 03/08/2026 |

Le webhook `api/webhooks/shopify-order.ts` n'a été branché qu'en cours de route : tout ce qui
précède ces dates manque (la boutique est à la commande **#1297**, soit ~1 000 commandes
absentes). C'est ce trou que cet import comble.

Par défaut, l'import **s'arrête, canal par canal, la veille de la première commande déjà
présente** — pas de double comptage. `--before AAAA-MM-JJ` impose la même limite à tous les
canaux, `--all-days` la désactive (l'upsert reste sans écrasement : une commande déjà en base
n'est jamais modifiée).

## 2. Exporter depuis Shopify (seule source complète)

L'Admin API ne renvoie **que les 60 derniers jours** sans le scope `read_all_orders` — vérifié
sur la boutique : aucune commande antérieure au 10/08/2026 n'est lisible par l'API. L'export CSV
du back-office, lui, couvre tout l'historique.

Back-office Shopify › **Commandes** › **Exporter** › _Toutes les commandes_ ›
**CSV pour Excel** › Exporter. Shopify envoie le fichier par e-mail (quelques minutes).

- Ne retirer aucune colonne : `Id`, `Name`, `Created at`, `Total` et `Source` sont obligatoires
  (les autres — `Taxes`, `Lineitem *`, `Payment Method`, `Location`, `Refunded Amount`… —
  enrichissent le dashboard).
- En-têtes français ou anglais : les deux sont reconnus. En-tête exotique :
  `--map mapping.json`, ex. `{"total":"Total payé","source":"Canal"}`.
- Exemple de fichier attendu : `scripts/shopify-orders/exemple.csv`.

## 3. Simuler (aucune écriture)

```bash
export MAPAP_SUPABASE_URL=https://mgojmkzovqgpipybelrr.supabase.co
export MAPAP_SERVICE_ROLE_KEY=…            # clé service_role du projet ma-papeterie
pnpm import-shopify-orders orders_export.csv --report rejets.csv
```

La simulation affiche : canaux retenus, limite anti-doublon par canal, période, commandes à
importer / déjà en base / écartées, **CA TTC par mois et par canal**, rejets.

**Contrôle obligatoire avant import** : comparer le CA mensuel par canal avec
_Shopify › Analyses › Rapports › Ventes par canal_. Écart attendu : nul, ou limité aux lignes
listées dans `rejets.csv`.

## 4. Importer

Même commande avec `--apply`. Envoi par lots de 200 commandes.
**Relancer est sans risque** : clé naturelle `shopify_order_id`, résolution
`ignore-duplicates` — une commande déjà présente (webhook ou import précédent) n'est jamais
réécrite.

Options utiles :

| Option                | Effet                                                                |
| --------------------- | -------------------------------------------------------------------- |
| `--channels pos,web`  | canaux importés ; défaut `pos,web,draft` (`other` exclu)             |
| `--since AAAA-MM-JJ`  | premier jour importé                                                 |
| `--before AAAA-MM-JJ` | exclut ce jour et les suivants (remplace l'anti-doublon automatique) |
| `--all-days`          | désactive l'anti-doublon de période                                  |
| `--include-cancelled` | importe aussi les commandes annulées                                 |
| `--include-pending`   | importe aussi les commandes impayées (`pending`, `authorized`…)      |

Règles appliquées par défaut : une commande **annulée** ou dont le paiement est `voided` /
`expired` est écartée ; une commande **impayée** est écartée (elle gonflerait le CA) ; une
commande **remboursée** est conservée — la vente a eu lieu, et la vue exclut déjà
`refunded` / `voided` du CA, comme pour les commandes Shopify arrivées par webhook.

Les lignes importées sont marquées `raw_payload->>'imported_from' = 'shopify-csv-export'`, avec
`source_name`, `channel`, `payment_method`, `location`, `employee`, `refunded_amount` et
`cancelled_at` conservés dans `raw_payload`.

## 5. Vérifier puis, si besoin, retirer

```sql
-- Contrôle (projet ma-papeterie)
SELECT to_char(shopify_created_at AT TIME ZONE 'Europe/Paris', 'YYYY-MM') AS mois,
       raw_payload ->> 'channel' AS canal,
       count(*) AS commandes, sum(total_ttc)::numeric(12,2) AS ca_ttc
FROM shopify_orders
WHERE raw_payload ->> 'imported_from' = 'shopify-csv-export'
GROUP BY 1, 2 ORDER BY 1, 2;

-- Retrait complet de l'import (ne touche ni le webhook, ni la caisse NF525)
DELETE FROM shopify_orders WHERE raw_payload ->> 'imported_from' = 'shopify-csv-export';
```

## 6. Limites connues

- **Fenêtre du dashboard** : `v_admin_revenue_daily` et `v_admin_pos_weather_daily` ne
  regardent que **400 jours**. Les commandes plus anciennes sont bien en base (et visibles dans
  la fiche client / les requêtes SQL), mais n'apparaissent pas dans les séries de CA. Élargir la
  fenêtre est une décision à prendre côté ma-papeterie-v1, pas un effet de cet import.
- **Remboursements** : l'export CSV donne le montant remboursé, pas sa date. Il est conservé
  dans `raw_payload.refunded_amount` et la commande garde son statut `refunded` (exclue du CA par
  la vue) — pas de ticket d'avoir daté, contrairement aux remboursements de la caisse NF525.
- **Adresses** : `shipping_address` / `billing_address` restent `NULL` (l'export les éclate en
  colonnes séparées, inutiles au dashboard). Nom, e-mail et téléphone de facturation sont
  conservés.
- **Lignes « divers »** : un article sans SKU ne peut être rattaché à aucun produit du
  catalogue — il compte dans le CA, pas dans le top produits ni dans la marge.
- **Après la bascule** : la caisse NF525 alimente le canal `pos` via `pos-sales-sync`. Cet
  import ne sert donc qu'à l'historique **antérieur** à la bascule ; le relancer plus tard n'y
  ajoutera que d'éventuelles commandes boutique manquées.
