# Fiche de recette — imprimante Star mPOP

À imprimer et remplir sur place. Durée : **45 min**. Prérequis : installation faite selon
`docs/IMPRIMANTE-STAR-MPOP.md` §1 (Windows) ou §2 (Linux), rouleau 58 mm en place, pont ≥ 0.2.0.

| Date | Poste (PC comptoir) | Liaison (USB / BT) | N° de série mPOP | Opérateur |
| ---- | ------------------- | ------------------ | ---------------- | --------- |
|      |                     |                    |                  |           |

Commandes (dossier du pont, ex. `C:\ProgramData\MaPapeterie\tpe-bridge`) :

```
node dist\recette.js diag                   :: lit la config, sonde l'imprimante
node dist\recette.js codepage               :: page de diagnostic (page de codes, émulation)
node dist\recette.js                        :: toutes les étapes à la suite
node dist\recette.js ticket --out recette   :: écrit recette\recette-ticket.bin sans imprimer
```

Le pont peut rester démarré. Chaque étape affiche ce qu'il faut constater.

## Phase A — Matériel et liaison (sans la caisse)

| #   | Action                                                                          | Attendu                                                       | OK / KO | Observation |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------- | ----------- |
| A1  | Maintenir FEED à l'allumage de l'mPOP                                           | page d'auto-test imprimée (émulation, interface USB lisibles) |         | émulation : |
| A2  | Windows : `copy /b recette\recette-ticket.bin \\localhost\mPOP` (après `--out`) | ticket imprimé : le partage et le pilote transmettent en RAW  |         |             |
| A3  | `node dist\recette.js diag`                                                     | `imprimante JOIGNABLE`, `jeu=star largeur=32 massicot=false`  |         |             |

## Phase B — Page de codes et émulation

| #   | Action                          | Attendu                                                                                    | OK / KO | Observation                |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------ | ------- | -------------------------- |
| B1  | `node dist\recette.js codepage` | la ligne `[4] CP858` affiche `é è ê à ù ç ô î « » € £ °`                                   |         | ligne lisible : [4] / [32] |
| B2  | même page                       | `GRAS` en gras, `DOUBLE` agrandi, `CENTRE` centré, `DROITE` à droite, sans lettre parasite |         |                            |
| B3  | même page                       | la règle `1234567890…` tient sur **une** ligne                                             |         |                            |

Décision B (reporter dans `bridge.config.json`, puis `nssm restart MaPapeterieTpeBridge`) :

| Constat                                            | Action                                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `[4]` lisible                                      | rien à changer (défaut)                                                                                    |
| seule `[32]` lisible                               | `"codepageNumber": 32`                                                                                     |
| aucune lisible                                     | utilitaire Star (paramètres de l'imprimante) : page de codes 858, puis relancer B1                         |
| `E`, `F`, `i`, `a` parasites autour de GRAS/DOUBLE | mPOP en émulation ESC/POS : repasser en **StarPRNT** (utilitaire Star) ; à défaut `"commandSet": "escpos"` |
| règle coupée sur 2 lignes                          | `"width": 30`                                                                                              |

## Phase C — Documents de caisse (outil de recette)

| #   | Action                           | Attendu                                                                                                                        | OK / KO | Observation |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------- |
| C1  | `node dist\recette.js ticket`    | en-tête centré, `DUPLICATA`, « œuvre » → `oeuvre`, `1 234,56 €` complet, TVA 5,5 % et 20 % sur 2 lignes par taux, rendu 0,63 € |         |             |
| C2  | idem                             | dernière ligne entièrement au-dessus de la barre de découpe, déchirure nette                                                   |         |             |
| C3  | `node dist\recette.js formation` | `FORMATION` en grand, « Formation : aucune empreinte », aucune signature                                                       |         |             |
| C4  | `node dist\recette.js rapport`   | `CLÔTURE JOURNALIÈRE Z1`, montants à 8 chiffres complets, grand total perpétuel reporté à la ligne                             |         |             |
| C5  | `node dist\recette.js tiroir`    | le tiroir s'ouvre, rien ne s'imprime                                                                                           |         |             |

## Phase D — Bout en bout depuis la caisse

| #   | Action                                                                           | Attendu                                                                          | OK / KO | Observation |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------- | ----------- |
| D1  | Réglages › Tester la connexion                                                   | `imprimante device joignable`                                                    |         |             |
| D2  | Réglages › Test imprimante                                                       | ticket de test 32 colonnes                                                       |         |             |
| D3  | En-tête › Tiroir (motif « recette »)                                             | tiroir ouvert ; événement `drawer_opened` au journal                             |         |             |
| D4  | Réglages › Démarrer le mode formation ; vente d'un article en espèces avec rendu | ticket `FORM-0001` marqué FORMATION, tiroir ouvert, rendu correct                |         |             |
| D5  | Rapports › Lecture X › Éditer puis Imprimer (en formation)                       | X « FORMATION — sans valeur »                                                    |         |             |
| D6  | Quitter la formation ; Historique › un ticket réel › Duplicata                   | ticket réel `DUPLICATA` ; événement `reprint`                                    |         |             |
| D7  | Débrancher l'USB puis imprimer un duplicata                                      | message « Imprimante indisponible », ticket affiché à l'écran, caisse utilisable |         |             |
| D8  | Rebrancher, réimprimer                                                           | impression normale sans redémarrer le pont                                       |         |             |

La première vraie clôture (Z1 imprimé automatiquement) se vérifie au soir de la mise en service.

## Phase E — Endurance

| #   | Action                                                                         | Attendu                                       | OK / KO | Observation |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------- | ------- | ----------- |
| E1  | 10 tickets à la suite : `for /l %i in (1,1,10) do node dist\recette.js ticket` | 10 tickets complets, aucun mélangé ni tronqué |         |             |
| E2  | Laisser l'mPOP 15 min en veille, puis Test imprimante                          | impression au premier essai                   |         |             |

## Verdict

- [ ] **Recette prononcée** : phases A à E conformes.
- [ ] **Réserves** (numéros et actions) : ………………………………………………………………
- [ ] **Refus** : problème bloquant (A2, B1, B2 ou C1 KO sans solution dans la décision B).

Configuration retenue (`printer` de `bridge.config.json`) : ……………………………………………………

Signature : ……………………
