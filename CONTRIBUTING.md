# Contribuer à NewPi

Merci de l'intérêt porté au projet. Ce document dit comment travailler dans ce
dépôt sans casser ce qu'il garantit. Il est court exprès : les règles qui
comptent sont peu nombreuses, et elles sont vérifiables.

`AGENTS.md` est la carte du dépôt — où vit quoi, et quelle commande prouve quoi.
Lisez-le d'abord ; ce fichier-ci ne le remplace pas.

## Prérequis

| Outil | Version | Pourquoi |
| --- | --- | --- |
| Node.js | 20 ou plus | Les tests, les scripts, et le harness que NewPi lance |
| pnpm | 9 ou plus | La CLI Tauri et l'installation des dépendances |
| Rust | 1.77 ou plus | L'hôte Tauri (`rustup` fournit la chaîne) |
| Xcode Command Line Tools | à jour | L'éditeur de liens macOS |
| DeepSeek Harness (`dsh`) | installé globalement | Nécessaire pour **lancer** l'application, pas pour les tests |

## Mise en route

```sh
pnpm install     # la CLI Tauri, plus les modules du harness copiés pour les tests
pnpm dev         # l'application, avec rechargement du Rust ; la première compilation prend des minutes
pnpm build:app   # produit seulement le .app — à préférer pendant l'itération
```

Si `pnpm install` échoue sur
`EPERM: operation not permitted, chmod .../@deepseek-ai/cordis/bin.js`, le
`node_modules` date d'une version où ces modules étaient des liens qui sortaient
du projet : `rm -rf node_modules/@deepseek-ai && pnpm install` suffit, une fois.

## Le portail de tests

```sh
pnpm test
```

Cette commande exécute `cargo test`, puis `node --test tests/*.test.mjs`. **Ne
lancez pas `node --test` seul** : la suite Rust écrit
`src-tauri/target/test-tmp/launcher-sample.patch.yml`, et plusieurs suites
JavaScript lisent ce fichier. Sans `pnpm test`, ces assertions sont sautées en
silence.

À côté de cette porte, le dépôt a des **sondes de vérification** : elles pilotent
l'application réelle au lieu de simuler son comportement. Elles ne sont pas
nécessaires pour une contribution ordinaire, mais une modification d'interface
ou de mémoire mérite la sonde correspondante.

| Commande | Ce qu'elle exige |
| --- | --- |
| `pnpm test:pocketbase`, `pnpm test:backup` | le binaire PocketBase épinglé, aucune application en marche |
| `pnpm verify:running` | une instance NewPi déjà lancée |
| `pnpm verify:console` | l'URL que NewPi imprime au lancement, jeton compris |
| `pnpm verify:projects`, `:git`, `:capability`, `pnpm verify:scope` | Google Chrome ; elles montent leur propre harness |

Les quatre dernières pilotent `/Applications/Google Chrome.app` par son propre
socket DevTools : il n'y a pas de Playwright à installer.

## Conventions

- **Le code, les commentaires, la JSDoc et les doc-comments Rust sont en
  anglais.** Le README, `docs/` et tout ce qu'un utilisateur lit à l'écran sont
  en français.
- **Pas de point-virgule** en JavaScript.
- **Chaque module s'ouvre sur un commentaire d'en-tête** qui dit ce qu'il
  possède et ce qu'il ne fait délibérément pas.
- **Un commentaire explique une décision, jamais un mécanisme.** Si une ligne
  est assez subtile pour mériter un commentaire, dites pourquoi l'alternative
  évidente est fausse.
- **La configuration est une donnée, pas du code** : la ligne d'un plugin voyage
  dans le patch de lancement, et aucun secret n'en fait partie.
- Le style Rust est épinglé par `src-tauri/rustfmt.toml` ; la CI exécute
  `cargo fmt --check` et `cargo clippy -- -D warnings`. Un avertissement fait
  échouer la construction, exprès.

## Les invariants à ne pas casser

Ces quatre règles ne sont pas des préférences de style : elles sont la raison
d'être du cloisonnement entre le moteur et l'interface. Une modification qui en
casse une sera refusée, même si elle fonctionne.

1. **La page ne reçoit aucun secret.** L'URL et le mot de passe du sidecar
   mémoire atteignent le harness par l'environnement (`DSH_MEMORY_URL`,
   `DSH_MEMORY_PASSWORD`) ; la console ne lit aucune variable d'environnement.
   Tout ce qui mettrait l'un ou l'autre sur la page est un bug, pas un
   raccourci.
2. **La page ne peut pas nommer un projet.** Un `project_id` envoyé par la page
   est refusé ; c'est le serveur qui décide de la portée.
3. **Rien ne s'écrit hors de la racine du projet ouvert.** Les chemins sont
   résolus puis vérifiés avant tout accès, y compris contre un lien symbolique
   qui sortirait de l'arborescence.
4. **Une confirmation vient du bouton.** `confirm: true` est joint par le clic,
   et le modèle le revérifie ; il ne se déduit jamais d'un texte de la page.

## Proposer une modification

1. **Ouvrez une issue d'abord** pour décrire le problème ou l'idée. Cela évite
   d'écrire du code qui ne sera pas repris, et garde l'historique lisible.
2. Travaillez sur une branche, un commit par intention, avec un message à
   l'impératif en anglais, comme l'historique existant.
3. Vérifiez que `pnpm test` passe. La CI rejoue exactement cette commande, plus
   `rustfmt` et `clippy`.
4. **Si votre changement rend une affirmation fausse**, mettez-la à jour dans le
   même commit : le README et `docs/` décrivent ce qui a été *vérifié*, pas ce
   qui a été tenté. Un chiffre mesuré qui ne l'est plus est un bug de
   documentation.
5. N'ajoutez pas de secret, de jeton ni de chemin personnel dans un fichier
   suivi — y compris dans les exemples et les fixtures de test, qui doivent
   utiliser des chemins neutres (`/Users/x/...`, `example.invalid`).

Ouvrez ensuite une *pull request* qui explique le **pourquoi** ; le **quoi** est
dans le diff.

## Signaler un problème

Une *issue* suffit pour un bug ordinaire. Pour une faille de sécurité, **n'ouvrez
pas d'issue publique** : suivez `SECURITY.md`, qui décrit le canal privé et le
périmètre.

## Licence des contributions

En proposant une modification, vous acceptez qu'elle soit distribuée sous la
licence MIT du projet (voir `LICENSE`). Vous devez avoir le droit de la
soumettre.
