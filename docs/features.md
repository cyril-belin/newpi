# NewPi — inventaire des fonctionnalités

Ce document est la carte des fonctionnalités de NewPi : ce qu'il fait, où cela
vit dans le dépôt, et où sont les preuves. Il est écrit à partir du code
réellement présent, pas d'une intention : quand une fonctionnalité n'existe
qu'à moitié, c'est dit à l'endroit où elle est décrite.

Le récit complet — pourquoi chaque choix a été fait, et ce qui a été mesuré —
reste [`README.md`](../README.md). L'audit disque est dans
[`storage-audit.md`](./storage-audit.md). Ce fichier ne les remplace pas : il
les résume et les met en table.

## 1. Identité et architecture

NewPi est une **application macOS native** qui possède la fenêtre, le cycle de
vie, la mémoire des projets, le disque et le lancement du moteur. L'interface
est celle que le moteur sert sur la boucle locale. Le moteur n'est pas
modifié : NewPi s'y greffe par un patch de lancement et par des plugins.

| Processus | Rôle | Propriété |
| --- | --- | --- |
| Fenêtre WebKit (Tauri) | affiche l'interface, possède l'écran de démarrage local | NewPi |
| Runtime `node dsh web` | sert l'interface, l'API et les WebSocket sur `127.0.0.1`, port préféré `7317` | le moteur, lancé et arrêté par NewPi |
| Sidecar **PocketBase** | base de la mémoire, liée à `127.0.0.1` uniquement | binaire officiel épinglé, embarqué dans le bundle |

Résolution du runtime, dans l'ordre, à la première réussite :

1. runtime embarqué dans l'application (`Contents/Resources/runtime/…`) ;
2. `NEWPI_NODE` + `NEWPI_DSH_ENTRY` ;
3. `NEWPI_DSH_BIN`, puis la commande `dsh` trouvée sur le `PATH` complété par
   `~/.local/bin`, `~/bin`, `~/.cargo/bin`, `/usr/local/bin` et
   `/opt/homebrew/bin`.

Cycle de vie : NewPi choisit un port libre, lance le runtime dans un **groupe
de processus** dédié, lit la ligne de disponibilité, puis crée une fenêtre dont
l'URL porteuse de jeton est le **premier chargement** (voir § 4). À la
fermeture, `SIGTERM` au groupe, puis `SIGKILL` après six secondes : les shells
persistants et les tâches de fond du harness s'arrêtent avec lui.

### Où vivent les données

```
~/Library/Application Support/NewPi/
├── launcher.patch.yml                 patch de lancement, régénéré à chaque lancement
├── projects.json                      registre des projets (project-model)
├── backups/                           LES SAUVEGARDES DE L'UTILISATEUR
├── plugins/                           plugins déployés depuis le binaire
└── pocketbase/
    ├── pocketbase                     binaire officiel extrait et vérifié
    ├── credentials                    superutilisateur local, mode 600
    ├── pb_migrations/                 migration de la collection `memories`
    └── pb_data/                       LA BASE
```

Rien de tout cela n'est dans le bundle : une mise à jour de `NewPi.app` laisse
ces fichiers intacts.

## 2. L'interface affichée (surfaces du moteur)

L'IDE visible est celui du bundle `dsh-web-app` (profil `web` =
`dsh-base` + `dsh-web-app`). NewPi n'en retire ni n'en remplace aucun module :
il ajoute sa marque et ses propres sections. Les surfaces montées par ce
bundle :

| Surface | Ce que l'utilisateur a |
| --- | --- |
| **Sessions** | liste, création, reprise, titre, statistiques, export du journal, plan de tour, références entre sessions |
| **Conversation / Chat** | messages, appels d'outils et résultats, feedback par message, pièces jointes, envoi de fichiers |
| **Plan mode** | l'agent propose un plan ; l'utilisateur approuve ou continue à planifier |
| **Approbations et permissions** | demandes d'approbation, presets de permissions, politique de sandbox |
| **Objectifs** | objectif long, rounds de continuation, état bloqué ou terminé |
| **Jobs et planification** | tâches de fond et leurs sorties, tâches planifiées |
| **Sous-agents** | délégation en arrière-plan, `subagent` et `subagent_fork`, notice de fin |
| **Workflows** | orchestration multi-agents par script JS, phases et résultats structurés |
| **Skills** | catalogue de compétences chargeables |
| **Arbre de fichiers et aperçu** | colonne de droite du moteur ; **lecture seule** |
| **Workspace** | enregistrement durable des dossiers de travail, sessions rattachées |
| **Sélection de modèle** | choix du modèle et de l'effort depuis l'interface |
| **Commandes** | commandes slash, déclencheurs `@` de référence de fichier, questions à l'utilisateur |
| **Réglages** | général, modèles, plugins, inventaire des plugins |
| **Thème et locale** | clair-sombre, langue |
| **Deliverables** | fichiers déclarés livrables, ouverture dans l'application hôte |
| **Terminal** | shells **persistants** par l'outil bash et la sandbox ; pas de panneau terminal dédié dans ce profil |
| **HMR client** | rechargement à chaud des plugins client en développement |

Côté agent, les outils qui font vivre ces surfaces : bash et sandbox,
lecture/écriture/édition de fichiers, glob, grep, jobs, sous-agents, workflows,
skills, goals, mémoire, question à l'utilisateur, plan mode, MCP.

## 3. Les plugins propres à NewPi

Huit plugins, écrits dans `plugins/`, compilés dans le binaire
(`src-tauri/src/assets.rs`), déployés dans le répertoire d'état à chaque
lancement, et montés par le patch de lancement régénéré
(`launcher.patch.yml`). Chaque plugin est un greffon Cordis : il ajoute un
service, des outils, une route ou une section, et ne modifie aucun fichier du
moteur.

| Plugin | Ce qu'il apporte | Service ou route |
| --- | --- | --- |
| `newpi-brand` | le nom et le mark du produit dans l'interface | `tapIndex`, route `/newpi/whale.svg` |
| `pocketbase-memory` | la connexion et le stockage de la mémoire | `ctx.pocketbaseMemory` |
| `memory-tools` | les trois outils du modèle | `remember`, `recall`, `forget` |
| `memory-console` | les sections Memory et Backup | `POST /api/newpi.console` |
| `storage-console` | la section Storage | `POST /api/newpi.console` |
| `model-router` | la politique de routage des modèles | `ctx.modelRouter` |
| `context-cache-manager` | les couches, versions et la télémétrie du cache | `ctx.contextCache` |
| `project-model` | le projet courant et son registre | `ctx.projectModel`, `POST /api/newpi.project` |
| `projects-console` | la section Projects (projet ouvert, récents, changement) | `ctx.projectsConsole`, l'endpoint du Project Model |

Le patch de lancement est le **dernier** overlay de la composition du profil :
il gagne sur le `cordis.patch.yml` du profil. Le supprimer ne change rien — le
lancement suivant le réécrit.

### 3.1 Marque — `newpi-brand`

- Titre de l'onglet et de la fenêtre : l'élément `<title>` du HTML servi est
  remplacé, puis l'accesseur `document.title` est verrouillé, parce que le
  client réécrit le titre après son démarrage.
- Wordmark de la barre latérale : le tracé SVG du moteur est masqué par une
  règle scopée à `data-slot="sidebar.brand.name"`, et un libellé NewPi est
  ajouté à côté.
- Mark : une `<img>` pointe vers `/newpi/whale.svg`, une route servie par le
  plugin depuis `assets/whale.svg`. Dessiné à **28 px** dans une rangée de
  28 px : la silhouette simplifiée est la seule variante lisible à cette
  taille.
- Icône de l'application : `assets/logo.svg` → `assets/icon-source.png`
  (1024 px) → `.icns` par `pnpm icon`.

### 3.2 Mémoire durable — `pocketbase-memory` + `memory-tools`

- **Stockage** : PocketBase en sidecar local, binaire officiel macOS ARM64
  épinglé par version **et** par empreinte SHA-256
  (`scripts/pocketbase-pin.mjs`), extrait une fois dans le répertoire d'état,
  relancé sans aucun accès réseau.
- **Outils du modèle** : `remember(content, kind)`,
  `recall(query, kind?, limit?)`, `forget(id)`.
- **Recherche** : `LIKE` insensible à la casse sur le contenu, du plus récent
  au plus ancien, 8 résultats par défaut, 50 au maximum. Pas de vecteurs, pas
  d'embedding, pas d'appel externe.
- **Cloisonnement** : une seule collection `memories` pour tous les projets,
  séparée par la colonne `project_id`. La portée vient exclusivement du projet
  ouvert dans `projects.json` (son `memoryNamespace`), ou de
  `NEWPI_WORKSPACE` dans le chemin de compatibilité explicite. Les trois outils
  n'exposent que `content`, `kind`, `query`, `limit` et `id`. Un identifiant
  d'un autre projet est introuvable et indistinguable d'un identifiant
  inexistant : `forget` répond `deleted: false` sans rien supprimer.
- **Aucun projet ouvert** : le runtime garde le dossier personnel uniquement
  pour pouvoir démarrer le harness, mais ne lui attribue ni nom, ni namespace,
  ni mémoire. Memory affiche « Aucun projet ouvert » et ne lit ni n'écrit rien.
  Les souvenirs existants dans un ancien namespace dérivé (par exemple
  `cyril`) restent intacts et ne sont pas migrés silencieusement.
- **Contenu attendu** : les descriptions d'outils demandent des
  **conclusions**, pas de l'activité — un bug résolu s'écrit avec symptôme,
  cause confirmée, correctif et preuve.
- **Désactivation** : `NEWPI_MEMORY=0` ne monte que les greffons sans base de
  données (marque, Storage, context & cache, projet).

### 3.3 Console Memory et Backup — `memory-console`

Deux sections injectées dans l'interface par `tapIndex` (un `<style>` et un
`<script>`, injection **idempotente**). Le siège est le pied de la barre
latérale (`sidebar.footer.action`) ; si ce siège n'existe pas, des boutons
flottants prennent le relais.

| Section | Ce qu'elle fait |
| --- | --- |
| **Memory** | compteur, répartition par `kind`, dernière écriture, recherche, filtre par kind, liste paginée, lecture complète d'un souvenir, suppression après confirmation explicite, état vide actionnable |
| **Backup** | créer une sauvegarde, restaurer une archive, ouvrir le dossier des sauvegardes dans le Finder, lister les archives avec date, taille et manifeste |

Le pont est **une seule route**, `POST /api/newpi.console`, enregistrée sur
`ctx.connection.fetch` — donc derrière le cookie de session, jamais sur
`ctx.webServer` qui est dispatché avant toute authentification.

| Action | Ce qu'elle fait |
| --- | --- |
| `memory.status` | nombre de souvenirs, répartition par kind, dernière écriture |
| `memory.page` | une page de la liste, filtrée par kind ou par recherche |
| `memory.read` | le contenu entier d'un souvenir |
| `memory.delete` | la suppression, après confirmation explicite |
| `backup.status` | les archives locales et leurs manifestes |
| `backup.create` | écrire une sauvegarde à un emplacement choisi |
| `backup.upload` | recevoir une archive lue dans la page, en base64 |
| `backup.inspect` | lire le manifeste d'une archive avant de la restaurer |
| `backup.restore` | remplacer la base, après confirmation explicite |
| `backup.reveal` | ouvrir le dossier des sauvegardes dans le Finder |

**Format d'une sauvegarde** : un seul zip, `manifest.json` + `pb_data/`. Les
fichiers de `pb_data/` viennent d'un instantané que **PocketBase a produit
lui-même** par son API de sauvegarde : NewPi ne lit jamais `data.db` pendant
que le serveur écrit, et n'arrête pas le serveur pour autant.

**Restauration** : une transaction avec retour arrière.

1. l'archive est vérifiée — intégrité zip, manifeste, version, empreintes
   SHA-256, en-tête SQLite — avant que quoi que ce soit soit touché ;
2. une sauvegarde de sécurité `…-avant-restauration-….zip` est prise ;
3. les écritures mémoire sont bloquées : un `remember` qui arrive attend ;
4. l'archive est remise au sidecar par sa propre API, qui redémarre le serveur
   autour de la nouvelle base, sur le même port et le même pid ;
5. le résultat est vérifié en **relisant la base** et comparé au manifeste ;
   sinon l'état précédent est remis en place.

Trois refus explicites : format inconnu ou illisible, format trop récent
(« mettez NewPi à jour »), PocketBase trop récent. Une sauvegarde écrite par un
PocketBase plus ancien est acceptée avec un avertissement.

### 3.4 Section Storage — `storage-console`

- Catalogue de 39 cibles suivies, chacune avec un **rôle** (build jetable,
  cache reconstructible, journaux, sessions, mémoire, sauvegardes, état
  applicatif, données) et une **classe** `reconstructible` ou `protégé`.
- Deux mesures par cible : taille **allouée** (`st_blocks * 512`, ce que le
  disque dépense) et taille **logique** (`st_size`, ce que le fichier
  annonce). Un lien symbolique n'est jamais suivi ; un inode à plusieurs liens
  n'est compté qu'une fois.
- Actions : `storage.status`, `storage.scan`, `storage.preview`,
  `storage.clean`.
- **Trois verrous** : le catalogue décide (le navigateur ne nomme qu'un
  identifiant) ; le chemin est revérifié sous les racines du lancement après
  `path.resolve` ; supprimer une session, une mémoire ou une sauvegarde **n'a
  pas de fonction** — `runSafeCleanup` refuse une cible protégée avant même de
  résoudre un chemin.
- Un nettoyage reconstructible exige la **recopie de l'identifiant** de la
  cible, et le serveur revérifie que la taille mesurée correspond encore à
  celle qui a été montrée (sinon `409`).
- La politique de rétention est **affichée**, pas appliquée : journaux en
  rotation 7 jours / 50 Mio, sessions conservées 30 jours et 50 par projet,
  budgets indicatifs de 8 Gio pour le build et 12 Gio pour les caches.
- Les cibles propres au projet sont toujours recalculées depuis la racine du
  projet ouvert. Sans projet ouvert, elles sont absentes et l'en-tête affiche
  « Aucun projet ouvert » plutôt que le dossier personnel.
- Équivalent en ligne de commande :

```sh
pnpm storage                        # tableau complet, groupé par portée
pnpm storage --scope newpi          # seulement le projet et son moteur
pnpm storage --preview npm-cacache  # cible, taille allouée, taille logique
pnpm storage --clean newpi-target --confirm newpi-target
```

### 3.5 Model Router — `model-router`

- Une seule politique de routage, dans le greffon : un agent demande un
  **rôle**, pas le nom d'un provider.

```js
const selection = ctx.modelRouter.forRole('coding');
for await (const chunk of ctx.modelRouter.stream('review', request, { sessionId })) { /* … */ }
```

| Mode | Ce qui décide | Changement à chaud |
| --- | --- | --- |
| `manual` | la configuration, et rien d'autre | refusé |
| `switch` | une sélection active, remplaçable | `switchTo({ provider, model })` |
| `auto` | le rôle demandé | `switchTo(…, { role })` pour surcharger un rôle |

- Rôles : `fast`, `coding`, `reasoning`, `research`, `review`, `default`. Un
  rôle non mappé résout vers `default` ; un rôle hors vocabulaire est refusé.
- **Route `Adaptive`** : le routeur enregistre sa propre route
  (`newpi-router/adaptive`) pour que le sélecteur de l'interface puisse
  *choisir la politique* et non un modèle. Le rôle est résolu depuis la requête
  — `purpose` (`compaction`, `session-title`) → `fast`, présence d'outils →
  `coding`, sinon `default` — puis la requête est **réécrite sur la route réelle
  avant l'envoi** : l'historique et le coût nomment le modèle qui a répondu, pas
  la pseudo-route. Le `fallback` du rôle s'applique sur un échec
  d'indisponibilité avant le premier morceau, et la réécriture suit — un repli
  est donc attribué à la route qui a répondu. La fenêtre de contexte annoncée
  est la **plus petite** des routes du plan et les modalités leur
  **intersection**, puisque n'importe quel rôle peut répondre.
- **Fallback** : uniquement sur un échec d'indisponibilité (provider ou modèle
  indisponible, délai, quota, débit, réseau, 5xx), et seulement **avant** le
  premier morceau émis. Un échec logique (`INVALID_ARGS`,
  `CONTEXT_WINDOW_EXCEEDED`, `AUTH`, `EMPTY_RESPONSE`, abandon) ne replie
  jamais. Un code inconnu ne replie pas : le classement échoue en fermé.
- **Bail de modèle** : la route d'une opération est figée à son début ; un
  `switchTo()` est refusé tant qu'un bail critique court. `force: true` est
  l'échappatoire explicite, et ne change pas le bail en cours.
- **Capacités** : `requirements` déclare ce qu'une tâche exige (plancher) ;
  `auto` écarte une route dont l'incapacité est prouvée. Une capacité inconnue
  n'est pas un échec, elle est rapportée.
- **Configuration** : `cordis.yml`, section `model_router`, validée avant le
  démarrage. Clé inconnue refusée, rôle hors vocabulaire refusé, et toute clé
  qui ressemble à un secret (`api_key`, `token`, `password`…) fait échouer la
  lecture avec un renvoi vers `$DSH_HOME/settings.yaml`. Sans bloc, aucun
  routeur n'est monté.
- **Observabilité** : chaque appel produit une entrée de journal (mode, rôle,
  provider, modèle, repli et sa raison, session, opération). Le greffon
  s'accroche à `llm/stream` pour **observer sans rediriger** ; la seule
  exception est la route `Adaptive`, choisie précisément pour déléguer la
  décision. La forme est fixée par `RECORD_KEYS` et tout diagnostic est nettoyé
  avant d'entrer.

### 3.6 Context & Cache Manager — `context-cache-manager`

Un prompt n'est pas un bloc homogène ; le cache d'un provider ne peut être
réutilisé que sur la partie qui n'a pas bougé.

| Couche | Stabilité | Source |
| --- | --- | --- |
| `core` | stable | les sections du prompt système assemblé |
| `project` | semi stable | les contributions de contexte d'exécution |
| `handoff` | semi stable | le résumé de la dernière compaction terminée |
| `session` | dynamique | l'historique avant le message courant |
| `live` | dynamique | le message courant et les résultats d'outil |

- Chaque couche est réduite à un **digest**, un compte et les noms qui l'ont
  composée. Aucune couche ne conserve le texte du prompt.
- `contextVersion` (`ctx_v1`…) nomme le préfixe cacheable
  `core + project + handoff` ; il n'avance que si son digest change.
  `handoffVersion` (`handoff_v1`…) nomme le handoff figé et n'avance qu'une
  fois par compaction **terminée**.
- **Pas de faux cache** : aucun prompt stocké, aucun préfixe servi, aucune
  estimation. Les seuls nombres rapportés sont des compteurs d'adaptateur ou
  de l'arithmétique dessus — `promptTokens = input + read + write`,
  `missTokens = input`, `hitRatio = read / promptTokens`. Un provider sans
  métrique de cache produit `available: false` et une raison : une absence de
  donnée, jamais une erreur, jamais un zéro fabriqué.
- API : `current()`, `snapshots()`, `versions()`, `recentCalls()`, `onCall()`,
  `cacheStats()`, `temperature()`, `temperatures()`, `describe()`,
  `hintsFor()`, `allHints()`.
- **Rien de tout cela ne décide d'une route** : la politique AUTO du Model
  Router est intacte, les données sont préparées et exposées, aucun appel ne
  les lit.

### 3.7 Project Model — `project-model`

Le projet courant et son registre, dans un petit document JSON sous le
répertoire d'état de NewPi.

- **Registre** : `projects.json` — projets récents (20 au maximum), projet
  courant, et pour chacun : racine canonique, réglages, sessions (200 au
  maximum), namespace mémoire, état de handoff, état d'interface
  (`lastSessionId`, `lastTab`, `recentFiles`). Écriture temporaire puis
  `rename` ; un document corrompu coûte la liste des récents, pas le
  lancement.
- **Service** `ctx.projectModel` : `currentProject`, `get`, `recent`,
  `projects`, `create`, `open`, `close`, `forget`, `attachSession`,
  `detachSession`, `sessions`, `adoptLiveSessions`, `uiState`, `setUiState`,
  `handoffState`, `setHandoff`, `describe`, `onChange`, `ready`, et les six
  méthodes Git (`gitStatus`, `gitDiff`, `gitCommit`, `gitFetch`, `gitPush`,
  `gitPull`).
- **Cinq capacités** par projet, avec `network` désactivée par défaut :
  `readWorkspace`, `writeWorkspace`, `terminal`, `git`, `network`.
  `assertCapability()` refuse en `403` une capacité non accordée, et
  `withCapability(cap, body)` fait de la vérification et du travail un seul
  appel, pour qu'une porte ne puisse pas être oubliée entre les deux.
  **Une seule capacité est modifiable** depuis l'interface : la liste du serveur,
  `MODIFIABLE_CAPABILITIES = ['network']`. `assertModifiableCapability()` refuse
  en `PROJECT_CAPABILITY_READONLY` (`403`) un nom connu qui n'y figure pas, et
  `updateCapability()` est le seul écrivain : il valide le nom et le booléen
  avant de toucher au projet, et rien d'autre dans le modèle ne l'appelle.
  **Double autorisation Git** : `git` couvre le travail local (détection du
  dépôt, statut, diff, commit), et `network` est exigée **en plus** pour toute
  action qui quitte la machine (`fetch`, `push`, mise à jour après un `fetch`).
  Un projet dont `git` est actif mais `network` refusé garde donc tout le local
  et voit ses deux boutons distants désactivés ; le refus a son propre code,
  `GIT_NETWORK_DENIED` (`403`), pour que l'interface dise « le réseau de ce
  projet doit être autorisé » plutôt qu'une erreur de capacité générique. Le
  statut Git porte `networkAllowed`, la seule chose que la page lit pour cela.
- **Garde d'opération** : toute opération enregistrée bloque un changement de
  projet (`PROJECT_BUSY`, `409`) ; `force: true` est l'échappatoire, jamais un
  défaut. Une opération Git (`kind: 'git'`) tient la garde pendant toute sa
  durée, et `restart()` la consulte aussi : un changement de projet, un oubli
  ou un redémarrage sont refusés pendant qu'elle court.
- **Git** (`git.js`) : un dépôt n'est utilisable que si
  `git rev-parse --show-toplevel` égale exactement la racine du projet. Un
  dépôt imbriqué, un sous-module, un dépôt parent, un dépôt absent, un conflit,
  une divergence ou une opération en cours sont refusés ou expliqués, jamais
  forcés. Aucune commande destructive n'est possible : les arguments sont une
  liste (`execFile`, pas de shell), un déni explicite refuse `reset`, `clean`,
  `checkout`, `rebase`, les mutations de remote et `--force` ; la seule mise à
  jour est `merge --ff-only`. La dernière synchronisation connue est conservée
  dans `gitState` sur l'enregistrement du projet.
- **Chemin** : `resolve(target)` ramène tout chemin à l'intérieur de la racine
  du projet, par la même fonction `resolveInside` que les autres
  consommateurs ; `..` ne fait pas sortir du périmètre.
- **Sessions** : `adoptLiveSessions()` adopte les sessions dont le `cwd` est
  dans le projet, et la décision est recopiée vers `ctx.workspaceRegistry`
  (au mieux : un refus de sa part ne fait pas échouer l'association).
- **Handoff** : une compaction terminée est lue depuis le registre de versions
  du Context & Cache Manager, jamais réinventée.
- **Seams optionnels** : `workspaceRegistry`, `sessions`, `contextCache`,
  `connection`. Aucun n'est une dépendance de démarrage : « la
  fonctionnalité est absente » reste distinguable de « NewPi n'a pas
  démarré ».
- **Endpoint** `POST /api/newpi.project` (derrière authentification) :

| Action | Ce qu'elle fait |
| --- | --- |
| `project.current` | le projet courant |
| `project.list` | les projets récents |
| `project.open` | ouvrir un projet connu par identifiant |
| `project.create` | créer un projet pour un dossier existant |
| `project.close` | fermer le projet courant |
| `project.forget` | retirer un projet de la liste des récents (aucun fichier supprimé) |
| `project.operations` | les opérations en cours, pour lire la garde avant un changement |
| `project.sessions` | les sessions associées |
| `project.capabilities` | les capacités du projet |
| `project.capability.set` | changer **une** capacité modifiable du projet ouvert (`name`, `allowed`, `confirm: true` requis) |
| `project.uiState` | l'état d'interface |
| `project.uiState.set` | fusionner un patch d'état d'interface |
| `project.chooseFolder` | demander un dossier à l'hôte (panneau natif `osascript`), puis le normaliser |
| `project.git.status` | l'état du dépôt : présent ou non, branche, distant, fichiers, commits en attente, dernière synchronisation |
| `project.git.diff` | l'aperçu lisible d'un fichier, du travail ou de l'index |
| `project.git.commit` | un commit local des fichiers choisis, avec le message écrit par l'utilisateur |
| `project.git.fetch` | lire ce que le distant contient (`fetch`), sans toucher à la copie locale |
| `project.git.push` | envoyer les commits locaux de la branche courante, jamais forcé |
| `project.git.pull` | mettre à jour par avance rapide seulement (`merge --ff-only`), après un `fetch` |
| `project.restart` | demander à NewPi de se fermer et de se rouvrir (`confirm: true` requis) |

Le navigateur ne peut **pas** fixer librement les capacités, le namespace
mémoire, le handoff, ni l'état d'un autre projet : ces clés ne sont pas
déclarées, donc la barrière de paramètres les refuse avant qu'une action les
voie. La seule capacité qu'une interface peut changer est celle de la liste du
**serveur** (`MODIFIABLE_CAPABILITIES`), et dans ce lot c'est `network` : une
action nomme la capacité, le modèle décide si ce nom lui appartient, refuse en
`PROJECT_CAPABILITY_READONLY` (`403`) tout ce qui n'y figure pas, et n'écrit
jamais avant d'avoir validé. `project.capability.set` ne déclare ni `id`, ni
`rootPath`, ni `projectId` : elle porte toujours sur le projet **actuellement
ouvert**, exige la garde (une opération critique en cours la refuse en
`PROJECT_BUSY`), exige un booléen, pas un patch, et exige **`confirm: true`** :
la confirmation est vérifiée par le Project Model lui-même, pas seulement par
l'interface. Un `confirm` absent, `false` ou d'un autre type est refusé en
`PROJECT_INVALID_ARGS` (`400`) avant toute écriture, si bien qu'une page qui
oublierait de demander la confirmation ne pourrait pas accorder une capacité.
Aucune action Git ne déclare de force, de refspec ni de nom de distant : ses
seuls paramètres sont un message et une liste de fichiers.
`project.git.status`, `project.git.diff` et `project.git.commit` exigent la
capacité `git` ; `project.git.fetch`, `project.git.push` et `project.git.pull`
exigent en plus `network`.

**État réel** : le service et l'endpoint sont complets et testés, et la section
**Projets** les lit (projet ouvert, récents, changement, zone **Autorisations du
projet**, et zone **Historique Git** : état, diff, commit local, envoi,
récupération en avance rapide). La zone des autorisations affiche les cinq
capacités en mots et un contrôle pour chacune de celles que le serveur ouvre ;
dans ce lot, seule **Réseau** en a un, avec une confirmation qui nomme le projet
et les conséquences, et le changement est relu immédiatement par la zone Git.
La sélection de projet enregistre le dernier projet choisi ; le moteur, lui,
garde son dossier de lancement jusqu'au redémarrage de NewPi.

### 3.8 Neutralisation de Mem0

Si le profil DSH déclare un paquet Mem0, NewPi écrit une ligne
`disabled: true` dans son patch de lancement : le paquet est débranché sans
que ses fichiers ni le profil soient touchés. Sur une installation qui ne
déclare pas Mem0, aucune ligne n'est écrite — le patch reste honnête sur ce
qu'il fait.

### 3.9 Console — `terminal-console`

Une commande à la fois, dans le dossier du projet, avec la sortie qui s'affiche
dans l'interface : `git`, `pnpm test`, `cargo`, `pnpm storage`. Une ligne dans le
siège de pied de la barre latérale, un panneau en surimpression, et une seule
route authentifiée sur la connexion partagée.

- **Ce qu'elle est** : `index.js` démarre `/bin/zsh -lc <commande>` dans le
  dossier porté par la ligne de patch (ou le projet courant du Project Model),
  dans **son propre groupe de processus** pour qu'un build ou un surveillant
  s'arrête entier. La réponse est un flux **NDJSON** : une trame `out` par
  morceau de texte, puis une trame `exit` (code, signal, troncature, durée).
- **Ce qu'elle n'est pas** : pas de PTY. `vim` et `htop` demandent un vrai
  terminal ; la console le dit au lieu de l'imiter à moitié. Le PTY viendra
  comme un second temps, avec sa propre bibliothèque à embarquer.
- **Ce que la page envoie** : une ligne de commande, et rien d'autre — ni
  dossier, ni shell, ni environnement. Le dossier vient de l'hôte, donc un
  navigateur ne peut pas en choisir un.
- **Ce que la page reçoit** : du texte. Couleurs, titres OSC et redessins par
  retour chariot sont réduits sur l'hôte (`plainText`), là où c'est testable sans
  navigateur, et la sortie est plafonnée (4 Mio, troncature signalée).
- **Arrêt** : le bouton Arrêter annule la requête, et l'hôte tue le groupe de
  processus. Un délai de 30 minutes arrête de lui-même une commande qui ne
  revient pas.

### 3.10 File d'attente des messages — `session-queue-guard`

Un message envoyé pendant qu'un agent travaille doit attendre la fin du tour
plutôt que de l'interrompre : une question de statut ne doit pas annuler le
travail sur lequel elle porte.

- **Ce qu'il est** : `index.js` enveloppe l'unique couture d'admission du
  harness — la méthode `prompt` du service `sessionController` — et remplace la
  valeur documentée `mode: 'steer'` par `mode: 'queue'`. Le client du harness
  passe par son transport RPC, et non par le `fetch` de la page : c'est le seul
  endroit qui couvre tous les clients à la fois.
- **Ce qu'il n'est pas** : il ne crée aucun message, ne réessaie aucun appel de
  modèle et ne touche à aucune autre valeur. Une demande qui n'est pas `steer`
  traverse sans être modifiée, la demande reçue n'est jamais mutée, et un second
  montage ne double pas l'enveloppe (marque par `Symbol`). Si la couture
  n'existe pas, il refuse de se monter au lieu de rester silencieusement inactif.
- **Pourquoi cette couture** : la page possède l'interface du message et le
  harness possède l'admission ; NewPi ne change que la valeur documentée, à
  l'endroit exact où elle est admise.

## 4. Sécurité et cloisonnement

1. **La page distante ne reçoit aucune API Tauri.** L'écran de démarrage, qui
   est local, a une seule capacité (`core:event:default`). La fenêtre
   d'interface, créée à l'exécution depuis `http://127.0.0.1`, est absente de
   `capabilities/default.json` : c'est une page web ordinaire.
2. **L'URL doit être le premier chargement de la fenêtre.** Le cookie est
   `SameSite=Strict` ; une navigation depuis l'écran de démarrage ferait
   retenir le cookie et le runtime répondrait
   `dsh web authentication required`. NewPi **construit** donc une fenêtre à
   l'URL plutôt que de naviguer.
3. **Aucun serveur distant.** Le sidecar est lié à `127.0.0.1` par un
   littéral, jamais `0.0.0.0`, sans TLS ; le dashboard et l'API REST ne
   répondent que sur la boucle locale et refusent tout appel non authentifié.
   Le seul trafic sortant est celui du modèle, comme en ligne de commande.
4. **Aucun secret dans l'interface.** Le mot de passe et l'URL du sidecar
   voyagent dans l'environnement du runtime ; l'interface reçoit seulement les
   chemins dont ses manifestes ont besoin.
5. **Barrière de paramètres** sur les trois ponts (`console`, `storage`,
   `project`) : une clé qu'une action ne déclare pas est refusée avant que
   l'action la voie.
6. **Une capacité ne se change que par la liste du serveur.** Le seul chemin qui
   écrit une capacité est `project.capability.set`, et il porte toujours sur le
   projet **ouvert** : l'action ne déclare ni `id`, ni `rootPath`, ni
   `projectId`. Le nom reçu est comparé à `MODIFIABLE_CAPABILITIES` (aujourd'hui
   `['network']`), et la confirmation explicite `confirm: true` est exigée par
   le modèle : vérification, valeur booléenne, confirmation et garde passent
   **avant** toute écriture, si bien qu'un refus laisse le registre identique
   octet pour octet. Le démarrage, l'ouverture d'un projet et la reprise après
   erreur ne touchent jamais une capacité : le modèle relit ce que le registre
   porte.
7. **Panneaux de fichiers.** Le choix d'une archive est un
   `<input type="file">` de la fenêtre, et les octets sont remis à l'hôte en
   base64 — jamais un chemin tapé. L'emplacement d'enregistrement est demandé
   par `osascript`, le mécanisme du moteur lui-même pour un sélecteur natif
   côté hôte ; la fenêtre appartient alors au processus `osascript`, ce qui
   est assumé.
8. **Sélecteur de dossier de projet.** Même mécanisme : l'action
   `project.chooseFolder` fait tourner `choose folder` **sur l'hôte**, et la
   page ne reçoit qu'un chemin déjà choisi par une personne. Toute racine
   retournée est ensuite canonisée et validée par le Project Model (`realpath`,
   `stat`, `isDirectory`) avant de devenir un projet ; un chemin refusé l'est
   avant toute écriture. La page ne peut pas déclencher de chemin libre.
9. **Relance de l'application.** `project.restart` demande à l'hôte de fermer
   puis de rouvrir NewPi, par `osascript` et l'identifiant de bundle — jamais
   par une commande construite à partir d'une chaîne. L'action exige
   `confirm: true`, ne fait rien hors d'un bundle, et le helper de relance est
   détaché de son groupe de processus pour survivre à l'arrêt du runtime.

## 5. Exploitation

```sh
pnpm install      # CLI Tauri et copies des modules du harness pour les tests
pnpm dev          # NewPi en développement, rechargement du Rust
pnpm build        # NewPi.app et une image .dmg
pnpm build:app    # seulement l'application, sans image disque
pnpm icon         # régénère les icônes depuis assets/icon-source.png
pnpm test         # tests Rust puis tests des plugins
pnpm storage      # occupation disque et nettoyages reconstructibles
pnpm test:pocketbase   # preuve de bout en bout contre le vrai binaire
pnpm test:backup       # sauvegarde, suppression, restauration
pnpm verify:running    # contrôle d'acceptation sur une instance en cours
pnpm verify:console    # pilote un vrai navigateur sur les sections injectées
pnpm verify:projects   # pilote un vrai navigateur sur la section Projets
pnpm verify:projects-git  # monte un dépôt et un distant bare isolés, puis prouve la zone Git dans l'interface
pnpm verify:projects-capability  # vrai moteur et vraie interface : réseau refusé, autorisé, refusé, sans dépôt ni réseau
```

**Boucle de développement des plugins** : `<état>/dev.json`
(`{"pluginsDir": "…/NewPi/plugins", "reload": true}`) fait du dépôt la source des
plugins — le patch de lancement monte ces fichiers, le déploiement ne les touche
plus — et `reload` fait redémarrer le runtime une fois les écritures stabilisées,
donc enregistrer suffit. Absent, illisible ou pointant vers un dossier inexistant,
le fichier est ignoré et le binaire reste la source.

| Variable | Effet |
| --- | --- |
| `NEWPI_NODE` | interpréteur Node à utiliser |
| `NEWPI_DSH_ENTRY` | point d'entrée du harness |
| `NEWPI_DSH_BIN` | commande `dsh` à résoudre |
| `NEWPI_WORKSPACE` | racine de travail explicite ; sinon le dernier projet choisi, et le dossier personnel reste seulement le répertoire de compatibilité du harness |
| `NEWPI_MEMORY` | `0`, `false`, `no` ou `off` désactivent la mémoire |
| `NEWPI_POCKETBASE` | binaire PocketBase au lieu de l'archive épinglée |
| `DSH_HOME` | lue par le harness lui-même |

NewPi pose en outre `DSH_MEMORY_URL`, `DSH_MEMORY_IDENTITY`,
`DSH_MEMORY_PASSWORD` et `DSH_MEMORY_PROJECT_ID` pour les plugins mémoire, et
`NEWPI_WEB_URL` est ce que `pnpm verify:console` attend pour piloter une
instance en cours.

## 6. Ce qui est vérifié

Les preuves ligne par ligne sont dans le tableau du [`README.md`](../README.md#ce-qui-a-été-vérifié).
Les suites de tests qui les portent :

| Suite | Couverture |
| --- | --- |
| `tests/memory.test.mjs` | comportement des plugins mémoire, cloisonnement, schémas d'outils |
| `tests/memory-console.test.mjs` | console Memory et Backup, format d'archive, restauration |
| `tests/storage-console.test.mjs` | catalogue, mesure, nettoyage, refus des cibles protégées |
| `tests/model-router.test.mjs` | modes, rôles, baux, repli, capacités, refus, journal |
| `tests/context-cache.test.mjs` | couches, versions, handoffs, cache, absences, API |
| `tests/project-model.test.mjs` | registre, garde d'opération, capacités, sessions, handoff, endpoint, sélecteur, relance, retrait sans suppression, et la porte des capacités (liste du serveur, refus hors liste, confirmation `confirm: true` obligatoire — absente, `false` ou d'un autre type — garde, persistance, invariance octet pour octet à chaque refus) |
| `tests/project-git.test.mjs` | Git sur de vrais dépôts et un distant bare : statut, diff, commit des fichiers choisis, push normal et push forcé impossible, fetch, avance rapide, divergence et conflit refusés, racine exacte, dépôt imbriqué et sous-module refusés, garde tenue pendant une opération Git, les combinaisons de capacités (`git` seul pour le local, `git` + `network` pour le distant, `network` seul sans effet), et l'ouverture puis la fermeture du distant par `project.capability.set` |
| `tests/projects-console.test.mjs` | section Projects : injection, barre latérale, panneau, changement, refus de la garde, aucune chaîne interne rendue, zone Git (état, diff, étape, envoi, récupération, refus lisibles), et zone des autorisations (état refusé par défaut, un seul contrôle, confirmation, annulation sans écriture, rechargement de la zone Git) |
| `tests/fake-pocketbase.mjs` | faux PocketBase, filtres et sauvegardes compris |
| `tests/pocketbase-live.mjs` | preuve contre le vrai binaire PocketBase |
| `tests/backup-live.mjs` | sauvegarde, suppression, restauration, vérification |
| `cargo test` | arrêt du groupe de processus, lecture de la ligne de disponibilité, génération du patch |

Un **tour réel avec le modèle** a été exécuté le 12 septembre 2026
(`scripts/acceptance-memory-e2e.mjs`) : une session DeepSeek a appelé
`remember`, puis `recall`, puis `forget`, et la preuve a été lue à trois
endroits indépendants — journal de session, base PocketBase, et résultat
d'outil reçu par le modèle.

## 7. Limites connues

- **Pas d'éditeur de fichiers.** L'arbre de droite et l'aperçu du moteur sont
  en lecture seule. Les capacités et la garde du Project Model préparent un
  futur éditeur ; il n'existe pas.
- **Sélection de projet, avec des limites assumées.** La section Projects
  existe et le dernier projet choisi est repris au lancement suivant. En
  revanche : le moteur garde son dossier tant qu'il tourne (un processus, un
  dossier de travail, une base mémoire), le bouton de redémarrage n'apparaît
  que si NewPi tourne depuis un `.app`, et la section n'ouvre pas la dernière
  session d'un projet dans le moteur — elle en affiche seulement la date. Une
  section injectée n'a aucune couture vers la navigation du client ; il
  faudrait un vrai plugin client.
- **Un lancement, un projet, un processus.** Les outils mémoire et les
  consoles sont globaux au processus ; changer de projet veut dire relancer
  NewPi dans un autre dossier. Multi-racine hors périmètre V1.
- **Une seule fenêtre et un seul runtime** par instance (rien n'empêche deux
  copies, chacune avec son port).
- **Mémoire v1** : recherche textuelle seulement, pas de mise à jour en place,
  pas de déduplication, cloisonnement par chaîne (pas par utilisateur), une
  seule machine, sidecar non surveillé, sauvegarde globale à tous les projets,
  la console ne crée pas de souvenir.
- **Storage** : catalogue écrit à la main (une nouvelle cache est invisible
  tant que personne ne l'ajoute) ; mesure bornée (« mesure partielle » est un
  minorant, jamais une estimation) ; la rotation des journaux et la
  conservation des sessions sont des règles affichées, pas des programmes.
- **Git v1, volontairement étroit.** NewPi ne fait que ce que la zone montre :
  lire l'état, montrer un diff, créer un commit local des fichiers choisis,
  `fetch`, `push` normal et `merge --ff-only`. Il ne crée pas de dépôt
  (`git init`), ne configure ni ne modifie aucun remote, ne gère ni les dépôts
  imbriqués ni les sous-modules, ne fait ni fusion, ni rebase, ni changement de
  branche, ni remisage. « GitHub » veut dire *le distant déjà configuré dans le
  dépôt* : c'est Git sur la machine qui s'authentifie (SSH, trousseau, Git
  Credential Manager), et NewPi ne stocke aucun identifiant. Une divergence,
  un conflit ou une opération en cours s'arrêtent avec une phrase et
  l'action humaine à faire ; rien n'est jamais forcé. La détection d'un dépôt
  imbriqué est bornée (profondeur 6, 20 000 entrées, dossiers de dépendances
  ignorés) : c'est une limite de la vérification, pas une promesse.
  **Double autorisation** : `git` suffit au travail local, mais `fetch`, `push`
  et la mise à jour exigent aussi `network`. Comme `network` est désactivée par
  défaut, un projet livré tel quel ne voit que le local ; la section Projets
  permet désormais de l'accorder ou de la retirer, après une confirmation
  explicite, et la zone Git suit le changement immédiatement. Seule `network`
  est modifiable dans cette version : les quatre autres capacités restent
  décidées par le serveur, et la liste elle-même est la sienne.
- **Paquet non signé ni notarié** (signature ad hoc) : Gatekeeper le refusera
  sur une autre machine. `NewPi.app` pèse environ 15 Mo, le `.dmg` environ
  13 Mo ; le moteur installé (279 Mo) n'est pas embarqué.
- **Décision ouverte** : embarquer Node et `dsh` dans
  `Contents/Resources/runtime` (application autonome, paquet d'environ 300 Mo
  à signer et notarier) ou rester léger avec des prérequis. Le point
  d'insertion unique est `RuntimeLocation::resolve` dans
  `src-tauri/src/runtime.rs`.

## 8. Carte des fichiers

| Fichier | Ce qu'il possède |
| --- | --- |
| `src-tauri/src/main.rs` | cycle de vie de l'application |
| `src-tauri/src/runtime.rs` | résolution, lancement et arrêt du runtime |
| `src-tauri/src/memory.rs` | disposition sur disque, portée du projet, lignes du patch |
| `src-tauri/src/models.rs` | lecture et validation du plan de routage |
| `src-tauri/src/pocketbase.rs` | provisionnement, démarrage et vérification du sidecar |
| `src-tauri/src/patch.rs` | génération du patch de lancement |
| `src-tauri/src/assets.rs` | plugins et migration embarqués dans le binaire |
| `src-tauri/src/process.rs` | groupes de processus et arrêt propre |
| `plugins/newpi-brand/index.js` | nom et marque dans l'interface |
| `plugins/pocketbase-memory/` | service mémoire : `client.js`, `core.js`, `environment.js` |
| `plugins/memory-tools/` | les trois outils : `tools.js` |
| `plugins/memory-console/` | sections Memory et Backup : `ui.js`, `backup.js`, `platform.js` |
| `plugins/storage-console/` | section Storage : `catalog.js`, `scan.js`, `cleanup.js`, `ui.js` |
| `plugins/model-router/` | politique de routage : `plan.js`, `routing.js`, `index.js` |
| `plugins/context-cache-manager/` | couches et cache : `context.js`, `cache.js`, `index.js` |
| `plugins/project-model/` | projet, registre et Git : `model.js`, `store.js`, `git.js`, `platform.js`, `index.js` |
| `plugins/projects-console/` | section Projects et sa zone Historique Git : `ui.js`, `index.js` |
| `ui/index.html` | écran de démarrage local |
| `pb_migrations/` | migrations PocketBase versionnées |
| `docs/storage-audit.md` | l'audit disque : inventaire, causes, rétention |
| `docs/features.md` | ce document |
