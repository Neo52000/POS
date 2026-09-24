# Déploiement du pont TPE (`@pos/tpe-bridge`)

Le pont tourne **sur le PC comptoir**, écoute en `http://127.0.0.1:8787` et parle au TPE
(TCP 8888, Caisse-AP) et à l'imprimante (TCP 9100, ESC/POS) sur le LAN de la boutique.
Il n'est jamais exposé sur Internet.

## 1. Produire un dossier autonome

Sur un poste de développement (Node ≥ 20, pnpm 10) :

```bash
pnpm install
pnpm --filter @pos/core build
pnpm --filter @pos/tpe-bridge build          # dist/index.js (+ @pos/core inclus), dist/tpe-sim.js
pnpm --filter @pos/tpe-bridge deploy --prod --legacy /tmp/tpe-bridge-deploy
```

`pnpm deploy` copie `dist/`, `package.json`, `bridge.config.example.json`, `deploy/` et un
`node_modules/` de production (fastify, pino…). `@pos/core` est déjà bundlé dans `dist/index.js`.
Le dossier obtenu se lance avec `node dist/index.js` sans pnpm.

> Sans `pnpm deploy` : copiez `services/tpe-bridge` après `pnpm install` et `pnpm build`
> (les liens symboliques de pnpm restent valides sur la même machine uniquement).

## 2. Configuration

Copiez `bridge.config.example.json` vers `bridge.config.json` à côté de `dist/` (ou pointez
`BRIDGE_CONFIG=<chemin>`), puis renseignez :

| Clé              | Valeur                                                                      |
| ---------------- | --------------------------------------------------------------------------- |
| `token`          | Jeton aléatoire ≥ 16 caractères, identique dans la PWA (`X-Bridge-Token`)   |
| `allowedOrigins` | Origines de la PWA (`https://pos.ma-papeterie.fr`, `http://localhost:5173`) |
| `tpe.host`       | IP fixe du TPE (réservation DHCP sur la box) — `simulate: true` pour tester |
| `printer.host`   | IP fixe de l'imprimante ; `type: "none"` pour tester sans imprimante        |
| `drawer.pin`     | `0` (connecteur RJ11 standard) ou `1`                                       |
| `tls`            | iPad uniquement : `{ certPath, keyPath }` (PEM) → HTTPS natif, voir TPE §9  |

`BRIDGE_TOKEN` (variable d'environnement) remplace `token` si défini. Le fichier contient le
jeton : restreignez-en la lecture (`chmod 600` / ACL Windows).

## 3. Windows (PC comptoir, Chrome kiosque)

```powershell
# Console PowerShell administrateur
winget install NSSM.NSSM        # recommandé (service natif, journal, redémarrage auto)
powershell -ExecutionPolicy Bypass -File .\deploy\windows-install.ps1 -Source C:\tmp\tpe-bridge-deploy
```

Le script :

1. installe Node.js LTS via `winget` s'il manque ;
2. copie le dossier vers `C:\ProgramData\MaPapeterie\tpe-bridge` (config existante conservée) ;
3. crée `bridge.config.json` avec un jeton aléatoire si absent (à compléter) ;
4. crée le service `MaPapeterieTpeBridge` via **NSSM** (démarrage automatique, journal
   `logs\bridge.log` avec rotation, arrêt propre par Ctrl+C) ; sans NSSM, repli sur une
   **Tâche planifiée** au démarrage (`-UseTask`) ; `-UseSc` n'est utilisable qu'avec un wrapper
   de service (WinSW), `sc.exe` ne sachant pas lancer `node.exe` directement.

Commandes utiles : `nssm restart MaPapeterieTpeBridge`, `nssm edit MaPapeterieTpeBridge`,
`Get-Content C:\ProgramData\MaPapeterie\tpe-bridge\logs\bridge.log -Wait`.

Pare-feu : rien à ouvrir en entrée (écoute 127.0.0.1). Avec `tls` (iPad, `http.host` =
`0.0.0.0` ou IP LAN) : autoriser en entrée TCP 8787 depuis le LAN uniquement (profil privé) ;
après renouvellement du certificat, `nssm restart MaPapeterieTpeBridge`. En sortie, autoriser `node.exe` vers
le LAN (TCP 8888 et 9100) si le pare-feu bloque les connexions sortantes.

## 4. Linux (systemd)

Voir l'en-tête de `deploy/tpe-bridge.service` : utilisateur dédié `tpebridge`, dossier
`/opt/tpe-bridge`, `systemctl enable --now tpe-bridge`, journal via `journalctl -u tpe-bridge -f`.

## 5. Vérifications

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"version":"0.1.0","tpe":{"host":"192.168.1.50","port":8888,"reachable":true},
#  "printer":{"type":"network","reachable":true},"simulate":false,"busy":false}

curl -X POST http://127.0.0.1:8787/payment -H 'Content-Type: application/json' \
  -H 'X-Bridge-Token: <token>' -d '{"txn_id":"test-1","amount_cents":100,"kind":"debit"}'
```

Procédure de test TPE réel (1 €) et paramétrage du terminal : `docs/TPE-CAISSE-AP.md`.

## 6. Mise à jour

Reproduire l'étape 1, relancer le script Windows (ou recopier `dist/` + `node_modules/` sous
Linux) puis redémarrer le service. `bridge.config.json` n'est jamais écrasé.

## 7. iPad (plus tard)

Safari refuse `http://<ip-du-pc>:8787` depuis une PWA HTTPS (contenu mixte). Prévu : écouter
sur l'IP LAN (`http.host`), certificat Let's Encrypt via DNS-01 pour un nom du type
`bridge.ma-papeterie.fr` résolu vers l'IP privée, et terminaison TLS devant le pont (Caddy).
