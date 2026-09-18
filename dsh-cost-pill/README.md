# dsh-cost-pill

Affiche de l'**argent** dans l'interface web de DSH : une pastille de coût dans
le composeur, une ligne « coût estimé » par réponse, et **le coût total de chaque
projet à côté de son nom dans la barre latérale**.

DSH mesure les tokens mais ne transporte aucun tarif. Ce dossier apporte la seule
chose qui manquait : une **projection de session `cost` côté hôte** (source unique
de vérité), plus deux patchs de rendu qui l'affichent.

## Architecture

```
prices.json ──► host-plugin (projection `cost`) ──► cache de projections ──► liste de sessions
                        │                                                      │
                        │ view = { currency, rates, models, total, buckets, routes }
                        ▼                                                      ▼
              pastille du composeur + ligne par tour            badge coût par projet (sidebar)
```

- **Le calcul et les tarifs vivent sur l'hôte.** Le plugin enregistre une
  projection de session `cost` qui replie chaque `assistant/message` facturé en
  buckets par route et les valorise avec `prices.json`.
- **Les bundles clients ne contiennent aucune table de prix.** Ils lisent la
  projection (`useProjection("cost")`, `entry.projectionValues.cost`) et se
  contentent de formater. Un tarif modifié ne demande donc aucune réécriture de
  code : c'est le `view` du plugin qui change.
- **Projection absente = aucun argent affiché** (et non un chiffre faux) : c'est
  la sémantique « capability absent » de DSH.

## Fichiers

| fichier | rôle |
| --- | --- |
| `host-plugin/` | le plugin hôte : la projection `cost` (fold + view) |
| `install-host-plugin.mjs` | déploie le plugin dans le profil web (copie, lien, dépendance, ligne de patch) |
| `prices.json` | **la** table de tarifs (USD par million de tokens, par route) |
| `apply-cost-pill.mjs` | patche les bundles `dsh-client-ui-chat` et `dsh-client-ui-workspace` |
| `verify-host-plugin.mjs` | 8 contrôles sur la projection (fold, fork, schémas, logs réels) |
| `verify-cost-pill.mjs` | 13 contrôles sur les deux rendus clients |
| `audit-usage.mjs` | recoupe les logs locaux avec le tableau de bord DeepSeek |
| `audit-cache.mjs` | mesure le gestionnaire de contexte/cache |
| `session-logs.mjs`, `pricing.mjs` | lecture des logs (zstd multi-frames) et formule monétaire partagées |

## Installation

```sh
node install-host-plugin.mjs      # 1. la projection (le profil la recharge en live)
node apply-cost-pill.mjs          # 2. les deux rendus clients
node verify-host-plugin.mjs       # 3. 8 + 13 contrôles
node verify-cost-pill.mjs
```

Puis recharge la page du GUI. Le plugin est surveillé : `dsh web` en cours
recharge `cordis.patch.yml` tout seul, aucun redémarrage nécessaire pour l'hôte ;
les bundles clients sont re-hachés par le HMR (un simple refresh suffit, sinon
relance `dsh web`).

Autres commandes : `install-host-plugin.mjs --check|--remove`,
`apply-cost-pill.mjs --dry-run|--revert`.

## Ce que ça affiche

| endroit | affichage |
| --- | --- |
| Pastille du composeur (après « Token usage ») | `≈ $0.0123` ; au clic : route facturée, tarifs par million, puis la répartition **relectures cache / entrée nouvelle / sortie** |
| Dialogue « Turn usage » de chaque réponse | une ligne **Est. cost** valorisée avec les tarifs de l'hôte |
| Ligne de projet (sidebar) | `$8.16` juste après le nom du projet, `≈` quand le total est incomplet |

## Périmètre du total d'un projet

- **Toutes les sessions du workspace**, y compris les sous-agents `spawn` (ils
  dépensent dans le même projet et sont seulement masqués de la liste visible).
- **Archivées exclues**, comme partout ailleurs dans l'UI.
- Un enfant `fork` **n'est pas compté deux fois** : la projection ignore les
  événements du préfixe hérité (`seq < inheritedEventCount`), déjà facturés dans
  la session parente.
- Une session dont la ligne `cost` manque encore (jamais repliée depuis le montage
  du plugin) est valorisée depuis sa projection `tokenUsage` avec les tarifs de
  l'hôte, et le total passe en `≈`. L'hôte écrit un point de contrôle `cost` à
  chaque `turn/end`, donc les totaux se complètent d'eux-mêmes.

## Changer les tarifs

1. édite `prices.json` ;
2. recharge le plugin : `touch ~/.dsh/profiles/web/cordis.patch.yml` (le profil
   surveille ce fichier) ou relance `dsh web` ;
3. recharge la page.

Aucun bundle n'est à re-patcher : c'est tout l'intérêt de la projection.

## Calibration sur la facture réelle

`node audit-usage.mjs` recoupe le tableau de bord DeepSeek avec **tous** les logs
de session locaux et en déduit le tarif effectif :

```
node audit-usage.mjs
node audit-usage.mjs --spent 8.06 --requests 5869 --tokens 1267739345
```

Mesure du 2026-09-18 (dashboard $8.06 / 5 869 requêtes / 1 267 739 345 tokens,
recoupé à 100 % du volume sur 39 logs) : **99,4 % des tokens sont des cache-hits**,
et le tarif effectif vaut **0,208×** la grille publique utilisée comme
placeholder.

| bucket | tokens | tarif effectif | coût |
| --- | --- | --- | --- |
| cache-hit (entrée relue) | 1 255 M (99,4 % du prompt) | $0.0058 / M | ~$7.30 |
| cache-miss (entrée nouvelle) | 6,98 M | $0.0581 / M | ~$0.41 |
| output (+ raisonnement) | 4,09 M | $0.0872 / M | ~$0.36 |

## Gestionnaire de contexte et de cache

La composition DSH monte un vrai gestionnaire, et c'est lui qui explique le taux
de cache-hit (`node audit-cache.mjs`) :

- **Mesure** — `dsh-token-meter` expose `contextPressure`, `contextBreakdown`
  (système / outils / messages) et `tokenUsage`.
- **Condensation** — `dsh-compaction-basic` : seuil à **80 %** de la fenêtre,
  **16 %** récents verbatim, reprise après dépassement, `/compact`.
- **Élagage** — `dsh-compaction-tool-result-pruner` (8192 car., tête 4096 /
  queue 1024) et `dsh-spill-policy` (50 000 octets inline max).
- **Cache** — surface visible **append-only** : 12 653 appends contre 4 replaces
  mesurés en 9 jours, catalogue d'outils stable d'un mode à l'autre, prompt
  système mis à jour *in-history*, `subagent_fork` qui hérite du préfixe du
  parent. Seul un `replace` invalide la réutilisation à partir du premier token
  changé.

Contrefactuel mesuré : les 1,26 milliard de tokens relus coûtent **$7.68** au
tarif cache-hit contre **$73.67** au tarif cache-miss — le gestionnaire divise
cette part par **9,6×**.

## Limites assumées

- **Le fold compte les messages assistant réglés** (`assistant/message`), pas les
  échantillons transitoires `assistant/attempt` : c'est la méthode qui a réconcilié
  la facture à 100 %, et un échantillon d'essai n'est pas une tentative facturée
  distincte. Le total peut donc différer très légèrement du compteur de tokens de
  DSH, qui garde ces échantillons.
- La vue d'une projection est calculée au moment de la lecture : un changement de
  tarif n'apparaît qu'après rechargement du plugin, sans re-fold des logs.
- Une mise à jour de DSH remplace les bundles clients : relance
  `node apply-cost-pill.mjs` (le plugin hôte, lui, vit dans le profil et survit).
- Les entrées `deepseek-v4-pro` / `vision-exp` de `prices.json` sont marquées
  `_source: NON MESURÉ` : ce sont des copies, pas des mesures.
