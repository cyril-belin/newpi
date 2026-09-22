/**
 * What NewPi is allowed to look at, what each place is for, and what may be
 * removed without asking anyone.
 *
 * This file is the *policy*. The scan measures, the cleanup deletes, the view
 * renders — and every one of them reads its rules from here. That is deliberate:
 * a target's safety class and its deletion strategy live in one table that a
 * test reads back, rather than in a branch somewhere in the request handler.
 *
 * # The two safety classes
 *
 * - **`safe`** — the contents are a *derived* artefact: a compiler output, a
 *   package cache, a browser download. Removing them costs time and bandwidth,
 *   never information. These are the only targets the Storage view can remove.
 * - **`guarded`** — the contents are *the user's*: a conversation, a memory
 *   row, a backup archive, a simulator's app data, an application's state.
 *   There is no code path from the Storage endpoint to a guarded target's
 *   files. Not a confirmation, not a flag, not a hidden action: the cleanup
 *   refuses the id before it resolves a path. Deleting these stays where it
 *   belongs — the Memory section's per-memory confirmation, the Backup
 *   section's restore confirmation, or the user's own command line.
 *
 * The reason for that asymmetry is that "are you sure?" is a poor fence. A
 * dialog is one keystroke deep and it teaches the user to click through; a
 * missing code path cannot be clicked through at all.
 *
 * @module newpi-plugin-storage-console/catalog
 */

/** One mebibyte, the unit the budgets below are written in. */
const MIB = 1024 * 1024;
/** One gibibyte. */
const GIB = 1024 * MIB;

/** Targets that exist only below an open project's root. */
const PROJECT_TARGET_IDS = new Set([
  'newpi-target',
  'newpi-node-modules',
  'newpi-pnpm-store',
]);

/** The role a directory plays, which decides how it is read and rotated. */
export const ROLES = Object.freeze({
  build: 'build',
  cache: 'cache',
  logs: 'logs',
  sessions: 'sessions',
  memory: 'memory',
  backups: 'backups',
  runtime: 'runtime',
  data: 'data',
});

/** The two safety classes. */
export const SAFE = 'safe';
export const GUARDED = 'guarded';

/** How a safe target is removed. */
export const CLEANUP = Object.freeze({
  /** Delete the directory itself; its owner recreates it on next use. */
  directory: 'remove-directory',
  /** Delete the children, keep the directory. */
  contents: 'clear-contents',
});

/**
 * The retention policy, in one table.
 *
 * Nothing here deletes anything: the policy says what is *allowed* to be
 * removed automatically by the tool that owns the data, and what a person is
 * expected to decide. The Storage view renders it, so the rule is visible in
 * the same place as the figure it applies to.
 *
 * - Builds and caches: no automatic deletion at all. They are removed when a
 *   person asks, and only when they exceed their budget does the view say so.
 * - Logs: the one class that may be rotated without asking, because a log is a
 *   record of something that already happened and a truncated log loses no
 *   state. Kept for a week.
 * - Sessions: kept 30 days, with the last 50 sessions of every project always
 *   retained. Never rotated by NewPi: a conversation is the user's.
 * - Memory and backups: never automatic, under any age or size. A memory row
 *   and a backup archive are the two things this application exists to keep.
 */
export const RETENTION_POLICY = Object.freeze({
  [ROLES.build]: {
    automatic: 'none',
    keepDays: null,
    budgetBytes: 8 * GIB,
    note: 'Sortie de compilation : reconstructible par la commande qui l\'a produite. Jamais supprimée sans demande.',
  },
  [ROLES.cache]: {
    automatic: 'none',
    keepDays: null,
    budgetBytes: 12 * GIB,
    note: 'Cache : reconstructible par téléchargement ou recalcul. Jamais supprimé sans demande.',
  },
  [ROLES.logs]: {
    automatic: 'rotate',
    keepDays: 7,
    budgetBytes: 50 * MIB,
    note: 'Journal : rotation autorisée sans demande au delà de la durée ou du volume.',
  },
  [ROLES.sessions]: {
    automatic: 'never',
    keepDays: 30,
    minPerProject: 50,
    budgetBytes: null,
    note: 'Sessions : conservées 30 jours, les 50 dernières de chaque projet toujours gardées. Aucune rotation automatique par NewPi.',
  },
  [ROLES.memory]: {
    automatic: 'never',
    keepDays: null,
    budgetBytes: null,
    note: 'Mémoire PocketBase : jamais supprimée automatiquement. Uniquement par la section Memory, souvenir par souvenir, après confirmation.',
  },
  [ROLES.backups]: {
    automatic: 'never',
    keepDays: null,
    budgetBytes: null,
    note: 'Sauvegardes : jamais supprimées, ni par NewPi ni par le sidecar. Les instantanés transitoires de PocketBase sont élagués par PocketBase lui même.',
  },
  [ROLES.runtime]: {
    automatic: 'never',
    keepDays: null,
    budgetBytes: null,
    note: 'État applicatif : binaire, identifiants, greffons. Supprimer casse le démarrage.',
  },
  [ROLES.data]: {
    automatic: 'never',
    keepDays: null,
    budgetBytes: null,
    note: 'Données utilisateur : hors du périmètre de NewPi.',
  },
});

/**
 * Join a base directory with a relative path, without normalising it away.
 *
 * @param base - the base directory.
 * @param parts - the relative segments.
 * @returns the joined path.
 */
function under(base, ...parts) {
  if (typeof base !== 'string' || base.length === 0) return null;
  return [base.replace(/\/+$/, ''), ...parts].join('/');
}

/**
 * The whole catalog for one launch.
 *
 * Every path is computed from the roots NewPi already resolved, so the view
 * measures the machine it is actually running on rather than a hardcoded
 * guess. The three project-only targets are omitted when no project is open:
 * showing an unnamed build target with no root would imply a project that does
 * not exist. Other absent paths stay reported as `null`, because they are
 * still machine-level facts.
 *
 * @param roots - the resolved roots.
 * @param roots.home - the user's home directory.
 * @param roots.workspace - the project directory the harness runs in.
 * @param roots.state - NewPi's application state directory.
 * @param roots.dshHome - the harness home (`$DSH_HOME`, normally `~/.dsh`).
 * @param roots.data - the PocketBase data directory.
 * @param roots.snapshots - the sidecar's own snapshot directory.
 * @param roots.backups - the directory NewPi writes user backups to.
 * @returns the entries, grouped by scope in display order.
 */
export function buildCatalog(roots) {
  const { home, workspace, state, dshHome, data, snapshots, backups } = roots;

  /** @type {Array<object>} */
  const entries = [
    // ------------------------------------------------------------- NewPi
    {
      id: 'newpi-target',
      label: 'Build Rust du projet',
      scope: 'newpi',
      role: ROLES.build,
      safety: SAFE,
      cleanup: CLEANUP.directory,
      path: under(workspace, 'src-tauri/target'),
      what: 'Cargo : dépendances compilées, binaires de développement et de release, images disque.',
      cost: 'Une recompilation complète (quelques minutes, sans réseau : le registre cargo est ailleurs).',
    },
    {
      id: 'newpi-node-modules',
      label: 'Modules Node du projet',
      scope: 'newpi',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.directory,
      path: under(workspace, 'node_modules'),
      what: 'Dépendances installées par pnpm pour la CLI Tauri.',
      cost: 'Un `pnpm install` (téléchargement depuis le registre npm).',
      budgetBytes: 1 * GIB,
    },
    {
      id: 'newpi-pnpm-store',
      label: 'Magasin pnpm du projet',
      scope: 'newpi',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.directory,
      path: under(workspace, '.pnpm-store'),
      what: 'Copies en dur des paquets déjà installés dans ce projet.',
      cost: 'Un `pnpm install` les reconstitue.',
    },
    {
      id: 'newpi-state',
      label: 'État de l\'application',
      scope: 'newpi',
      role: ROLES.runtime,
      safety: GUARDED,
      cleanup: null,
      path: under(state),
      what: 'Greffons déployés, identifiants du sidecar, patch de lancement, base mémoire et sauvegardes.',
      cost: 'Rien à nettoyer ici : les lignes filles ci-dessous détaillent ce qui est reconstructible et ce qui ne l\'est pas.',
      overlaps: ['newpi-pb-data', 'newpi-pb-snapshots', 'newpi-backups', 'newpi-plugins', 'newpi-app-cache'],
    },
    {
      id: 'newpi-plugins',
      label: 'Greffons déployés',
      scope: 'newpi',
      role: ROLES.runtime,
      safety: GUARDED,
      cleanup: null,
      path: under(state, 'plugins'),
      what: 'Les greffons extraits du binaire à chaque lancement.',
      cost: 'Réécrits au prochain démarrage, mais leur suppression pendant que le moteur tourne casse la session en cours.',
    },
    {
      id: 'newpi-pb-data',
      label: 'Mémoire PocketBase',
      scope: 'newpi',
      role: ROLES.memory,
      safety: GUARDED,
      cleanup: null,
      path: under(data),
      what: 'La base `memories` : les souvenirs de tous les projets, cloisonnés par `project_id`.',
      cost: 'DÉFINITIF. Une mémoire supprimée ne se reconstitue pas. Passez par la section Memory, qui confirme chaque suppression.',
    },
    {
      id: 'newpi-pb-snapshots',
      label: 'Instantanés transitoires du sidecar',
      scope: 'newpi',
      role: ROLES.backups,
      safety: GUARDED,
      cleanup: null,
      path: under(snapshots),
      what: 'Les instantanés que PocketBase prend lui même avant une opération. Ce ne sont PAS vos sauvegardes.',
      cost: 'PocketBase élague ce dossier lui même. NewPi n\'y touche jamais : le dossier des sauvegardes est un frère, pas un enfant, précisément pour qu\'aucune sauvegarde demandée ne disparaisse avec un instantané.',
    },
    {
      id: 'newpi-backups',
      label: 'Sauvegardes de l\'utilisateur',
      scope: 'newpi',
      role: ROLES.backups,
      safety: GUARDED,
      cleanup: null,
      path: under(backups),
      what: 'Les archives ZIP que vous avez demandées, avec leur manifeste.',
      cost: 'JAMAIS supprimées par NewPi. La section Backup les liste et les restaure ; elle ne les efface pas.',
    },
    {
      id: 'newpi-app-cache',
      label: 'Cache WebKit de NewPi',
      scope: 'newpi',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.directory,
      path: under(home, 'Library/Caches/io.newpi.desktop'),
      what: 'Ressources de la page servie par le moteur, mises en cache par la WebView.',
      cost: 'La première page suivante se recharge depuis le moteur local.',
      budgetBytes: 256 * MIB,
    },
    {
      id: 'newpi-webkit',
      label: 'Stockage WebKit de NewPi',
      scope: 'newpi',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.directory,
      path: under(home, 'Library/WebKit/io.newpi.desktop'),
      what: 'Stockage local et IndexedDB de l\'interface (préférences d\'affichage).',
      cost: 'L\'interface repart de ses réglages par défaut.',
      budgetBytes: 256 * MIB,
    },

    // --------------------------------------------------------------- DSH
    {
      id: 'dsh-sessions',
      label: 'Sessions du moteur',
      scope: 'dsh',
      role: ROLES.sessions,
      safety: GUARDED,
      cleanup: null,
      path: under(dshHome, 'sessions'),
      what: 'L\'historique compressé de chaque conversation, un dossier par projet.',
      cost: 'DÉFINITIF. Une session supprimée ne se rejoue pas. NewPi ne les touche pas : la rotation décrite par la politique est une règle, pas un programme.',
      retention: RETENTION_POLICY[ROLES.sessions],
    },
    {
      id: 'dsh-attachments',
      label: 'Pièces jointes des sessions',
      scope: 'dsh',
      role: ROLES.sessions,
      safety: GUARDED,
      cleanup: null,
      path: under(dshHome, 'attachments'),
      what: 'Les fichiers joint aux conversations, conservés par contenu.',
      cost: 'DÉFINITIF. Les messages qui les référencent gardent leur texte, pas leur pièce jointe.',
    },
    {
      id: 'dsh-storages',
      label: 'Caches du moteur',
      scope: 'dsh',
      role: ROLES.runtime,
      safety: GUARDED,
      cleanup: null,
      path: under(dshHome, 'storages'),
      what: 'Caches de projet et index du moteur.',
      cost: 'Reconstruits au besoin, mais ils appartiennent au moteur, pas à NewPi.',
    },
    {
      id: 'dsh-profile-modules',
      label: 'Modules du profil moteur',
      scope: 'dsh',
      role: ROLES.runtime,
      safety: GUARDED,
      cleanup: null,
      path: under(dshHome, 'profiles/node_modules'),
      what: 'L\'arbre de modules que les greffons importent (`@deepseek-ai/cordis`). Les greffons déployés y sont liés par un lien symbolique.',
      cost: 'Sans lui, aucun greffon ne se charge et NewPi démarre sans mémoire.',
    },

    // --------------------------------------------------------- Outillage
    {
      id: 'cargo-registry',
      label: 'Registre cargo',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, '.cargo/registry'),
      what: 'Sources et archives de toutes les caisses Rust déjà téléchargées.',
      cost: 'Le prochain `cargo build` les retélécharge. Les versions épinglées de `Cargo.lock` ne changent pas pour autant.',
      budgetBytes: 4 * GIB,
    },
    {
      id: 'rustup-toolchains',
      label: 'Chaînes d\'outils rustup',
      scope: 'toolchain',
      role: ROLES.runtime,
      safety: GUARDED,
      cleanup: null,
      path: under(home, '.rustup/toolchains'),
      what: 'Les compilateurs Rust installés.',
      cost: 'Réinstallables par `rustup toolchain install`, mais supprimer la chaîne active arrête toute compilation jusqu\'au retéléchargement.',
    },
    {
      id: 'npm-cacache',
      label: 'Cache npm',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, '.npm/_cacache'),
      what: 'Toutes les archives de paquets npm déjà téléchargées, tous projets confondus.',
      cost: 'Un `npm install` les retélécharge. Aucun fichier de projet n\'est touché.',
      budgetBytes: 4 * GIB,
    },
    {
      id: 'npm-npx',
      label: 'Environnements npx',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, '.npm/_npx'),
      what: 'Un dossier par paquet lancé avec `npx`, installé puis oublié.',
      cost: 'Le prochain `npx` réinstalle le paquet.',
      budgetBytes: 1 * GIB,
    },
    {
      id: 'npm-logs',
      label: 'Journaux npm',
      scope: 'toolchain',
      role: ROLES.logs,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, '.npm/_logs'),
      what: 'Journaux de débogage npm.',
      cost: 'Perdre l\'historique d\'une installation ratée.',
      budgetBytes: RETENTION_POLICY[ROLES.logs].budgetBytes,
    },
    {
      id: 'pnpm-home',
      label: 'Magasin pnpm global',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, 'Library/pnpm'),
      what: 'Le magasin de contenu partagé entre tous les projets pnpm.',
      cost: 'Chaque projet retélécharge ce qu\'il lui faut.',
      budgetBytes: 2 * GIB,
    },
    {
      id: 'pnpm-cache',
      label: 'Cache pnpm',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, 'Library/Caches/pnpm'),
      what: 'Métadonnées et archives du registre npm vues par pnpm.',
      cost: 'Retéléchargées au besoin.',
    },
    {
      id: 'homebrew-cache',
      label: 'Cache Homebrew',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, 'Library/Caches/Homebrew'),
      what: 'Téléchargements de formules et de bouteilles.',
      cost: '`brew` retélécharge ce qu\'il doit réinstaller.',
      budgetBytes: 1 * GIB,
    },
    {
      id: 'node-gyp-cache',
      label: 'Cache node-gyp',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, 'Library/Caches/node-gyp'),
      what: 'En-têtes Node téléchargés pour compiler des modules natifs.',
      cost: 'Retéléchargés à la prochaine compilation native.',
      budgetBytes: 512 * MIB,
    },
    {
      id: 'playwright-browsers',
      label: 'Navigateurs Playwright',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, 'Library/Caches/ms-playwright'),
      what: 'Les navigateurs que Playwright télécharge pour les tests headless — dont ceux qui pilotent l\'interface NewPi.',
      cost: '`npx playwright install` les retélécharge. Les contrôles `pnpm verify:console` échouent jusque là.',
      budgetBytes: 1 * GIB,
    },
    {
      id: 'playwright-mcp',
      label: 'Navigateurs Playwright MCP',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, 'Library/Caches/ms-playwright-mcp'),
      what: 'Le second jeu de navigateurs, téléchargé par le pont Playwright MCP.',
      cost: 'Retéléchargé à la première utilisation.',
      budgetBytes: 1 * GIB,
    },
    {
      id: 'swiftpm-cache',
      label: 'Cache SwiftPM',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, 'Library/Caches/org.swift.swiftpm'),
      what: 'Dépôts et artefacts résolus par Swift Package Manager.',
      cost: 'Résolus de nouveau au prochain build Xcode.',
      budgetBytes: 1 * GIB,
    },
    {
      id: 'user-cache',
      label: 'Cache utilisateur (~/.cache)',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, '.cache'),
      what: 'Caches d\'outils en ligne de commande : runtimes Codex, uv, fontconfig.',
      cost: 'Chaque outil retélécharge ou recalcule le sien.',
      budgetBytes: 2 * GIB,
    },
    {
      id: 'xcode-derived-data',
      label: 'Xcode DerivedData',
      scope: 'toolchain',
      role: ROLES.build,
      safety: SAFE,
      cleanup: CLEANUP.directory,
      path: under(home, 'Library/Developer/Xcode/DerivedData'),
      what: 'Index, modules et binaires intermédiaires de chaque projet Xcode construit sur cette machine.',
      cost: 'Xcode régénère tout au prochain build. Le premier est nettement plus long.',
      budgetBytes: 8 * GIB,
    },
    {
      id: 'xcode-device-support',
      label: 'Symboles des appareils iOS',
      scope: 'toolchain',
      role: ROLES.build,
      safety: SAFE,
      cleanup: CLEANUP.directory,
      path: under(home, 'Library/Developer/Xcode/iOS DeviceSupport'),
      what: 'Une copie des symboles de chaque version d\'iOS vue sur un appareil branché.',
      cost: 'Xcode les recopie au prochain branchement. Le débogage sur un appareil non resynchronisé est dégradé jusque là.',
      budgetBytes: 8 * GIB,
    },
    {
      id: 'gradle-caches',
      label: 'Caches Gradle',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, '.gradle/caches'),
      what: 'Dépendances Java et sorties de build incrémental de Gradle.',
      cost: 'Le prochain build Gradle les retélécharge et les recalcule.',
      budgetBytes: 2 * GIB,
    },
    {
      id: 'pub-cache',
      label: 'Cache Dart/Flutter',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, '.pub-cache'),
      what: 'Paquets Dart téléchargés par pub, partagés entre projets Flutter.',
      cost: '`flutter pub get` les retélécharge.',
      budgetBytes: 2 * GIB,
    },
    {
      id: 'dart-server',
      label: 'Cache du serveur d\'analyse Dart',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, '.dartServer'),
      what: 'Index incrémental du serveur d\'analyse pour l\'IDE.',
      cost: 'Réindexation au prochain démarrage de l\'IDE.',
      budgetBytes: 1 * GIB,
    },
    {
      id: 'microsandbox',
      label: 'Bacs à sable microsandbox',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, '.microsandbox'),
      what: 'Images et instantanés de bacs à sable. Les images sont creuses : la taille allouée est très inférieure à la taille logique.',
      cost: 'Les bacs à sable sont recréés à la demande.',
      budgetBytes: 2 * GIB,
    },
    {
      id: 'tool-updater-caches',
      label: 'Caches de mise à jour des outils',
      scope: 'toolchain',
      role: ROLES.cache,
      safety: SAFE,
      cleanup: CLEANUP.contents,
      path: under(home, 'Library/Caches/dotslash'),
      what: 'Runtime `dotslash` et mises à jour téléchargées par les éditeurs.',
      cost: 'Retéléchargées à la prochaine mise à jour.',
      budgetBytes: 1 * GIB,
    },

    // ----------------------------------------------- Hors périmètre NewPi
    {
      id: 'core-simulator',
      label: 'Appareils du simulateur iOS',
      scope: 'other',
      role: ROLES.data,
      safety: GUARDED,
      cleanup: null,
      path: under(home, 'Library/Developer/CoreSimulator/Devices'),
      what: 'Un dossier par appareil simulé, avec son disque et les données des applications installées.',
      cost: 'Hors du périmètre de NewPi. À supprimer avec `xcrun simctl delete` depuis Xcode, qui sait quels appareils sont inutilisables.',
    },
    {
      id: 'android-avd',
      label: 'Émulateurs Android',
      scope: 'other',
      role: ROLES.data,
      safety: GUARDED,
      cleanup: null,
      path: under(home, '.android/avd'),
      what: 'Images système et instantanés de démarrage des émulateurs.',
      cost: 'Hors du périmètre de NewPi. À supprimer depuis le Device Manager d\'Android Studio.',
    },
  ];

  // Two catalog rows describe a *group* of sibling caches rather than one
  // directory. They are appended with their members listed, so the view can
  // offer each member separately and still say what the family costs.
  entries.push({
    id: 'claude-vm',
    label: 'Machine virtuelle de Claude Desktop',
    scope: 'other',
    role: ROLES.data,
    safety: GUARDED,
    cleanup: null,
    path: under(home, 'Library/Application Support/Claude/vm_bundles'),
    what: 'L\'image de la machine virtuelle que Claude Desktop utilise pour son mode agent local.',
    cost: 'Hors du périmètre de NewPi. Supprimer l\'image désactive le mode agent local jusqu\'à son retéléchargement par l\'application.',
  });
  entries.push({
    id: 'autodesk-webdeploy',
    label: 'Déploiement web Autodesk (Fusion)',
    scope: 'other',
    role: ROLES.data,
    safety: GUARDED,
    cleanup: null,
    path: under(home, 'Library/Application Support/Autodesk/webdeploy'),
    what: 'Les versions de Fusion 360 installées par le déployeur web d\'Autodesk.',
    cost: 'Hors du périmètre de NewPi. À nettoyer depuis le déploiement web d\'Autodesk.',
  });
  entries.push({
    id: 'chrome-profile',
    label: 'Profil Chrome',
    scope: 'other',
    role: ROLES.data,
    safety: GUARDED,
    cleanup: null,
    path: under(home, 'Library/Application Support/Google/Chrome'),
    what: 'Profils, historique et modèles embarqués de Chrome.',
    cost: 'Hors du périmètre de NewPi. Supprimer un profil efface l\'historique et les sessions de ses sites.',
  });

  return workspace === '' ? entries.filter((entry) => !PROJECT_TARGET_IDS.has(entry.id)) : entries;
}

/**
 * The catalog entry with one id, or `null`.
 *
 * @param entries - the catalog.
 * @param id - the requested id.
 * @returns the entry.
 */
export function findEntry(entries, id) {
  return entries.find((entry) => entry.id === id) ?? null;
}

/**
 * Whether an entry may be removed by the Storage view.
 *
 * A target is removable only when it is `safe` *and* declares how to remove
 * it. Both conditions are checked here rather than at the call site, because
 * this is the one function every removal path funnels through.
 *
 * @param entry - the catalog entry.
 * @returns `true` when the entry is a safe, removable target.
 */
export function isRemovable(entry) {
  return (
    entry !== null &&
    entry !== undefined &&
    entry.safety === SAFE &&
    (entry.cleanup === CLEANUP.directory || entry.cleanup === CLEANUP.contents) &&
    typeof entry.path === 'string' &&
    entry.path.length > 0
  );
}

/**
 * The budget one entry is measured against, if it has one of its own.
 *
 * @param entry - the catalog entry.
 * @returns the budget in bytes, or `null`.
 */
export function budgetFor(entry) {
  if (typeof entry.budgetBytes === 'number') return entry.budgetBytes;
  const policy = RETENTION_POLICY[entry.role];
  return policy && typeof policy.budgetBytes === 'number' ? policy.budgetBytes : null;
}
