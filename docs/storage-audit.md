# Audit d'occupation disque — 15 septembre 2026

Question posée : environ 70 Go semblent avoir été pris depuis les
expérimentations autour de NewPi. Où sont-ils, qu'est-ce qui peut être nettoyé,
et qu'est-ce qui doit être conservé ?

**Réponse courte.** NewPi lui-même n'occupe pas 70 Go. L'application, sa base
mémoire, ses sauvegardes et ses sessions tiennent en **moins de 40 Mio**. Ce qui
a rempli le disque est la *sortie de compilation* de six projets Tauri, l'état
des simulateurs Xcode, et des caches de paquets que rien ne fait jamais tourner.
Le total mesuré sur les 39 cibles suivies est de **107,89 Gio**, dont
**49,11 Gio reconstructibles sans perte d'information**.

Aucune suppression n'a été faite hors d'un répertoire isolé construit pour le
test. La section `Storage` décrite plus bas est la partie outillée de cet audit.

---

## 1. Méthode

Deux chiffres sont mesurés pour chaque cible, et les deux sont reportés :

| Figure | Source | Ce qu'elle répond |
| --- | --- | --- |
| **alloué** | `st_blocks * 512` | « pourquoi le disque est plein » |
| **logique** | `st_size` | « quelle taille ce fichier annonce » |

Un lien symbolique n'est jamais suivi ni compté. Un inode à plusieurs liens
n'est compté qu'une fois : c'est le cas de tout `target/` Cargo, qui lie chaque
artefact depuis `deps/` vers son parent. Sans cette règle, `target/` de NewPi se
lit à 6,4 Gio au lieu de 3,64 Gio — la mesure a été confrontée à `du -sk` et
donne le même octet.

Les mesures ont été prises avec `pnpm storage`, la commande ajoutée par ce
travail ; le rapport et l'outil lisent donc la même table.

---

## 2. Inventaire classé par taille

Tout ce qui dépasse 100 Mio, avec son rôle et sa classe.

| Taille allouée | Cible | Rôle | Classe | Où |
| ---: | --- | --- | --- | --- |
| 22,61 Gio | Appareils du simulateur iOS | données | protégé | `~/Library/Developer/CoreSimulator/Devices` |
| 16,98 Gio | Symboles des appareils iOS | build jetable | reconstructible | `~/Library/Developer/Xcode/iOS DeviceSupport` |
| 11,30 Gio | Déploiement web Autodesk (Fusion) | données | protégé | `~/Library/Application Support/Autodesk/webdeploy` |
| 10,26 Gio | Machine virtuelle de Claude Desktop | données | protégé | `~/Library/Application Support/Claude/vm_bundles` |
| 10,24 Gio | Xcode DerivedData | build jetable | reconstructible | `~/Library/Developer/Xcode/DerivedData` |
| 7,19 Gio | Profil Chrome | données | protégé | `~/Library/Application Support/Google/Chrome` |
| 6,82 Gio | Émulateurs Android | données | protégé | `~/.android/avd` |
| 6,19 Gio | Cache npm (`_cacache`) | cache reconstructible | reconstructible | `~/.npm/_cacache` |
| 3,64 Gio | **Build Rust de NewPi** | build jetable | reconstructible | `src-tauri/target` |
| 1,93 Gio | Environnements `npx` | cache reconstructible | reconstructible | `~/.npm/_npx` |
| 1,73 Gio | Cache utilisateur | cache reconstructible | reconstructible | `~/.cache` |
| 1,52 Gio | Cache Dart/Flutter | cache reconstructible | reconstructible | `~/.pub-cache` |
| 1,50 Gio | Caches Gradle | cache reconstructible | reconstructible | `~/.gradle/caches` |
| 0,97 Gio | Registre cargo | cache reconstructible | reconstructible | `~/.cargo/registry` |
| 0,68 Gio | Cache du serveur d'analyse Dart | cache reconstructible | reconstructible | `~/.dartServer` |
| 0,55 Gio | Navigateurs Playwright | cache reconstructible | reconstructible | `~/Library/Caches/ms-playwright` |
| 0,55 Gio | Chaînes d'outils rustup | état applicatif | protégé | `~/.rustup/toolchains` |
| 0,55 Gio | Bacs à sable microsandbox | cache reconstructible | reconstructible | `~/.microsandbox` |
| 0,54 Gio | Magasin pnpm global | cache reconstructible | reconstructible | `~/Library/pnpm` |
| 0,50 Gio | Cache SwiftPM | cache reconstructible | reconstructible | `~/Library/Caches/org.swift.swiftpm` |
| 0,40 Gio | Navigateurs Playwright MCP | cache reconstructible | reconstructible | `~/Library/Caches/ms-playwright-mcp` |
| 0,36 Gio | Caches de mise à jour des outils | cache reconstructible | reconstructible | `~/Library/Caches/dotslash` |
| 0,34 Gio | Cache Homebrew | cache reconstructible | reconstructible | `~/Library/Caches/Homebrew` |
| 0,32 Gio | Cache pnpm | cache reconstructible | reconstructible | `~/Library/Caches/pnpm` |
| 0,12 Gio | Cache node-gyp | cache reconstructible | reconstructible | `~/Library/Caches/node-gyp` |

### Le pied NewPi, en entier

| Taille | Cible | Rôle | Classe |
| ---: | --- | --- | --- |
| 3,64 Gio | `src-tauri/target` — sortie de compilation | build jetable | reconstructible |
| 33 Mio | `~/Library/Caches/io.newpi.desktop` — cache WebView | cache | reconstructible |
| 18 Mio | `~/.dsh/attachments` — pièces jointes des sessions | sessions | protégé |
| 16 Mio | `~/.dsh/sessions` — historique des conversations | sessions | protégé |
| 14 Mio | `node_modules` du projet | cache | reconstructible |
| 14 Mio | `.pnpm-store` du projet | cache | reconstructible |
| 2 Mio | `~/Library/Application Support/NewPi/plugins` | état | protégé |
| 1 Mio | `pb_data` — **la base mémoire** | mémoire | protégé |
| 1 Mio | `~/Library/WebKit/io.newpi.desktop` | cache | reconstructible |
| 0 | `~/Library/Application Support/NewPi/backups` | sauvegardes | protégé |
| 0 | `pb_data/backups` — instantanés du sidecar | sauvegardes | protégé |

**Total NewPi et moteur : 3,79 Gio**, dont 3,66 Gio de sortie de compilation.

Au moment de l'audit, la base mémoire contient **5 souvenirs**, tous sous le
namespace historique `cyril` — le dossier de travail par défaut était alors le
dossier personnel. Cette observation reste historique : ces souvenirs ne sont
ni renommés ni migrés silencieusement. Le runtime actuel n'attribue plus le
dossier personnel à un projet lorsqu'aucun projet n'est ouvert.

---

## 3. Ce qui a réellement produit la croissance

### 3.1 Six sorties de compilation Tauri : 24,73 Gio

| Projet | `target/` |
| --- | ---: |
| `Desktop/printvault` | 5,8 Gio |
| `Desktop/Armor Intelligence` | 4,7 Gio |
| `Desktop/dixit` | 4,2 Gio |
| `Documents/newpi` | 3,6 Gio |
| `Desktop/dibtp` | 3,4 Gio |
| `Desktop/la-belle saison` | 3,0 Gio |

C'est **le** poste lié aux expérimentations. Chaque `tauri dev` écrit un profil
`debug` complet (dépendances Rust compilées avec informations de débogage,
sorties incrémentales) ; chaque `tauri build` ajoute un profil `release` entier
et une image disque. Rien n'est jamais élagué : `target/debug/incremental`,
`target/debug/build` et `target/debug/deps` coexistent avec `release`.

### 3.2 L'état Xcode et les simulateurs : 49,83 Gio

`CoreSimulator/Devices` 22,61 + `iOS DeviceSupport` 16,98 + `DerivedData` 10,24.

Cinq appareils simulés portent à eux seuls 22 Gio (6,7 / 4,8 / 4,5 / 3,2 /
2,6 Gio) ; dix-sept autres, jamais démarrés, en portent 17 Mio chacun. Le motif
est celui d'un simulateur créé par expérimentation et jamais supprimé.
`iOS DeviceSupport` est une copie des symboles par version d'iOS vue sur un
appareil — 17 Gio de contenu retéléchargeable.

### 3.3 Les caches de paquets : 18,42 Gio

`~/.npm/_cacache` seul pèse 6,19 Gio et son dernier accès remonte à avril 2026.
`~/.npm/_npx` garde 1,93 Gio d'environnements créés par des `npx` ponctuels.
À eux deux, ils expliquent la quasi-totalité de l'écart entre ce que la machine
télécharge et ce qu'elle utilise.

### 3.4 Les applications tierces : 28,75 Gio

Autodesk Fusion (11,30), la machine virtuelle de Claude Desktop (10,26), le
profil Chrome (7,19). Hors du périmètre de NewPi, mais c'est là qu'est passé le
plus gros bloc unitaire après les simulateurs.

### 3.5 Les fuites et rétentions non bornées identifiées

1. **Aucune politique de nettoyage pour `target/`.** Un `cargo clean` n'est
   jamais lancé ; debug, release et incrémental s'accumulent par projet. Chaque
   nouvelle expérimentation Tauri ajoute 3 à 6 Gio définitifs.
2. **`~/.npm/_cacache` n'est jamais élagué.** Le cache npm ne se borne ni par
   taille ni par âge ; il a atteint 6,19 Gio pour un dernier accès en avril.
3. **`~/.npm/_npx` accumule un environnement par `npx`.** Un dossier par paquet
   lancé une fois, jamais réutilisé, jamais supprimé.
4. **Un appareil de simulateur par essai.** Aucun `xcrun simctl delete` n'est
   lancé ; cinq appareils portent 22 Gio.
5. **`DerivedData` par projet Xcode**, sans élagage, 10,24 Gio.
6. **Aucun journal NewPi, aucun fichier de log dans l'état de l'application** :
   la fuite n'est pas là. Le seul journal du périmètre est `~/.npm/_logs`, à
   44 Kio — négligeable, et pourtant sans rotation.
7. **Les sessions du moteur ne fuient pas.** 16 Mio pour 16 fichiers, la plus
   grosse session à 5,9 Mio compressée. Rien à faire ici.
8. **La base PocketBase ne fuit pas.** 1 Mio, cinq souvenirs, aucun `-wal`
   résiduel. Les instantanés du sidecar sont élagués par PocketBase lui même.

**Ce qui n'est pas la cause :** NewPi. Son binaire, ses greffons, sa base, ses
sauvegardes et ses sessions réunis ne dépassent pas 40 Mio. Le seul poste NewPi
qui compte est `src-tauri/target`, c'est-à-dire le compilateur, pas
l'application.

---

## 4. Politique de rétention proposée

Elle est déclarée une fois, dans `plugins/storage-console/catalog.js`
(`RETENTION_POLICY`), et rendue par la section `Storage` à côté des chiffres
auxquels elle s'applique.

| Rôle | Automatique | Durée | Budget | Règle |
| --- | --- | --- | --- | --- |
| build jetable | aucune | — | 8 Gio | Reconstructible par la commande qui l'a produit. Jamais supprimé sans demande. |
| cache reconstructible | aucune | — | 12 Gio | Reconstructible par téléchargement ou recalcul. Jamais supprimé sans demande. |
| journaux | **rotation** | 7 jours | 50 Mio | Seule classe rotative sans demande : un journal tronqué ne perd aucun état. |
| sessions | jamais | 30 jours, 50 dernières par projet | — | Une conversation appartient à l'utilisateur. NewPi ne les touche pas. |
| mémoire PocketBase | jamais | — | — | Jamais automatique. Section Memory, souvenir par souvenir, après confirmation. |
| sauvegardes | jamais | — | — | Jamais supprimées, ni par NewPi ni par le sidecar. |
| état applicatif | jamais | — | — | Binaire, identifiants, greffons. Supprimer casse le démarrage. |

Le budget n'est pas une limite appliquée de force : c'est un seuil au delà
duquel la section affiche `⚠ hors budget`. Un budget qui supprime tout seul
serait un budget qui supprime la chose qu'on est en train d'utiliser.

### Sur les sauvegardes PocketBase

`~/Library/Application Support/NewPi/backups/` est un **frère** de
`pocketbase/`, pas un enfant de `pb_data/` : PocketBase élague le dossier
d'instantanés qu'il possède, et une sauvegarde demandée par l'utilisateur n'a
pas à disparaître avec lui. La section `Storage` ne supprime **rien** sous
`backups/` ni sous `pb_data/backups/`, et la section `Backup` ne fait que
créer, lister, inspecter et restaurer.

---

## 5. La section Storage

Ajoutée comme troisième section injectée, à côté de `Memory` et `Backup`, avec
une commande équivalente pour le terminal.

```sh
pnpm storage                       # tableau complet + politique
pnpm storage --scope newpi         # une portée seulement
pnpm storage --preview npm-cacache # cible, taille, coût de la suppression
pnpm storage --clean npm-cacache --confirm npm-cacache
```

Dans l'interface : une entrée `Storage` dans le pied de la barre latérale, un
panneau qui liste les 39 cibles groupées par portée, triées par taille, avec
pour chacune son rôle, sa classe, sa taille allouée, sa taille logique, le
chemin exact, et un bouton `Nettoyer…` pour les seules cibles reconstructibles.

### Ce que la section ne peut pas faire

Trois verrous, et le troisième est le vrai :

1. La cible doit être déclarée `safe` dans le catalogue. Le navigateur ne peut
   nommer qu'un identifiant du catalogue, jamais un chemin.
2. Le chemin est revérifié sous l'une des racines résolues au lancement, après
   `path.resolve` — un `..` ou un parent symbolique ne fait pas sortir du
   périmètre.
3. **Une session, une mémoire ou une sauvegarde n'a aucune voie de suppression
   dans ce plugin.** Ce n'est pas une confirmation, c'est un chemin de code
   absent : `runSafeCleanup` refuse un identifiant protégé avant même de
   résoudre un chemin. Une boîte de dialogue est à une frappe de profondeur ;
   une fonction qui n'existe pas ne se clique pas.

Et la suppression d'une cible reconstructible demande de **recopier
l'identifiant de la cible** dans un champ, avec la cible et la taille affichées
au dessus. Le serveur revérifie cette recopie et revérifie que la taille mesurée
correspond encore à celle qui a été montrée — une compilation qui grossit entre
l'aperçu et la confirmation fait échouer la suppression au lieu d'effacer autre
chose que ce qui était annoncé.

### Ce qui a été implémenté

Uniquement les nettoyages sûrs, conformément à la demande :

- `remove-directory` — supprime le dossier, son propriétaire le recrée :
  `src-tauri/target`, `node_modules`, `.pnpm-store`, `DerivedData`,
  `iOS DeviceSupport`, caches pnpm et applicatifs.
- `clear-contents` — vide le dossier et garde sa place : `_cacache`, `_npx`,
  registre cargo, `~/.cache`, caches Gradle/pub/Dart/Homebrew/node-gyp,
  Playwright, SwiftPM, microsandbox.

Aucune suppression de session, de mémoire PocketBase ou de sauvegarde n'a été
implémentée — ni dans la section, ni dans la commande, ni dans le moteur de
nettoyage.

---

## 6. Vérification

Tout est dans un répertoire isolé ou sur une copie ; rien n'a été touché sur la
machine hors de ces copies.

### Tests

| Suite | Résultat |
| --- | --- |
| `cargo test` (Rust, greffons embarqués, patch de lancement, sidecar) | 33/33 |
| `node --test tests/*.test.mjs` (dont 29 pour Storage) | 106/106, 1 ignoré |

### Répertoire isolé : la commande

Un faux dossier personnel avec la forme attendue par le catalogue, contenant
12 Mio de build jetable, 4 Mio de cache npm, et trois choses à ne pas perdre —
une session, `data.db`, une sauvegarde ZIP.

- `--preview newpi-target` → cible, taille allouée, taille logique, coût.
- `--clean dsh-sessions --confirm dsh-sessions` → refus `STORAGE_GUARDED_TARGET`.
- `--clean newpi-pb-data --confirm newpi-pb-data` → refus `STORAGE_GUARDED_TARGET`.
- `--clean newpi-backups --confirm newpi-backups` → refus `STORAGE_GUARDED_TARGET`.
- `--clean newpi-target` sans `--confirm` → refus, avec cible et taille affichées.
- `--clean newpi-target --confirm newpi-target` → 12 Mio récupérés, dossier parti.
- `--clean npm-cacache --confirm npm-cacache` → 4 Mio récupérés, dossier conservé
  et vide.
- Après coup : session, `data.db` et sauvegarde intacts.

### Démarrage réel, sur un monde isolé

Le vrai `dsh web` et le vrai PocketBase, sur une **copie** du dossier moteur —
16 sessions réelles comprises — et une **copie** de `pb_data`, avec le patch de
lancement produit par le générateur Rust lui même (celui que `cargo test` écrit)
et ses racines substituées. 18/18 vérifications :

- le patch généré nomme la section `Storage` ;
- PocketBase démarre sur la copie de la base mémoire ;
- le moteur démarre avec le jeu de greffons complet ;
- la page servie est authentifiée et porte la section `Storage` injectée ;
- `storage.status` répond avec 39 cibles ; `storage.scan` mesure le build ;
- la mémoire PocketBase, les sessions et une confirmation non recopiée sont
  **refusées** ;
- le build jetable est nettoyé, 3 002 368 octets récupérés ;
- `memory.status` répond à travers le moteur : `projet=cyril souvenirs=5` — les
  cinq souvenirs réels sont lus par le nouveau jeu de greffons ;
- les 16 sessions réelles sont intactes, empreinte par empreinte ;
- les dépendances du projet n'ont pas été touchées.

### L'instance en cours

NewPi tournait pendant tout l'audit ; il n'a été ni redémarré ni interrompu.
Après l'ensemble des tests, son PocketBase et son moteur écoutent toujours, et
les cinq souvenirs sont là, inchangés.

En revanche, l'empreinte SHA-256 du **fichier** `pb_data/data.db` a changé en
cours d'audit, et il faut le dire précisément plutôt que de le taire. La taille
du fichier est la même (188 416 octets) et les cinq lignes sont les mêmes ; ce
qui a bougé est l'écriture interne de PocketBase sur la connexion vivante —
entre autres l'authentification superutilisateur utilisée pour vérifier le
magasin. Autrement dit : je n'ai supprimé aucun souvenir, mais je ne peux pas
prétendre que le fichier n'a pas été écrit. Vérification après coup :
`GET /api/collections/memories/records` répond `totalItems: 5`, avec les cinq
mêmes contenus.

Le redémarrage de l'application installée reste à faire pour
charger la nouvelle section : le binaire en cours d'exécution a été compilé avant
ce travail.

---

## 7. Espace récupéré, et ce qui reste volontairement conservé

**Récupéré : 0 octet sur la machine.** Les seules suppressions ont eu lieu dans
des répertoires temporaires isolés construits pour le test (16 Mio au total), et
ils ont été supprimés avec le reste du bac à sable.

C'est délibéré : l'audit devait mesurer avant de supprimer. Ce qui peut l'être
sans perte, et sous quelle commande :

| Commande | Récupère | Coût |
| --- | ---: | --- |
| `pnpm storage --clean newpi-target --confirm newpi-target` | 3,64 Gio | une recompilation |
| `pnpm storage --clean xcode-derived-data --confirm xcode-derived-data` | 10,24 Gio | Xcode reconstruit au prochain build |
| `pnpm storage --clean xcode-device-support --confirm xcode-device-support` | 16,98 Gio | Xcode recopie au prochain branchement |
| `pnpm storage --clean npm-cacache --confirm npm-cacache` | 6,19 Gio | retéléchargement npm |
| `pnpm storage --clean npm-npx --confirm npm-npx` | 1,93 Gio | le prochain `npx` réinstalle |
| les autres caches reconstructibles | 10,13 Gio | retéléchargement / recalcul |

Soit **49,11 Gio** disponibles sans perdre une seule information.

**Volontairement conservé :**

- `~/Library/Application Support/NewPi/pocketbase/pb_data` — 5 souvenirs.
- `~/Library/Application Support/NewPi/backups` — les sauvegardes demandées.
- `pb_data/backups` — instantanés du sidecar, élagués par PocketBase.
- `~/.dsh/sessions` (16 Mio) et `~/.dsh/attachments` (18 Mio) — l'historique des
  conversations. La politique dit 30 jours et 50 sessions minimum par projet ;
  elle n'est pas appliquée par un programme, et c'est voulu.
- `~/.dsh/profiles/node_modules` et `~/.rustup/toolchains` — sans eux, plus de
  greffons et plus de compilateur.
- `~/Library/Application Support/NewPi/plugins` et `credentials`.
- Les 58,78 Gio classés `protégé` : simulateurs, émulateurs Android, machine
  virtuelle de Claude, profil Chrome, déploiement Autodesk, davantage. Ces
  données appartiennent à d'autres applications ; elles sont **mesurées et
  affichées**, jamais touchées. Les nettoyer demande leurs propres outils
  (`xcrun simctl delete`, le Device Manager d'Android Studio, le déployeur
  Autodesk).

---

## 8. Ce qu'il reste à décider

1. **Redémarrer NewPi** pour charger la section `Storage` ; le binaire en cours
   a été compilé avant ce travail.
2. **Ouvrir le projet dans NewPi** pour que la mémoire ait une portée : sans
   projet ouvert, le lancement démarre dans le dossier personnel mais ne lui
   attribue ni nom ni namespace, donc rien n'est lu ni écrit. Les cinq
   souvenirs enregistrés sous l'ancien namespace dérivé restent intacts.
3. **Élaguer les simulateurs inutilisés** avec `xcrun simctl delete unavailable`,
   puis appareil par appareil : c'est le plus gros poste, et le seul que NewPi
   ne doit pas toucher.
