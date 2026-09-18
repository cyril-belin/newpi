#!/usr/bin/env node
/**
 * `pnpm storage` — the Storage view, without a window.
 *
 * The same catalog, the same measurement, the same cleanup engine the section
 * uses. This exists because the interesting questions about disk usage are
 * asked from a shell ("what is eating my disk", "is it safe to delete this"),
 * and because a cleanup that can only be triggered by a click is a cleanup
 * nobody can audit.
 *
 * Nothing here is automatic: with no arguments it measures and prints. The only
 * way to remove anything is `--clean <id> --confirm <id>`, and an id the
 * catalog marks guarded is refused even then.
 *
 * Roots are resolved the way NewPi resolves them, and every one of them can be
 * pointed elsewhere with a flag — which is what makes an isolated test of the
 * cleanup paths possible without touching the real home directory.
 *
 * @module newpi/scripts/storage
 */

import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildCatalog,
  budgetFor,
  isRemovable,
  RETENTION_POLICY,
  ROLES,
} from '../plugins/storage-console/catalog.js';
import { CleanupError, previewCleanup, runSafeCleanup } from '../plugins/storage-console/cleanup.js';
import { DEFAULT_LIMITS, measureTree } from '../plugins/storage-console/scan.js';

/** The scopes, in display order. */
const SCOPES = ['newpi', 'dsh', 'toolchain', 'other'];

/** The labels the table uses for a role. */
const ROLE_LABELS = {
  build: 'build jetable',
  cache: 'cache reconstructible',
  logs: 'journaux',
  sessions: 'sessions',
  memory: 'mémoire',
  backups: 'sauvegardes',
  runtime: 'état applicatif',
  data: 'données',
};

/**
 * Parse the command line.
 *
 * @param argv - `process.argv.slice(2)`.
 * @returns the options.
 * @throws {Error} when a flag that needs a value has none.
 */
export function parseArgs(argv) {
  const options = {
    home: null,
    workspace: null,
    state: null,
    dshHome: null,
    clean: null,
    preview: null,
    confirm: null,
    json: false,
    scan: false,
    scope: null,
    help: false,
  };
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at];
    const value = () => {
      const next = argv[at + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} attend une valeur`);
      }
      at += 1;
      return next;
    };
    switch (flag) {
      case '--home':
        options.home = value();
        break;
      case '--workspace':
        options.workspace = value();
        break;
      case '--state':
        options.state = value();
        break;
      case '--dsh-home':
        options.dshHome = value();
        break;
      case '--clean':
        options.clean = value();
        break;
      case '--preview':
        options.preview = value();
        break;
      case '--confirm':
        options.confirm = value();
        break;
      case '--scope':
        options.scope = value();
        break;
      case '--json':
        options.json = true;
        break;
      case '--scan':
        options.scan = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`option inconnue : ${flag}`);
    }
  }
  return options;
}

/**
 * Resolve the roots the catalog is built from.
 *
 * @param options - the parsed command line.
 * @returns the roots, all absolute.
 */
export function resolveRoots(options) {
  const home = resolve(options.home ?? homedir());
  const workspace = resolve(options.workspace ?? process.cwd());
  const state = resolve(options.state ?? join(home, 'Library/Application Support/NewPi'));
  const dshHome = resolve(options.dshHome ?? process.env.DSH_HOME ?? join(home, '.dsh'));
  const data = join(state, 'pocketbase/pb_data');
  return {
    home,
    workspace,
    state,
    dshHome,
    data,
    snapshots: join(data, 'backups'),
    backups: join(state, 'backups'),
  };
}

/**
 * A byte count in the units a person reads.
 *
 * @param value - bytes, or `null`.
 * @returns the formatted string.
 */
export function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  let n = Number(value);
  if (n < 0) return '—';
  const units = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];
  let at = 0;
  while (n >= 1024 && at < units.length - 1) {
    n /= 1024;
    at += 1;
  }
  const text = at === 0 ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0).replace('.', ',');
  return `${text} ${units[at]}`;
}

/**
 * Pad a string to a width, counting characters as the terminal shows them.
 *
 * @param value - the string.
 * @param width - the target width.
 * @returns the padded string.
 */
function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * Measure every entry that has a path, and return them with their figures.
 *
 * @param entries - the catalog.
 * @param options - the measurement.
 * @param options.refresh - unused here; the command measures once per run.
 * @returns the entries with a `measurement` field.
 */
export async function measureAll(entries) {
  const measured = [];
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      measured.push({ ...entry, measurement: null });
      continue;
    }
    const report = await measureTree(entry.path, {
      ...DEFAULT_LIMITS,
      timeoutMs: entry.scanTimeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    });
    measured.push({ ...entry, measurement: report });
  }
  return measured;
}

/**
 * Render the table.
 *
 * @param entries - the measured entries.
 * @param roots - the roots, for the header.
 * @param scope - restrict the output to one scope, or `null`.
 * @returns the text.
 */
export function renderTable(entries, roots, scope = null) {
  const lines = [];
  lines.push(`Racines  projet=${roots.workspace}`);
  lines.push(`         état=${roots.state}`);
  lines.push(`         moteur=${roots.dshHome}`);
  lines.push('');

  const shown = entries.filter((entry) => scope === null || entry.scope === scope);
  const counted = shown.filter((entry) => !Array.isArray(entry.overlaps));
  const total = counted.reduce((sum, entry) => sum + (entry.measurement?.allocated ?? 0), 0);

  for (const group of SCOPES) {
    const rows = shown.filter((entry) => entry.scope === group);
    if (rows.length === 0) continue;
    const groupTotal = rows
      .filter((entry) => !Array.isArray(entry.overlaps))
      .reduce((sum, entry) => sum + (entry.measurement?.allocated ?? 0), 0);
    lines.push(`── ${group} — ${formatBytes(groupTotal)}`);
    const ordered = [...rows].sort(
      (a, b) => (b.measurement?.allocated ?? -1) - (a.measurement?.allocated ?? -1),
    );
    for (const entry of ordered) {
      const allocated = entry.measurement ? formatBytes(entry.measurement.allocated) : '—';
      const logical =
        entry.measurement && entry.measurement.bytes !== entry.measurement.allocated
          ? ` (logique ${formatBytes(entry.measurement.bytes)})`
          : '';
      const budget = budgetFor(entry);
      const over =
        budget !== null && entry.measurement && entry.measurement.allocated > budget
          ? '  ⚠ hors budget'
          : '';
      const kind = isRemovable(entry) ? 'nettoyable' : 'protégé';
      const partial = entry.measurement?.truncated ? '  [mesure partielle]' : '';
      lines.push(
        `   ${pad(entry.id, 24)} ${pad(allocated, 10)} ${pad(kind, 11)} ` +
          `${pad(ROLE_LABELS[entry.role] ?? entry.role, 22)}${logical}${over}${partial}`,
      );
      if (entry.path) lines.push(`   ${' '.repeat(24)} ${entry.path}`);
    }
    lines.push('');
  }
  lines.push(`Total mesuré : ${formatBytes(total)}`);
  return lines.join('\n');
}

/**
 * Print the retention policy.
 *
 * @returns the text.
 */
export function renderPolicy() {
  const lines = ['Politique de rétention'];
  for (const role of Object.values(ROLES)) {
    const rule = RETENTION_POLICY[role];
    lines.push(`  ${pad(ROLE_LABELS[role] ?? role, 22)} ${pad(rule.automatic, 8)} ${rule.note}`);
  }
  return lines.join('\n');
}

/** The usage text. */
const USAGE = `Usage: pnpm storage [options]

  (aucune option)          mesure toutes les cibles et affiche le tableau
  --scope <nom>            limite l'affichage à newpi|dsh|toolchain|other
  --preview <id>           affiche la cible, sa taille et ce que coûte sa suppression
  --clean <id>             supprime une cible reconstructible
  --confirm <id>           obligatoire avec --clean : recopiez l'identifiant
  --json                   sortie JSON
  --home <chemin>          racine personnelle (défaut : $HOME)
  --workspace <chemin>     dossier du projet (défaut : dossier courant)
  --state <chemin>         répertoire d'état de NewPi
  --dsh-home <chemin>      racine du moteur (défaut : $DSH_HOME ou ~/.dsh)

Aucune session, aucune mémoire PocketBase et aucune sauvegarde ne peut être
supprimée par cette commande : le catalogue les marque protégées, et le moteur
de nettoyage refuse un identifiant protégé avant même de résoudre un chemin.`;

/**
 * Run the command.
 *
 * @param argv - `process.argv.slice(2)`.
 * @returns the process exit code.
 */
export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (options.scope !== null && !SCOPES.includes(options.scope)) {
    process.stderr.write(`Portée inconnue : ${options.scope} (attendu : ${SCOPES.join(', ')})\n`);
    return 2;
  }

  const roots = resolveRoots(options);
  const entries = buildCatalog(roots);

  if (options.preview !== null) {
    const entry = entries.find((candidate) => candidate.id === options.preview);
    if (entry === undefined) {
      process.stderr.write(`Cible inconnue : ${options.preview}\n`);
      return 2;
    }
    const preview = await previewCleanup({ entry, roots, limits: DEFAULT_LIMITS });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      return 0;
    }
    process.stdout.write(`Cible           ${preview.target}\n`);
    process.stdout.write(`Libellé         ${preview.label}\n`);
    process.stdout.write(`Rôle            ${ROLE_LABELS[preview.role] ?? preview.role}\n`);
    process.stdout.write(`Classe          ${preview.safety === 'safe' ? 'reconstructible' : 'protégée'}\n`);
    process.stdout.write(`Mode            ${preview.cleanup ?? 'aucun'}\n`);
    process.stdout.write(
      `Taille allouée  ${formatBytes(preview.measurement?.allocated ?? null)}\n`,
    );
    process.stdout.write(
      `Taille logique  ${formatBytes(preview.measurement?.bytes ?? null)}\n`,
    );
    process.stdout.write(`Contenu         ${preview.what}\n`);
    process.stdout.write(`Coût            ${preview.cost}\n`);
    if (!preview.removable) process.stdout.write(`\n${preview.refusal}\n`);
    return preview.removable ? 0 : 1;
  }

  if (options.clean !== null) {
    const entry = entries.find((candidate) => candidate.id === options.clean);
    if (entry === undefined) {
      process.stderr.write(`Cible inconnue : ${options.clean}\n`);
      return 2;
    }
    if (options.confirm !== entry.id) {
      const preview = await previewCleanup({ entry, roots, limits: DEFAULT_LIMITS });
      process.stderr.write(
        `Confirmation requise.\n` +
          `  cible   ${preview.target}\n` +
          `  taille  ${formatBytes(preview.measurement?.allocated ?? null)} alloués\n` +
          `  pour    ${preview.cost}\n\n` +
          `Relancez avec --confirm ${entry.id}\n`,
      );
      return 2;
    }
    const expected = (await measureTree(entry.path, DEFAULT_LIMITS)).allocated;
    try {
      const report = await runSafeCleanup({
        entry,
        roots,
        confirm: options.confirm,
        expectBytes: expected,
        limits: DEFAULT_LIMITS,
      });
      if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else {
        process.stdout.write(
          report.removed
            ? `Nettoyé  ${report.target}\nRécupéré ${formatBytes(report.freed)}\n`
            : `Rien à nettoyer : ${report.target} était déjà absent.\n`,
        );
      }
      return 0;
    } catch (error) {
      if (error instanceof CleanupError) {
        process.stderr.write(`${error.code} : ${error.message}\n`);
        return 2;
      }
      throw error;
    }
  }

  const measured = await measureAll(
    options.scope === null ? entries : entries.filter((entry) => entry.scope === options.scope),
  );
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          roots,
          entries: measured,
          policy: RETENTION_POLICY,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  process.stdout.write(`${renderTable(measured, roots, options.scope)}\n\n`);
  process.stdout.write(`${renderPolicy()}\n`);
  return 0;
}

// Only run when invoked as a script, so the helpers above stay importable by a
// test that wants to check the table without spawning a process. `pathToFileURL`
// rather than string concatenation: a checkout whose path contains a space or a
// non-ASCII character is a checkout on this machine.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
