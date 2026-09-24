# Bascule Shopify POS → Ma Papeterie POS (J-7 → J+7)

Check-list de mise en service de la caisse NF525 à la boutique de Chaumont. Cocher chaque ligne ;
noter date, auteur et résultat. **(P)** = action du propriétaire (accès aux comptes Supabase
ma-papeterie, Netlify, Fiskaly, box Internet). Commandes : `docs/ENGINEERING.md` ; contrôles :
`docs/ISCA-PROCEDURES.md`.

Principe : jusqu'à J0, **Shopify POS reste la caisse fiscale**. Tous les essais se font sur la
caisse `TEST-01` (jamais sur `CHAUMONT-01`, dont les tables sont immuables : un ticket d'essai y
resterait définitivement).

## J-7 — Plateforme

- [ ] Migrations du projet **Pos** appliquées (fusion dans `main`) :
      `select version, name from supabase_migrations.schema_migrations order by version;`
      (lots 1 à 6, dont `…_pos_offline`, `…_pos_closings_tz`, `…_pos_archives`).
- [ ] Migrations **ma-papeterie** appliquées (dont `pos_set_stock_boutique`) **(P)**.
- [ ] Edge Functions déployées (`supabase functions deploy`) : `pos-checkout`, `pos-sign-pending`,
      `pos-stock-sync`, `pos-closing`, `pos-closings-sync`, `pos-customer-search`,
      `pos-customer-quotes`, `pos-resolve-prices`, `pos-export-archive`, `pos-stock-adjust`
      (`verify_jwt = false` pour toutes, `supabase/config.toml`).
- [ ] Secrets Edge du projet Pos **(P)** : `FISKALY_MODE=mock` (pour l'instant), `MAPAP_SUPABASE_URL`,
      `MAPAP_SERVICE_ROLE_KEY`. Vérifier `SUPABASE_SERVICE_ROLE_KEY` (fourni par la plateforme).
- [ ] Vault **(P)**, SQL Editor Pos, une seule fois — même valeur que `SUPABASE_SERVICE_ROLE_KEY`
      des Edge Functions (sinon les crons reçoivent 401) :
      `select vault.create_secret('<service_role_key Pos>', 'pos_service_role_key');`
- [ ] Crons actifs : `select jobname, schedule, active from cron.job order by jobname;` →
      `pos-sign-pending`, `pos-stock-sync`, `pos-closings-sync`, `pos-closing-monthly`,
      `pos-closing-annual`, `pos-export-archive`. Journal : `select * from cron.job_run_details order by start_time desc limit 20;`
- [ ] Bucket Storage privé `pos-archives` présent.
- [ ] Comptes utilisateurs (Auth du projet Pos) **(P)** : un compte **admin** (propriétaire) et un
      compte **vendeur** nominatif par personne :
      `insert into pos_user_roles (user_id, role) values ('<uuid>', 'admin'), ('<uuid>', 'pos');`
- [ ] Caisse d'essai : `insert into pos_registers (code, label) values ('TEST-01', 'Caisse d''essai');`
- [ ] Netlify **(P)** : site `pos.ma-papeterie.fr`, variables `VITE_SUPABASE_URL`,
      `VITE_SUPABASE_ANON_KEY`, `VITE_CATALOG_SUPABASE_URL`, `VITE_CATALOG_SUPABASE_ANON_KEY`,
      `VITE_BRIDGE_URL`, `VITE_APP_VERSION` ; déploiement vert ; PWA installée sur le PC et l'iPad.
- [ ] Pont TPE installé sur le PC comptoir (`services/tpe-bridge/deploy/README.md`), démarrage
      automatique, `curl http://127.0.0.1:8787/health` OK.

## J-5 — Fiskaly TEST

- [ ] **(P)** Clés **TEST** Fiskaly SIGN FR : `FISKALY_MODE=live`, `FISKALY_BASE_URL` (TEST),
      `FISKALY_API_KEY`, `FISKALY_API_SECRET` ; `pos_registers.fiskaly_env = 'test'` pour `TEST-01`.
- [ ] Mise en service du système : première vente sur `TEST-01` → `fiskaly_system_id` renseigné.
- [ ] `pnpm smoke:fiskaly 5 TEST-01` : ventes + remboursement signés, chaîne OK, clôture de session.
- [ ] `pnpm verify-chain TEST-01` : tableau entièrement `OK`.
- [ ] Clôture forcée : `pos-closing` `{"register_id":"<TEST-01>","period_type":"daily","period_start":"<ISO du jour>"}`,
      rapprochement le lendemain par `pos-closings-sync`.

## J-4 — iPad : TLS du pont

- [ ] **(P)** DNS : enregistrement `A bridge.ma-papeterie.fr → <IP LAN fixe du PC comptoir>` (ex. `192.168.1.20`).
      Si la box bloque les réponses DNS pointant vers une IP privée (protection « DNS rebinding »),
      ajouter une exception pour ce nom.
- [ ] Certificat Let's Encrypt par challenge **DNS-01** (aucun port ouvert sur Internet), ex. :
      `certbot certonly --manual --preferred-challenges dns -d bridge.ma-papeterie.fr`
      (ou `acme.sh` avec l'API du registrar pour le renouvellement automatique).
- [ ] Copier `fullchain.pem` et `privkey.pem` dans le dossier du pont (`tls/`), droits restreints
      au compte du service.
- [ ] `bridge.config.json` : renommer `"//tls"` en `"tls"`, `http.host: "0.0.0.0"` (ou l'IP LAN),
      `allowedOrigins` contient `https://pos.ma-papeterie.fr` ; redémarrer le service.
      Le journal affiche `pont TPE prêt (HTTPS)` et `url: https://…`.
- [ ] Pare-feu Windows : autoriser **en entrée** TCP 8787 depuis le LAN uniquement (profil privé).
- [ ] Depuis l'iPad (Safari) : `https://bridge.ma-papeterie.fr:8787/health` → JSON sans alerte de
      certificat ; `VITE_BRIDGE_URL=https://bridge.ma-papeterie.fr:8787` côté iPad.
- [ ] Planifier le renouvellement (certificat valable 90 jours) : renouveler puis **redémarrer le
      pont** (le certificat est lu au démarrage). Rappel à J+60.

## J-3 — Périphériques et CB à 1 €

- [ ] Paramétrage TPE (Caisse-AP IP, port 8888, caisse `01`) : `docs/TPE-CAISSE-AP.md` §5.
- [ ] Test à 1 € : débit, refus (annulation sur le TPE), timeout, crédit — `docs/TPE-CAISSE-AP.md` §6 ;
      reporter les trames au §8.
- [ ] Impression d'un ticket de `TEST-01`, ouverture du tiroir, réimpression (JET `reprint`).

## J-3 → J-1 — Marche en parallèle

- [ ] Shopify POS reste la caisse officielle. Sur un échantillon de ventes réelles, ressaisir la
      vente dans la nouvelle caisse sur `TEST-01` (paiement « espèces » fictif, pas de CB réelle).
- [ ] Chaque soir : Z de `TEST-01`, comparer les totaux par taux de TVA avec Shopify POS ;
      noter tout écart (arrondis, remises, éco-participation).
- [ ] Tester le hors ligne (Wi-Fi coupé) : 2 ventes, retour réseau, rejeu, Z (`docs/HORS-LIGNE.md`).
- [ ] Tester l'inventaire sur 2 articles (`/inventory`), vérifier `stock_boutique` et le JET
      `stock_adjustment`.

## J-1 (soir, après la dernière vente Shopify POS)

- [ ] **(P)** Clés Fiskaly **LIVE** dans les secrets Edge (`FISKALY_BASE_URL`, `FISKALY_API_KEY`,
      `FISKALY_API_SECRET`).
- [ ] Caisse de production vierge : `select count(*) from pos_transactions t join pos_registers r on r.id = t.register_id where r.code = 'CHAUMONT-01';` → **0**.
      Sinon, ne rien supprimer : créer une nouvelle caisse (`CHAUMONT-02`) et l'utiliser.
- [ ] `update pos_registers set fiskaly_env = 'live', fiskaly_system_id = null where code = 'CHAUMONT-01';`
      (mise en service du système LIVE à la première vente) ; désactiver `TEST-01` :
      `update pos_registers set is_active = false where code = 'TEST-01';`
- [ ] Version : `update pos_settings set value = '{"name":"Ma Papeterie POS","version":"1.0.0"}' where key = 'software';`
      et `VITE_APP_VERSION=1.0.0` (redéployer Netlify). Mentions légales (`legal` : SIRET, TVA,
      téléphone) complétées dans `pos_settings`.
- [ ] **Inventaire initial** via `/inventory` (compte admin) : compter le stock boutique, envoyer
      par lots ; toutes les lignes confirmées, aucune erreur. Le stock ma-papeterie devient la
      référence de départ.
- [ ] Attestation / certification : `docs/ATTESTATION-EDITEUR.md` (lire l'avertissement).

## J0 — Mise en service

- [ ] Ouverture de session sur `CHAUMONT-01` (fond de caisse compté).
- [ ] Première vente réelle de faible montant en CB : ticket `T-AAAA-000001`, `signature_status = 'signed'`,
      stock décrémenté (`pos_stock_sync` `done`).
- [ ] `pnpm verify-chain CHAUMONT-01` : tout `OK`.
- [ ] **(P)** ma-papeterie — arrêt de Shopify POS :
  - [ ] `update shopify_config set pos_active = false;` (vérifier d'abord la structure et noter la
        valeur précédente : `select * from shopify_config;`) ;
  - [ ] désactiver `caisse-cash-tracking`, `cleanup-pos-inventory`, `test-pos-push` : pour un job
        planifié, `select cron.alter_job(jobid, active := false) from cron.job where jobname in ('caisse-cash-tracking','cleanup-pos-inventory','test-pos-push');`
        (adapter aux noms réels : `select jobid, jobname, schedule, active from cron.job;`) ; pour
        une Edge Function déclenchée autrement (webhook), retirer le déclencheur. **Ne pas
        supprimer le code** (retour arrière) ;
  - [ ] déconnecter l'application Shopify POS du matériel de la boutique.
- [ ] Z du soir, comparaison du fond de caisse, contrôle des signatures.

## J+1 → J+7 — Stabilisation

- [ ] Chaque matin : aucun ticket `pending_signature` de plus de 24 h ; file `pos_stock_sync`
      sans `failed` ; JET sans `offline_replay_failed` non traité.
- [ ] J+1 : `pos-closings-sync` a rapproché le Z de J0 (`fiskaly_closing_id` renseigné).
- [ ] J+2 : rapprochement stock ma-papeterie / rayon sur 10 références.
- [ ] J+7 : `pnpm verify-chain` complet ; revue du JET (`drawer_opened`, `price_override`,
      `line_deleted`) avec le propriétaire.
- [ ] Premier du mois suivant : archive `pos-archives/CHAUMONT-01/<AAAA-MM>.zip` présente,
      `pnpm verify-archive` OK, copie hors ligne (`docs/ISCA-PROCEDURES.md` §3-4).

## Retour arrière

| Moment               | Procédure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Avant J0             | Rien à défaire côté fiscal (seule `TEST-01` a servi) ; Shopify POS continue.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Après J0             | 1. Clôturer la session en cours (Z) sur la nouvelle caisse — ne rien supprimer, les données restent conservées et archivées. 2. **(P)** `update shopify_config set pos_active = true;` 3. **(P)** Réactiver les jobs : `select cron.alter_job(jobid, active := true) from cron.job where jobname in (…);` 4. Reconnecter Shopify POS. 5. Inventaire de contrôle : le stock a été décrémenté par la nouvelle caisse. 6. Noter la date de retour arrière dans le registre (utile en cas de contrôle). |
| Pont TPE / iPad seul | Revenir au PC comptoir en HTTP local (`tls` renommé `//tls`, `http.host: 127.0.0.1`) ; la caisse fonctionne sans l'iPad.                                                                                                                                                                                                                                                                                                                                                                            |
| Fiskaly indisponible | Aucune action : les ventes restent valides (`pending_signature`) et sont signées au rétablissement.                                                                                                                                                                                                                                                                                                                                                                                                 |
