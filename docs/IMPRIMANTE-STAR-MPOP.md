# Imprimante Star mPOP — mise en service

Star mPOP (gamme POP10) : imprimante thermique **58 mm** et tiroir-caisse **intégré**, reliée au
PC comptoir en **USB** (ou en Bluetooth). Elle ne comprend pas l'ESC/POS Epson : le pont (≥ 0.2.0)
lui parle en **StarPRNT / Star Line Mode** (SPEC §13.6).

| Caractéristique  | Valeur utilisée par le pont                                     |
| ---------------- | --------------------------------------------------------------- |
| Largeur papier   | 58 mm → **32 colonnes** (police A)                              |
| Jeu de commandes | Star (`commandSet: "star"`), page de codes CP858 (`€`, accents) |
| Coupe            | **aucune** (barre de découpe manuelle) : 5 lignes d'avance      |
| Tiroir           | intégré, périphérique 1 → commande `BEL` (`drawer.pin: 0`)      |
| Liaison          | USB (recommandé), Bluetooth (port série)                        |

Tout est porté par le profil `"profile": "star-mpop"` ; une clé explicite (ex. `width`) l'emporte.
Exemple complet : `services/tpe-bridge/bridge.config.mpop.example.json`.

## 1. Windows (PC comptoir) — USB

1. Brancher l'mPOP en USB, l'allumer, installer le pilote Star (« Star Windows Software »,
   pilote mPOP). L'imprimante apparaît dans _Paramètres › Imprimantes_.
2. _Propriétés de l'imprimante › Partage_ : cocher **Partager cette imprimante**, nom de partage
   **`mPOP`**.
3. Contrôle (invite de commandes) : `echo TEST > t.txt` puis `copy /b t.txt \\localhost\mPOP` →
   « TEST » s'imprime. Sinon, le partage ou le pilote est en cause, pas le pont.
4. `bridge.config.json` :

   ```json
   "printer": { "profile": "star-mpop", "type": "device", "path": "\\\\localhost\\mPOP", "timeoutMs": 8000 },
   "drawer": { "pin": 0 }
   ```

5. `nssm restart MaPapeterieTpeBridge`. Si le service (compte `LocalSystem`) n'obtient pas l'accès
   au partage (erreur `EACCES`/`EPERM` dans `logs\bridge.log`), le faire tourner sous le compte
   Windows de la boutique : `nssm set MaPapeterieTpeBridge ObjectName .\<compte> <mot de passe>`,
   puis redémarrer.

Un chemin UNC ne se sonde pas sans imprimer : `/health` le déclare joignable ; un échec réel
remonte à l'impression (`503 PRINTER_UNREACHABLE`, ticket affiché à l'écran par la PWA).

## 2. Linux (PC comptoir) — USB

1. Brancher l'mPOP : le noyau crée `/dev/usb/lp0` (pilote `usblp`). S'il n'apparaît pas, passer
   l'interface USB de l'mPOP en classe **Imprimante (Printer Class)** avec l'utilitaire Star, puis
   rebrancher.
2. Droits du compte du service : `sudo usermod -aG lp <compte>` (ou règle udev
   `SUBSYSTEM=="usbmisc", ATTRS{idVendor}=="0519", MODE="0660", GROUP="lp"` ; `0519` = Star
   Micronics).
3. `bridge.config.json` : `"printer": { "profile": "star-mpop", "type": "device", "path": "/dev/usb/lp0" }`.
4. `sudo systemctl restart tpe-bridge`. `/health` → `printer.reachable: true` si le fichier est
   accessible en écriture.

## 3. Bluetooth (dépannage)

Appairer l'mPOP (code PIN de l'étiquette), relever le **port COM sortant** créé par Windows, puis
`"path": "\\\\.\\COM5"` (remplacer 5). Moins fiable que l'USB (mise en veille, appairage) : à
réserver au dépannage.

## 4. Recette

| Étape                                    | Attendu                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| PWA › Réglages › « Tester la connexion » | `imprimante device joignable`                             |
| « Test imprimante »                      | ticket 32 colonnes, accents et `€` corrects, pas de coupe |
| Bouton « Tiroir » (en-tête)              | le tiroir intégré s'ouvre (JET `drawer_opened`)           |
| Vente espèces                            | ticket + ouverture du tiroir                              |
| Rapports › Lecture X › Imprimer          | rapport X lisible, montants complets (jamais tronqués)    |
| Clôture de caisse                        | Z1 imprimé automatiquement                                |

Caractères illisibles (`Ã©` au lieu de `é`) : forcer la page de codes avec
`"codepageNumber": 4` (CP858, table Star) ou `32` (CP1252) selon le paramétrage de l'imprimante.
Texte correct mais attributs affichés en clair (`E`, `i`…) : l'imprimante est en émulation
ESC/POS ; repasser en StarPRNT avec l'utilitaire Star, ou mettre `"commandSet": "escpos"`.
