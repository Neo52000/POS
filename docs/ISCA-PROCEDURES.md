# Procédures ISCA — Inaltérabilité, Sécurisation, Conservation, Archivage

Pour chaque condition de l'article 286-I-3° bis du CGI : mécanisme mis en œuvre, preuve
vérifiable, procédure de l'exploitant et fréquence. Périmètre et versions :
`docs/PERIMETRE-NF525.md`. Toutes les requêtes SQL s'exécutent dans le SQL Editor du projet
Supabase **Pos** (rôle `postgres`) ; la caisse de production est `CHAUMONT-01`.

```sql
-- Identifiant de la caisse, utilisé ci-dessous
select id, code, label, fiskaly_env, is_active from pos_registers;
```

## 1. Inaltérabilité

**Mécanisme**

- Écritures uniquement par RPC `SECURITY DEFINER` (`pos_finalize_sale`, `pos_open_session`,
  `pos_close_session`, `pos_compute_closing`, `pos_log_event`, `pos_register_archive`) ;
  `INSERT/UPDATE/DELETE` révoqués sur les tables pour `anon` et `authenticated`.
- Triggers : `UPDATE`/`DELETE` interdits sur tickets, lignes, paiements, clôtures, JET, archives
  (seules les colonnes de signature Fiskaly d'un ticket peuvent être complétées une fois).
- Numérotation continue par caisse (`pos_counters`, verrou de ligne, pas de `SEQUENCE`) : tickets,
  sessions, clôtures, événements.
- Chaînage SHA-256 : chaque ticket contient le hash du précédent (SPEC §3) ; idem pour le JET, les
  clôtures et les archives. Toute correction se fait par **remboursement** (nouveau ticket
  négatif lié à l'original), jamais par modification.
- Horodatage contrôlé par le serveur (`clock_tolerance`) : pas d'antidatage au-delà de 10 min en
  ligne, 72 h hors ligne (`docs/HORS-LIGNE.md`).

**Preuve**

```sql
select * from pos_verify_chain('<register_id>');           -- tickets : ok, checked, first_break_ticket, reason
select * from pos_verify_events_chain('<register_id>');    -- JET
select * from pos_verify_closings_chain('<register_id>');  -- clôtures
select * from pos_verify_archives_chain('<register_id>');  -- archives
```

Recalcul indépendant, hors base (implémentation TypeScript distincte du SQL, mêmes vecteurs de
test `packages/core/src/__fixtures__/hash-vectors.json`) :

```bash
SUPABASE_URL=https://jntngwbdsaexustzmaii.supabase.co SUPABASE_SERVICE_ROLE_KEY=… pnpm verify-chain [CHAUMONT-01]
```

Sortie : un tableau (tickets @pos/core, tickets SQL, JET, clôtures, archives) ; code de sortie
`0` si tout est intègre, `1` à la première rupture (numéro et raison affichés).

**Procédure exploitant** : une fois par semaine, le responsable lance `pnpm verify-chain` (ou
les quatre requêtes ci-dessus). Une rupture n'est **jamais** corrigée en base :
consigner la date, le résultat, prévenir l'éditeur, conserver l'état (pas de restauration sans
analyse).

**Fréquence** : à chaque vente (chaînage) ; contrôle hebdomadaire ; contrôle mensuel avant
archivage (automatique, voir §4).

## 2. Sécurisation

**Mécanisme**

- Signature électronique Fiskaly SIGN FR de chaque ticket et de chaque clôture
  (`pos_transactions.fiskaly_signature`, `pos_closings.fiskaly_closing_id`). Un échec de signature
  n'empêche pas la vente : statut `pending_signature`, rejoué toutes les 2 min (`pos-sign-pending`).
- Clôtures : Z à chaque fermeture de session (`daily`), mensuelle le 1er à 03:10 UTC, annuelle le
  1er janvier à 03:20 UTC, bornes en heure de Paris (`pos_period_bounds`) ; grand total perpétuel
  cumulé depuis l'origine.
- JET (`pos_events`) : connexions, ouvertures/fermetures, abandons, suppressions de ligne,
  modifications de prix, ouvertures de tiroir, réimpressions, passages hors ligne
  (`offline_enter`/`offline_exit`/`offline_reattached`/`offline_replay_failed`), abandons tracés
  d'une vente hors ligne en échec (`offline_sale_abandoned`, contenu complet + motif, admin,
  enregistré avant tout effet local), ajustements de
  stock (`stock_adjustment`), archives (`archive`).
- Accès : authentification Supabase, rôles `pos` / `admin` (`pos_user_roles`), RLS `is_pos()` ;
  clés de service et secrets Fiskaly uniquement dans les secrets des Edge Functions et Vault.
- Le pont TPE local exige un jeton (`X-Bridge-Token`), écoute en local ou en HTTPS (iPad).

**Preuve**

```sql
-- Tickets non signés (doit être vide ou très récent)
select ticket_number, business_at, signature_status, signature_attempts, last_signature_error
from pos_transactions where signature_status <> 'signed' order by ticket_number;
-- Clôtures et grand total perpétuel
select closing_number, period_type, period_start, period_end, txn_count, total_ttc_cents,
       grand_total_perpetual_cents, fiskaly_closing_id is not null as fiskaly
from pos_closings where register_id = '<register_id>' order by closing_number;
-- JET d'une journée
select event_number, event_type, created_at, client_at, payload
from pos_events where register_id = '<register_id>'
  and created_at >= '2026-10-01' and created_at < '2026-10-02' order by id;
```

**Procédure exploitant** : Z obligatoire chaque soir (fermeture de session) ; vérifier chaque
matin l'absence de ticket `pending_signature` de plus de 24 h (sinon : état Fiskaly, secrets,
journal de `pos-sign-pending`). Les comptes vendeurs sont nominatifs ; un départ = suppression du
rôle dans `pos_user_roles`.

**Fréquence** : quotidienne (Z, signatures), mensuelle et annuelle (clôtures automatiques).

## 3. Conservation

**Mécanisme**

- Données conservées dans la base Pos sans limite de durée (aucune purge ; suppression impossible
  par trigger) ; sauvegardes automatiques Supabase du projet.
- Copie indépendante chez Fiskaly (archive SAFE des signatures et clôtures).
- Archives mensuelles (§4) dans le bucket privé `pos-archives`, et copie hors ligne chez l'exploitant.
- Durée légale : 6 ans à compter de la dernière opération (LPF art. L102 B) ; l'exploitant conserve
  **au moins 6 ans** les ZIP et l'accès à la base.

**Preuve**

```sql
select count(*), min(business_at), max(business_at) from pos_transactions where register_id = '<register_id>';
select period_start, period_end, storage_path, manifest_sha256, created_at
from pos_archives where register_id = '<register_id>' order by period_start;
```

**Procédure exploitant** : le 2 de chaque mois, télécharger le ZIP du mois précédent (§4) et le
copier sur deux supports distincts (disque externe au bureau + stockage cloud personnel), sans le
renommer ni le décompresser sur place. Tenir un registre simple (mois, date de copie, empreinte
`manifest_sha256`). Ne jamais supprimer le projet Supabase ni résilier Fiskaly sans avoir exporté
et vérifié toutes les archives.

**Fréquence** : mensuelle (copie) ; annuelle (contrôle de lecture d'un ZIP ancien avec
`pnpm verify-archive`).

## 4. Archivage

**Mécanisme** — Edge Function `pos-export-archive`, cron le 1er du mois à 04:00 UTC :

1. bornes du mois précédent en heure de Paris (`pos_period_bounds`) ;
2. `pos_archive_data` : **partition contiguë** de la caisse depuis l'archive précédente (tickets
   de numéro supérieur au dernier archivé et reçus avant la fin de période, lignes et paiements
   inclus ; JET ; clôtures) ;
3. ZIP `pos-archive/v1` : `transactions.jsonl`, `events.jsonl`, `closings.jsonl` (JSON canonique,
   une ligne par enregistrement) et `manifest.json` (période, logiciel et version, SHA-256 /
   taille / nombre d'enregistrements de chaque fichier, têtes de chaîne, ancre = dernier ticket
   de l'archive précédente, référence de l'archive précédente) ;
4. dépôt dans `pos-archives/<CAISSE>/<AAAA-MM>.zip` (jamais écrasé) ;
5. `pos_register_archive` : ligne immuable dans `pos_archives`, `hash = SHA-256(v1|archive|caisse|début|fin|manifest_sha256|prev_hash)`,
   événement JET `archive`.

Relance manuelle (admin) si le cron a échoué, idempotente :

```bash
curl -X POST https://jntngwbdsaexustzmaii.supabase.co/functions/v1/pos-export-archive \
  -H "Authorization: Bearer <JWT admin ou service role>" -H 'Content-Type: application/json' \
  -d '{"period_start":"2026-10-01T00:00:00+02:00"}'
```

**Preuve — ce que fait un auditeur**

1. Télécharger le ZIP : dashboard Supabase → Storage → `pos-archives`, ou lien signé créé par
   un admin (`createSignedUrl`).
2. Vérifier l'archive seule (fichiers, comptes, manifeste, chaîne des tickets recalculée) :
   ```bash
   pnpm verify-archive CHAUMONT-01-2026-10.zip --manifest-sha256 <pos_archives.manifest_sha256>
   # ou, avec SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY : empreinte lue dans pos_archives
   ```
   Code de sortie `0` = intègre. Toute modification d'un octet d'un fichier, du manifeste, ou
   d'un ticket (même avec manifeste recalculé) est détectée.
3. Vérifier la chaîne des archives : `select * from pos_verify_archives_chain('<register_id>');`
   et que le `prev_hash` du premier ticket d'une archive (`chain_heads.anchor_ticket_hash`) est le
   hash du dernier ticket de l'archive précédente (contrôlé par `pnpm verify-archive`).
4. Rapprocher : `first_ticket_number` / `last_ticket_number` du manifeste avec
   `pos_archives.last_ticket_number` du mois précédent (+1) et du mois courant.

**Procédure exploitant** : le 2 du mois, vérifier dans `pos_archives` la présence de l'archive du
mois précédent, la télécharger, lancer `pnpm verify-archive`, puis la copier (§3).

**Fréquence** : mensuelle (automatique + contrôle), annuelle (revue de la chaîne complète).

## 5. Récapitulatif pour un contrôle

| Question de l'auditeur                          | Réponse / commande                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| Les tickets ont-ils été modifiés ou supprimés ? | `pos_verify_chain` + `pnpm verify-chain` (recalcul indépendant)              |
| Le JET est-il complet et intact ?               | `pos_verify_events_chain`, numéros `event_number` continus                   |
| Les clôtures sont-elles intactes ?              | `pos_verify_closings_chain`, grand total perpétuel croissant et cohérent     |
| Les archives sont-elles intègres et chaînées ?  | `pnpm verify-archive <zip>` + `pos_verify_archives_chain`                    |
| Quelle version du logiciel ?                    | `select value from pos_settings where key = 'software'` ; ticket ; manifeste |
| Signatures                                      | `pos_transactions.fiskaly_signature`, tableau de bord Fiskaly                |
| Attestation                                     | `docs/ATTESTATION-EDITEUR.md` signée (version majeure en cours)              |
