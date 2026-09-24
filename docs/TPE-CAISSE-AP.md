# TPE — protocole Caisse-AP (Concert V3 over IP) tel qu'implémenté

Ce document décrit ce que fait réellement `services/tpe-bridge` (et le codec de `@pos/core`
`caisseAp.ts`, SPEC §7), le paramétrage attendu du terminal, la procédure de recette et les
points restant à confirmer sur le TPE de la boutique.

## 1. Architecture

```
PWA (Chrome kiosque, PC comptoir)            PC comptoir                     LAN boutique
  fetch http://127.0.0.1:8787/payment  ──▶  tpe-bridge (Fastify)  ──TCP 8888──▶  TPE Ingenico/Verifone
  WS  ws://127.0.0.1:8787/events       ◀──  phases connecting/sent/waiting/done
                                            └──────────────TCP 9100──────────▶  Imprimante ESC/POS (+ tiroir)
```

- Le pont écoute **uniquement en local** (`127.0.0.1:8787`) ; la PWA le joint depuis le même PC.
  Chrome exige `Access-Control-Allow-Private-Network: true` sur le preflight CORS pour qu'une
  origine HTTPS appelle `localhost` : le pont l'ajoute.
- Une **connexion TCP par transaction** vers le TPE ; le TPE ferme la connexion après sa réponse.
- Un **seul paiement à la fois** (`409 busy`), les phases sont diffusées sur `WS /events`.
- iPad : Safari refuse le contenu mixte, donc TLS obligatoire. Le pont sert lui-même le HTTPS
  (option `tls`, Fastify `https`), voir §9 ; aucun reverse proxy n'est nécessaire.

## 2. Trame

Concaténation de champs `tag(2 car.) + longueur(3 chiffres, zéro-paddée) + valeur`, ASCII
imprimable uniquement, sans séparateur ni délimiteur de fin. Exemple (débit 25,00 €) :

```
CZ0040300 CJ003012 CA00201 CB0042500 CD0010 CE003978        (espaces ajoutés pour la lecture)
```

Réponse du TPE (acceptée) :

```
CZ0040300 CJ003012 CA00201 CB0042500 CD0010 CE003978 AE00210
```

Le décodeur (`decodeFields`) est tolérant : une trame tronquée en fin de chunk TCP est
signalée `truncated: true` et le pont attend la suite.

## 3. Tags

| Tag  | Sens         | Valeur émise / attendue                                                                         |
| ---- | ------------ | ----------------------------------------------------------------------------------------------- |
| `CZ` | caisse → TPE | Version du protocole : `0300` (configurable `tpe.protocolVersion`)                              |
| `CJ` | caisse → TPE | Identifiant du protocole : `012` (Caisse-AP ; configurable `tpe.protocolId`)                    |
| `CA` | caisse → TPE | Numéro de caisse, 2 chiffres : `01` (`tpe.posNumber`)                                           |
| `CB` | caisse → TPE | Montant en **centimes**, sans padding (`2500` = 25,00 €) — le préfixe de longueur suffit        |
| `CD` | caisse → TPE | Type d'action : `0` débit, `1` crédit (remboursement), `2` annulation (`CAISSE_AP_ACTIONS`)     |
| `CE` | caisse → TPE | Devise ISO 4217 numérique : `978` (EUR)                                                         |
| `AE` | TPE → caisse | Statut : `10` accepté, `01` refusé, `11` demande prise en compte (réponse finale à suivre)      |
| `AF` | TPE → caisse | Motif si `AE=01` : `09` format, `10` sélection, `11` abandon, `12` action inconnue, `13` devise |

Tags optionnels rencontrés selon les versions AP (non émis, ignorés en réception, libellés
« à confirmer » dans `src/caisseap/tags.ts`) : `CC` (mode de saisie), `BF` (mode de règlement),
`AA`, `AB` (n° TPE), `AC` (type de carte), `AI` (n° d'autorisation), `CG`. Le pont renvoie de toute
façon **tous** les champs reçus dans `tpe_raw` : ils sont stockés tels quels dans
`payments.tpe_response` côté caisse.

## 4. Séquence et délais

1. `POST /payment { txn_id, amount_cents, kind }` → phase `connecting` (connexion TCP, délai
   `tpe.connectTimeoutMs`, défaut 5 s ; échec → `status:'error'`, `code` = `ECONNREFUSED` /
   `EHOSTUNREACH` / `ETIMEDOUT`…).
2. Envoi de la trame (`setNoDelay`) → phase `sent`, puis `waiting`.
3. Le TPE affiche le montant, le client insère/présente sa carte et saisit son code.
   Attente maximale `tpe.timeoutMs` (défaut **90 s**) ; le décodage est tenté à chaque chunk.
4. Réponse :
   - `AE=10` → `status:'approved'`, `code:'10'` ;
   - `AE=01` (+ `AF`) → `status:'declined'`, `code` = `AF` (sinon `01`) ;
   - `AE=11` → le pont continue d'attendre la réponse finale (phase `waiting` rediffusée avec
     `detail.ae='11'`) ; sans réponse finale dans le délai → `status:'timeout'`, `code:'11'`,
     `tpe_raw` contient la réponse intermédiaire ;
   - aucun octet dans le délai → `status:'timeout'`, `code:'TIMEOUT'` ;
   - connexion fermée sans `AE` → `status:'error'`, `code:'NO_RESPONSE'` ;
   - `AE` inconnu → `status:'error'`, `code` = valeur `AE`.
5. Phase `done` avec le `result` complet (`tpe_raw`, `request_frame`, `response_frame`,
   `duration_ms`). HTTP **200 même en refus** ; **409** `{ status:'busy' }` si un paiement est en cours.

`POST /payment/cancel { txn_id }` interrompt côté caisse le paiement en cours pour ce `txn_id`
(fermeture de la socket, `/payment` répond `status:'error', code:'CANCELLED'`) ; 409 sinon.
Il n'envoie **pas** de trame d'annulation au TPE : une annulation comptable d'une transaction
acceptée est un nouveau `POST /payment` avec `kind:'credit'` (ou, à confirmer, `CD=2`).

Après un `timeout`, la caisse doit **vérifier sur le TPE** (ticket commerçant) avant de
ré-encaisser : la transaction a pu aboutir côté banque sans que la réponse n'arrive.

## 5. Paramétrage du TPE

À faire par le mainteneur du terminal (ou dans le menu technique) :

1. **Réseau** : Ethernet ou Wi-Fi boutique, **IP fixe** (réservation DHCP sur la box, par ex.
   `192.168.1.50`), même sous-réseau que le PC comptoir.
2. **Activer le protocole caisse** : « Caisse-AP » / « Concert V3 » / « Protocole caisse » en mode
   **IP (TCP/IP)**, TPE **serveur** (il écoute), **port 8888**, sans TLS.
3. **Numéro de caisse** : `01` (doit correspondre à `tpe.posNumber`).
4. Devise EUR (`978`), version protocole `0300` si le menu le demande, identifiant `012`.
5. Désactiver tout « mode autonome » qui ignorerait les demandes caisse ; laisser le TPE sur son
   écran d'accueil.
6. Noter dans `bridge.config.json` : `tpe.host`, `tpe.port` (8888), `tpe.posNumber`.

Ingenico (Telium/Tetra) : menu `F` → `Paramétrage` → `Caisse` → `Protocole : Caisse-AP`, `Support : IP`,
`Port : 8888`. Verifone : `Réglages` → `Caisse` → `Concert V3 / IP`. Les intitulés exacts varient
selon le modèle et la version du logiciel monétique : à confirmer avec le mainteneur.

## 6. Procédure de test à 1 €

1. `curl http://127.0.0.1:8787/health` → `tpe.reachable: true` (sinon : IP, port, câble, VLAN).
2. Démarrer le pont avec `LOG_LEVEL=debug` (les trames sont journalisées).
3. Débit de 1 € :
   ```bash
   curl -X POST http://127.0.0.1:8787/payment -H 'Content-Type: application/json' \
     -H 'X-Bridge-Token: <token>' -d '{"txn_id":"test-1eur","amount_cents":100,"kind":"debit"}'
   ```
   Le TPE doit afficher `1,00 EUR` ; présenter une carte de test / une vraie carte.
   Attendu : `{"status":"approved","code":"10","tpe_raw":{...,"AE":"10"},...}`.
4. Vérifier `request_frame` = `CZ0040300CJ003012CA00201CB003100CD0010CE003978` et noter la
   `response_frame` complète (liste des tags renvoyés par **ce** TPE) dans ce document.
5. Refus : relancer et **annuler sur le TPE** (touche rouge) → attendu `status:'declined'`,
   `AF=11`. Noter les codes réellement renvoyés.
6. Timeout : relancer sans toucher au TPE, attendre 90 s → `status:'timeout'` ; vérifier que le
   TPE revient à l'accueil et qu'aucune transaction n'a été enregistrée.
7. Remboursement de 1 € : `"kind":"credit"` → le TPE doit proposer un crédit (`CD=1`).
8. Reporter les résultats (tags, codes, durées) dans le §8 ci-dessous et, si besoin, ajuster
   `CAISSE_AP_ACTIONS` / `CAISSE_AP_AF_CODES` dans `@pos/core` (sans toucher au reste).

Le tout peut être répété sans TPE avec `tpe.simulate: true` (simulateur intégré) ou
`pnpm dev:tpe-sim` (TCP 8888) : montants magiques `…01` refus, `…02` silence, `…03` `AE=11` puis
`AE=10`, tout le reste accepté.

## 7. Limites connues

- **Un paiement à la fois** et une seule caisse (`CA=01`).
- Pas de TLS entre le pont et le TPE (protocole en clair sur le LAN boutique, comme prévu par
  Caisse-AP) ; le LAN doit rester privé. Le TLS du §9 ne concerne que PWA ↔ pont.
- Le pont ne conserve **aucun état** : en cas de redémarrage pendant un paiement, la réponse est
  perdue (la caisse traite alors comme un `timeout` : vérification manuelle sur le TPE).
- `/payment/cancel` n'interrompt pas la saisie côté TPE, il libère seulement la caisse.
- Pas de gestion des tickets client/commerçant renvoyés par le TPE (certaines versions AP
  peuvent transmettre un ticket à imprimer par la caisse) : ignoré pour l'instant.
- Le simulateur ne reproduit pas les délais de saisie réels ni les tags optionnels.

## 8. Points à confirmer sur le TPE réel

| Point                                                                             | Statut      |
| --------------------------------------------------------------------------------- | ----------- |
| Valeurs `CD` : `0` débit / `1` crédit / `2` annulation (`CAISSE_AP_ACTIONS`)      | à confirmer |
| Valeurs et libellés `AF` au-delà de `09`–`13`                                     | à confirmer |
| Tags optionnels renvoyés (`CC`, `BF`, `AA`, `AB`, `AC`, `AI`, `CG`…) et leur sens | à confirmer |
| `CB` sans padding accepté (sinon padder à 8/12 chiffres)                          | à confirmer |
| Envoi d'un `AE=11` intermédiaire par le TPE (ou réponse finale directe)           | à confirmer |
| Le TPE ferme-t-il la connexion après la réponse (sinon `settleMs` suffit)         | à confirmer |
| Délai maximal réel de saisie (adapter `tpe.timeoutMs`)                            | à confirmer |
| Port 8888 et mode serveur par défaut sur le modèle installé                       | à confirmer |
| Version protocole `0300` / identifiant `012` attendus par le firmware             | à confirmer |

Résultats de la recette (à compléter) :

```
Date :            Modèle TPE :             Version logiciel :
response_frame 1 € accepté :
response_frame refus :
Durée moyenne :
```

## 9. HTTPS natif du pont (iPad)

Safari (iPad) n'autorise une page `https://pos.ma-papeterie.fr` à appeler le pont que si celui-ci
est lui aussi en HTTPS avec un certificat de confiance. Le pont termine TLS lui-même (Fastify
`https: { cert, key }`) : **Caddy ou tout autre reverse proxy n'est plus nécessaire**.

Configuration (`bridge.config.json`) :

```json
{
  "http": { "host": "0.0.0.0", "port": 8787 },
  "allowedOrigins": ["https://pos.ma-papeterie.fr"],
  "tls": { "certPath": "tls/fullchain.pem", "keyPath": "tls/privkey.pem" }
}
```

- `tls` absent : HTTP simple (PC comptoir, `127.0.0.1`) — comportement inchangé.
- Chemins relatifs résolus depuis le dossier de `bridge.config.json`. Fichier illisible → le pont
  refuse de démarrer (code 2) avec `tls.certPath illisible : …`.
- Au démarrage, le journal indique le schéma : `pont TPE prêt (HTTPS)` et
  `url: https://0.0.0.0:8787`. Le WebSocket devient `wss://…/events`.
- Dans l'exemple fourni, la clé est présente sous le nom `"//tls"` (les clés commençant par `//`
  sont ignorées) : la renommer en `"tls"` pour l'activer.

Certificat : nom `bridge.ma-papeterie.fr`, enregistrement DNS public `A` vers l'**IP privée** du PC
comptoir, certificat Let's Encrypt obtenu par challenge **DNS-01** (aucun port exposé sur
Internet). Le certificat est lu au démarrage : après chaque renouvellement (≤ 90 jours),
**redémarrer le service** du pont. Côté PWA de l'iPad : `VITE_BRIDGE_URL=https://bridge.ma-papeterie.fr:8787`.
Procédure complète : `docs/BASCULE.md` (J-4). Test automatisé : `services/tpe-bridge/test/tls.test.ts`
(certificat auto-signé de test dans `test/fixtures/tls/`, jamais utilisé en production).
