# Fonctionnement hors ligne (lot 4)

La caisse continue d'encaisser quand Internet ou Supabase est indisponible. Les ventes sont
mises en file sur le poste puis **rejouées** vers le serveur, qui seul attribue le numéro de
ticket, le hash chaîné et la signature Fiskaly. Rien n'est fiscalement « validé » hors ligne :
le ticket imprimé hors ligne est **provisoire**.

Références : SPEC §4-5 et §11, `apps/pos/src/lib/connectivity.ts`, `apps/pos/src/lib/offlineQueue.ts`,
RPC `pos_finalize_sale` / `pos_client_settings` (migration `…_pos_offline.sql`).

## 1. Détection de la connectivité

| Déclencheur                                           | Effet                                                    |
| ----------------------------------------------------- | -------------------------------------------------------- |
| Événement navigateur `offline`                        | passage **hors ligne** immédiat                          |
| Erreur réseau / délai dépassé d'une Edge Function     | passage **hors ligne** immédiat                          |
| Sonde `GET <SUPABASE_URL>/auth/v1/health` (délai 5 s) | statut < 500 → en ligne, sinon hors ligne                |
| Fréquence de la sonde                                 | toutes les **15 s** hors ligne, **60 s** en ligne        |
| Événement navigateur `online`                         | sonde immédiate (pas de retour en ligne « à l'aveugle ») |

Chaque transition est journalisée dans le JET : `offline_enter` (avec le début réel de la
coupure) puis `offline_exit`. Les événements produits hors ligne sont conservés localement et
envoyés au retour de la connexion (`pos_log_event`, `p_client_at` = heure du poste).

La barre d'état affiche `Hors ligne` (rouge) ou `Synchronisation…` pendant le rejeu. La page
**/offline** liste la file, les échecs, et permet « Réessayer » et « Exporter (JSON) ».

## 2. Vente hors ligne

1. Le vendeur encaisse normalement (espèces, chèque, bon UCIA, CB via le pont TPE : le pont est
   local et fonctionne sans Internet).
2. La PWA fixe `offline_queued: true`, `business_at` = heure du poste, et attribue une
   **référence provisoire** `OFF-<code caisse>-<YYYYMMDD>-<nnn>` (ex. `OFF-CHAUMONT-01-20260924-007`) :
   compteur local par caisse remis à 1 chaque jour (date Europe/Paris), jamais réutilisé tant que
   la file contient une référence du jour.
3. La vente est écrite dans IndexedDB (table `queue`, clé `client_txn_id`, ordre `local_seq`) et
   un **ticket provisoire** est imprimé : mention « provisoire », pas de numéro de ticket, pas
   de hash ni de signature.

### Limites (paramètres serveur)

Lues par `pos_client_settings()` à chaque retour en ligne et mises en cache sur le poste :

| Paramètre (`pos_settings`) | Défaut                                                        | Effet                                                              |
| -------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `offline_max_txns`         | 50                                                            | au-delà de 50 ventes en attente, nouvelle vente hors ligne refusée |
| `offline_max_hours`        | 24                                                            | si la plus ancienne vente en attente a plus de 24 h, vente refusée |
| `clock_tolerance`          | `{"online_minutes":10,"offline_hours":72,"future_minutes":5}` | contrôle serveur de `business_at` (§4)                             |

Une vente déjà débitée par CB alors que la limite vient d'être atteinte est quand même mise en
file (le client a payé) ; la limite bloque la vente **suivante**.

### Actions interdites hors ligne

| Action                                        | Raison                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Remboursement                                 | nécessite le ticket d'origine chaîné ; refusé aussi par le serveur (`VALIDATION`) |
| Ouverture / fermeture de session (Z)          | le Z doit inclure toutes les ventes, signées                                      |
| Recherche d'un **nouveau** client pro         | données ma-papeterie inaccessibles (seul un client déjà chargé reste utilisable)  |
| Inventaire (`/inventory`), clôtures, archives | écritures serveur uniquement                                                      |

## 3. Rejeu

- Déclenché au retour en ligne (sonde OK), puis à la demande depuis **/offline**.
- **FIFO** strict (`local_seq`), un seul rejeu à la fois (verrou Web Locks `pos-replay`).
- JWT rafraîchi s'il expire dans la minute ; session expirée → rejeu suspendu, reconnexion demandée.
- Chaque vente est envoyée telle quelle à `pos-checkout` (même `client_txn_id`, même
  `business_at`, même `provisional_ref`).
- **Idempotence** : un `client_txn_id` déjà enregistré renvoie la transaction existante
  (`idempotent_replay: true`) ; rejouer deux fois ne crée jamais deux tickets.
- Succès : l'élément passe `done`, le ticket définitif (numéro `T-AAAA-nnnnnn`, hash, signature)
  remplace le ticket provisoire dans l'historique ; la correspondance `provisional_ref` ↔ numéro
  reste en base (`pos_transactions.provisional_ref`).

### Rattachement à la session ouverte

Si la session d'origine a été fermée entre-temps, le serveur rattache la vente à la **session
ouverte** de la caisse (elle entre dans le Z suivant ; `business_date` d'origine conservée ; le Z
déjà calculé n'est jamais modifié) et journalise `offline_reattached`
(`original_session_id`, `session_id`, `provisional_ref`). Sans session ouverte :
`SESSION_NOT_OPEN` (409) → la vente reste en file et le rejeu reprend après l'ouverture.

### Échecs

| Réponse                                                                            | Traitement                                                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Erreur réseau                                                                      | élément remis `pending`, retour hors ligne, rejeu interrompu  |
| `SESSION_NOT_OPEN`, `UNAUTHORIZED`                                                 | élément remis `pending`, rejeu suspendu (bandeau d'action)    |
| Autre erreur métier (`BUSINESS_AT_OUT_OF_RANGE`, `TOTALS_MISMATCH`, `VALIDATION`…) | élément `failed`, JET `offline_replay_failed`, rejeu continue |

**Un élément en attente ou en échec bloque la clôture (Z)** : l'écran de clôture refuse tant que
la file n'est pas vide.

## 4. Bornes horaires côté serveur (anti-antidatage)

`pos_finalize_sale` contrôle `business_at` après l'idempotence :

- vente en ligne : `|business_at − now()| ≤ online_minutes` (10 min) ;
- vente hors ligne : `now() − offline_hours (72 h) ≤ business_at ≤ now() + future_minutes (5 min)`.

Hors bornes → `BUSINESS_AT_OUT_OF_RANGE` (422). Conséquence : une vente hors ligne doit être
rejouée **dans les 72 h** ; au-delà elle ne peut plus être enregistrée automatiquement (voir §6).
`pos_client_settings().server_now` permet à la PWA de mesurer la dérive de l'horloge du poste.

## 5. Procédure vendeur

1. Bandeau rouge « Hors ligne » : continuer à vendre normalement ; remettre au client le ticket
   **provisoire** (il porte la référence `OFF-…`).
2. Ne pas faire de remboursement ni de clôture : attendre le retour du réseau.
3. Vérifier la box / le Wi-Fi. Si la coupure dure, surveiller le compteur de la barre d'état
   (limite 50 ventes / 24 h).
4. Au retour du réseau, la synchronisation est automatique. Ouvrir **/offline** : la file doit
   être vide ; sinon « Réessayer ».
5. Avant le Z : file vide obligatoire. Si un élément reste en échec, ne pas le supprimer :
   exporter la file (JSON) et prévenir le responsable.

## 6. Dépannage

| Symptôme                                          | Cause probable / action                                                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reste « Hors ligne » alors qu'Internet fonctionne | sonde `auth/v1/health` bloquée (pare-feu, DNS) : ouvrir l'URL Supabase dans le navigateur ; recharger la PWA                                                                                                          |
| « Synchronisation » bloquée, message session      | aucune session ouverte : ouvrir la session, le rejeu reprend                                                                                                                                                          |
| Élément `failed` `BUSINESS_AT_OUT_OF_RANGE`       | horloge du poste fausse ou vente de plus de 72 h : corriger l'heure du poste ; au-delà de 72 h, l'administrateur relève temporairement `clock_tolerance.offline_hours` (SQL, tracé), relance, puis rétablit la valeur |
| Élément `failed` `TOTALS_MISMATCH` / `VALIDATION` | écart de calcul client/serveur : exporter la file, ouvrir un incident (ne pas ressaisir la vente à la main sans l'avoir analysée)                                                                                     |
| Nouvelle vente refusée « maximum 50 »             | limite atteinte : rétablir la connexion (partage 4G) et synchroniser                                                                                                                                                  |
| Ticket provisoire à rapprocher                    | `select ticket_number, provisional_ref from pos_transactions where provisional_ref = 'OFF-…'`                                                                                                                         |

Une vente hors ligne n'est jamais supprimée du poste avant confirmation serveur. Vider les
données du navigateur avec une file non vide fait perdre ces ventes : **interdit**.
