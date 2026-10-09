# Import des anciennes ventes boutique dans le dashboard

Objectif : retrouver l'historique boutique (CA jour par jour, tickets, top produits, analyse
météo) dans le dashboard `/admin` de ma-papeterie.fr, **avant** la période déjà présente.

**Hors périmètre fiscal.** Les ventes importées vont uniquement dans le projet Supabase
ma-papeterie (`pos_nf525_sales`, lecture du dashboard). Elles n'entrent jamais dans la base
fiscale Pos : ni numéro, ni empreinte, ni clôture. Les ventes de l'ancien logiciel gardent leur
valeur fiscale dans ses propres archives, **à conserver 6 ans**.

## 1. Ce que le dashboard contient déjà

| Source                          | Canal dashboard | Période présente (29/09/2026) |
| ------------------------------- | --------------- | ----------------------------- |
| Shopify POS (`shopify_orders`)  | `pos`           | depuis le **01/08/2026**      |
| Caisse NF525 (`pos-sales-sync`) | `pos`           | à la mise en service          |

> Pour l'historique **Shopify** lui-même (caisse Shopify POS et boutique en ligne), ne pas
> utiliser ce script : voir `docs/IMPORT-VENTES-SHOPIFY.md`, qui réintègre les commandes dans
> `shopify_orders` avec le bon canal (caisse / boutique) depuis l'export CSV du back-office.

Par défaut, l'import **s'arrête la veille du premier jour déjà présent** (calculé à chaque
lancement) : pas de double comptage. `--before AAAA-MM-JJ` impose une autre limite.

## 2. Exporter depuis l'ancien logiciel

Un fichier **CSV avec une ligne par article vendu** (le « journal des ventes » ou « détail des
tickets », pas le récapitulatif des Z). Excel : _Enregistrer sous › CSV (séparateur : point-virgule)_.

| Colonne           | Obligatoire   | Exemples d'en-têtes reconnus             |
| ----------------- | ------------- | ---------------------------------------- |
| date (± heure)    | oui           | `Date`, `Date vente`, `28/09/2026 14:05` |
| n° de ticket      | oui           | `N° ticket`, `Ticket`, `Numéro`          |
| montant TTC ligne | oui (1 des 2) | `Total TTC`, `Montant TTC`               |
| prix unitaire TTC | oui (1 des 2) | `PU TTC`, `Prix unitaire TTC`            |
| quantité          | non (1)       | `Qté`, `Quantité`                        |
| taux de TVA       | non (20 %)    | `TVA`, `Taux TVA` (`20`, `5,5 %`, `0,2`) |
| libellé           | non           | `Désignation`, `Libellé`, `Article`      |
| EAN               | non           | `EAN`, `Code barre`, `Gencod`            |
| mode de règlement | non           | `Règlement`, `Mode de paiement`          |
| caisse            | non           | `Caisse`, `Poste`                        |

Montants au format français (`1 234,56 €`) ou anglais ; remboursements en montants négatifs.
En-têtes différents : fichier `mapping.json`, ex. `{"ticket": "Réf. vente", "line_ttc": "Net TTC"}`.
Exemple complet : `scripts/legacy-sales/exemple.csv`.

## 3. Simuler (aucune écriture)

```bash
export MAPAP_SUPABASE_URL=https://mgojmkzovqgpipybelrr.supabase.co
export MAPAP_SERVICE_ROLE_KEY=…            # clé service_role du projet ma-papeterie
pnpm import-legacy-sales ventes-2025.csv --source nom-du-logiciel --report rejets.csv
```

La simulation affiche : colonnes reconnues, limite anti-doublon, période, nombre de tickets et
remboursements, **CA TTC par mois**, lignes rattachées au catalogue par EAN, rejets.

**Contrôle obligatoire avant import** : comparer le CA par mois avec les Z mensuels de l'ancien
logiciel (écart attendu : nul, ou limité aux lignes rejetées listées dans `rejets.csv`).

## 4. Importer

Même commande avec `--apply`. Envoi par lots de 200 tickets ; un ticket invalide est signalé sans
bloquer les autres. **Relancer est sans risque** : identifiants déterministes (source + caisse +
jour + n° de ticket), un ticket déjà importé est ignoré. Utiliser toujours la même `--source`.

Stockage : caisse `HIST-<caisse>`, `signature_status = 'legacy_import'`, n° de ticket
`AAAAMMJJ` × 10⁶ + n° d'origine (les anciens numéros qui repartent à 1 chaque jour restent uniques).

## 5. Vérifier puis, si besoin, retirer

```sql
-- Contrôle (projet ma-papeterie)
SELECT to_char(business_date, 'YYYY-MM') AS mois, count(*) FILTER (WHERE kind = 'sale') AS tickets,
       sum(total_ttc) AS ca_ttc
FROM pos_nf525_sales WHERE register_code LIKE 'HIST-%' GROUP BY 1 ORDER BY 1;

-- Retrait complet de l'import (les lignes suivent par ON DELETE CASCADE)
DELETE FROM pos_nf525_sales WHERE register_code LIKE 'HIST-%';
```

Le retrait ne touche ni les ventes Shopify, ni les ventes de la caisse NF525.
