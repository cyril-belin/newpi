# Politique de sécurité

NewPi est une application locale qui lance un moteur détenteur d'un jeton
d'accès, exécute des commandes dans un dossier de projet et écrit dans une base
de mémoire. La façon dont ces accès circulent est une propriété du produit, pas
un détail d'implémentation.

## Signaler une faille

**N'ouvrez pas d'issue publique pour une faille de sécurité.** Utilisez le
signalement privé de GitHub :

<https://github.com/cyril-belin/newpi/security/advisories/new>

Un rapport utile contient :

- la version de NewPi, la version de macOS et l'architecture ;
- la version du harness (`dsh --version`) et de Node ;
- les étapes exactes de reproduction, ou un test qui échoue ;
- ce qui est atteignable par un attaquant, et ce qui ne l'est pas ;
- si le problème vient de NewPi ou du moteur — dans le doute, signalez-le quand
  même.

Ce dépôt est maintenu sur le temps libre : il n'y a ni prime, ni engagement de
délai. Une réponse arrive en général sous quelques jours, et le rapport est
traité avant d'être rendu public.

## Versions couvertes

La branche `main` et la dernière version marquée. NewPi est en `0.1.0` : il n'y
a pas encore de version distribuée signée, donc pas de correctif rétroporté.

## Ce qui serait une vulnérabilité

Par ordre de gravité, ce que ce dépôt considère comme un défaut de sécurité :

1. **Un secret qui atteint la page.** L'URL ou le mot de passe du sidecar
   mémoire (`DSH_MEMORY_URL`, `DSH_MEMORY_PASSWORD`) rendu lisible par
   l'interface, le DOM, le stockage local, un journal persistant ou le patch de
   lancement. Le harness doit les recevoir par l'environnement ; la console ne
   lit aucune variable d'environnement.
2. **Un contournement du cloisonnement entre projets.** Une façon de faire
   écrire ou lire la mémoire sous un autre `project_id` que celui du projet
   ouvert — notamment un `project_id` accepté depuis la page, alors que la page
   n'a pas le droit d'en nommer un.
3. **Une écriture ou une lecture hors de la racine du projet ouvert.** Y
   compris par un chemin relatif qui remonte, une racine symbolique, un lien
   symbolique ou une course entre la vérification et l'accès.
4. **Un accès à la mémoire, aux instantanés ou aux sauvegardes par le
   nettoyage.** Les cibles de la section Storage sont refusées avant toute
   résolution de chemin si elles touchent la base ou les sauvegardes.
5. **Une commande exécutée sans confirmation, ou hors du projet ouvert.**
   `confirm: true` est joint par le bouton de confirmation et revérifié côté
   serveur ; il ne se déduit jamais du texte d'une page.
6. **Un accès à l'API Tauri depuis la page distante.** La page servie par le
   moteur ne doit disposer d'aucune prise sur les commandes de l'hôte.

## Ce qui n'est pas une vulnérabilité

- **Le serveur du moteur écoute en boucle locale** (`127.0.0.1`) et échange un
  jeton de lancement contre un cookie signé. C'est le mécanisme du harness, et
  NewPi ne le modifie pas. Le jeton est imprimé en clair au lancement : c'est
  voulu, puisqu'il sert à ouvrir la fenêtre.
- **L'absence de bac à sable macOS.** NewPi n'est pas sandboxé : un utilisateur
  qui contrôle déjà votre compte macOS peut lire `Application Support` et
  lancer les mêmes commandes que le terminal. Ce n'est pas une frontière que le
  projet prétend tenir.
- **L'absence de signature et de notarisation** d'un paquet que vous avez
  compilé vous-même. C'est une limite de distribution assumée, documentée dans
  le README, pas une faille.
- **Le harness lui-même et PocketBase.** Ces deux projets sont installés ou
  épinglés séparément et gardent leurs propres processus de sécurité. Un défaut
  qui leur est propre doit être signalé en amont, même si NewPi le rend
  visible.

## Ce que le projet vérifie déjà

Les invariants ci-dessus ne sont pas seulement écrits : `pnpm test` les couvre
pour une bonne part, et les sondes `pnpm verify:*` les rejouent sur
l'application réelle — par exemple, la sonde de la console vérifie que le DOM
rendu ne contient ni mot de passe, ni identifiant, ni nom de variable
d'environnement, ni adresse du sidecar. Une contribution qui touche ces
garanties doit ajouter ou ajuster la preuve correspondante.
