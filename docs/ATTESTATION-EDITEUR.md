# Attestation individuelle de l'éditeur — modèle à compléter

> **AVERTISSEMENT — À LIRE AVANT TOUTE SIGNATURE**
>
> **1. Ce document est un gabarit de travail, pas le modèle officiel.** Avant de le signer,
> comparez-le mot à mot au modèle publié par l'administration (BOI-LETTRE-000242, en vigueur à
> la date de signature, sur bofip.impots.gouv.fr) et reprenez **la rédaction officielle** en cas
> d'écart. Seul le modèle officiel fait foi.
>
> **2. Cadre légal applicable (vérifié le 24/09/2026).** La loi de finances pour 2025
> (loi n° 2025-127 du 14 février 2025, art. 43) avait supprimé l'attestation individuelle de
> l'éditeur au profit du seul certificat d'un organisme accrédité (NF525 / LNE), avec une période
> transitoire. **La loi de finances pour 2026 (art. 125) l'a rétablie à compter du 21 février
> 2026** : l'assujetti peut de nouveau justifier de la conformité de sa caisse par le certificat
> **ou** par l'attestation individuelle de l'éditeur. Avant signature, relire le BOFiP à jour
> (BOI-TVA-DECLA-30-10-30 et le modèle BOI-LETTRE-000242) : le texte rétabli peut avoir ajouté des
> exigences de forme ou de contenu. `docs/ISCA-PROCEDURES.md` reste le dossier de preuve à joindre
> et servirait de base à une certification volontaire.
>
> **3.** Une attestation n'est valable que pour la **version majeure** désignée ; toute nouvelle
> version majeure (règle : `docs/PERIMETRE-NF525.md` §4) impose une nouvelle attestation.

Les passages entre crochets `[…]` sont à compléter ; les autres reprennent la substance du modèle
et doivent être alignés sur sa rédaction exacte.

---

## ATTESTATION INDIVIDUELLE

relative à l'utilisation d'un logiciel ou d'un système de caisse satisfaisant aux conditions
d'inaltérabilité, de sécurisation, de conservation et d'archivage des données en vue du contrôle
de l'administration fiscale, prévues au 3° bis du I de l'article 286 du code général des impôts
(BOI-LETTRE-000242)

### Volet 1 — Identification et engagement de l'éditeur

Je soussigné(e), **[Nom Prénom d'Élie]**, entrepreneur individuel (micro-entreprise),
**éditeur** du logiciel de caisse désigné ci-dessous :

| Rubrique                      | Valeur                                 |
| ----------------------------- | -------------------------------------- |
| Dénomination / nom commercial | [Nom Prénom d'Élie] — micro-entreprise |
| SIRET                         | [SIRET à 14 chiffres]                  |
| Adresse                       | [adresse postale complète]             |
| Courriel / téléphone          | [contact]                              |

atteste que le logiciel de caisse :

| Rubrique                                    | Valeur                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nom du logiciel                             | **[Ma Papeterie POS]**                                                                                                                                                                                                                                                         |
| Numéro de la version majeure                | **[1]** (version installée : [1.0.0])                                                                                                                                                                                                                                          |
| Date de mise sur le marché de cette version | [JJ/MM/AAAA]                                                                                                                                                                                                                                                                   |
| Composants du périmètre fiscal              | base Supabase « Pos » (tables et RPC `pos_*`), Edge Functions `pos-checkout`, `pos-sign-pending`, `pos-closing`, `pos-closings-sync`, `pos-export-archive`, application caisse (PWA), bibliothèque `@pos/core`, signature Fiskaly SIGN FR — détail : `docs/PERIMETRE-NF525.md` |

satisfait, dans cette version majeure, aux conditions d'**inaltérabilité**, de **sécurisation**,
de **conservation** et d'**archivage** des données en vue du contrôle de l'administration fiscale,
prévues au 3° bis du I de l'article 286 du code général des impôts, selon les modalités décrites
dans `docs/ISCA-PROCEDURES.md` :

- inaltérabilité : enregistrement par procédures serveur exclusives, interdiction technique de
  toute modification ou suppression, numérotation continue, chaînage SHA-256 des tickets, du
  journal des événements, des clôtures et des archives ;
- sécurisation : signature électronique des tickets et clôtures (Fiskaly SIGN FR), clôtures
  journalière, mensuelle et annuelle avec grand total perpétuel, journal des événements
  techniques, contrôle d'accès nominatif ;
- conservation : conservation intégrale des données en base, sans purge, et copie des signatures
  chez le prestataire de signature ;
- archivage : archive mensuelle horodatée, empreintes SHA-256 par fichier et manifeste chaîné,
  vérifiable par un outil fourni (`pnpm verify-archive`).

Je m'engage à ce que les versions mineures ultérieures de cette version majeure n'affectent pas
ces conditions, et à délivrer une nouvelle attestation pour toute nouvelle version majeure.

Fait à [ville], le [JJ/MM/AAAA]

Signature de l'éditeur : ______________________

### Volet 2 — Identification de l'assujetti utilisateur

La présente attestation est délivrée à :

| Rubrique                   | Valeur                                   |
| -------------------------- | ---------------------------------------- |
| Dénomination sociale       | **Reine & Fils SAS**                     |
| SIREN / SIRET              | [SIREN] / [SIRET de l'établissement]     |
| Adresse de l'établissement | 10 rue Toupot de Béveaux, 52000 Chaumont |
| Enseigne                   | Ma Papeterie                             |
| Représentant légal         | [Nom Prénom, qualité]                    |

pour l'utilisation du logiciel **[Ma Papeterie POS]**, version majeure **[1]**, installé et utilisé
à compter du **[JJ/MM/AAAA]** (date de bascule, `docs/BASCULE.md`) sur les caisses :

| Code caisse   | Poste                | Système de signature Fiskaly |
| ------------- | -------------------- | ---------------------------- |
| [CHAUMONT-01] | [PC comptoir / iPad] | [identifiant system Fiskaly] |

Fait à [ville], le [JJ/MM/AAAA]

Signature de l'éditeur : ______________________ Reçu par l'assujetti (signature, cachet) : ______________________

---

## Conservation de l'attestation

- L'original signé est conservé par Reine & Fils SAS et présenté à toute demande de
  l'administration ; une copie est conservée par l'éditeur.
- Joindre en annexe (recommandé) : `docs/PERIMETRE-NF525.md` et `docs/ISCA-PROCEDURES.md` dans la
  version correspondant à la version majeure attestée, et la sortie de `pnpm verify-chain` du jour
  de mise en service.
- Défaut de justificatif : amende prévue à l'article 1770 duodecies du CGI par logiciel ou système
  concerné (montant à vérifier à la date de signature).
