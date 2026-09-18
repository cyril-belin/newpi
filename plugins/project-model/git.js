/**
 * The Git seam of the Project Model: what "the project is a repository" means,
 * what may be read, and the only six verbs NewPi will run.
 *
 * # Why this lives in the Project Model
 *
 * Git is a property of the project the user has open, not a second product. So
 * there is no `git-console` plugin, no second registry and no second endpoint:
 * `ctx.projectModel` grows a small `ProjectGit` member, and the interface asks
 * the Project Model's existing route. The model stays the only object that
 * knows which project is current; Git only ever runs against
 * `project.rootPath`.
 *
 * # The rules, in one place
 *
 * 1. **The fence is exact.** Every answer starts from
 *    `git rev-parse --show-toplevel`; when it does not equal the project root,
 *    nothing is read and nothing is run. A project that merely lives *inside*
 *    someone else's repository is refused rather than silently operated on.
 * 2. **No nested repository, no submodule.** Both are refused with a sentence a
 *    person can act on, because V1 does not claim to understand them.
 * 3. **Arguments are a list.** Every command is `execFile(git, argv)`. There is
 *    no shell, no interpolation, and no string built from a path. A denylist
 *    checked at the runner refuses `reset`, `clean`, `checkout`, `rebase`,
 *    `branch`, `remote` mutations, `--force`, `-f`, `--hard` and their family,
 *    so a future edit cannot smuggle one in.
 * 4. **No write without a click.** Reading is `git status`, `git diff` and
 *    friends with `GIT_OPTIONAL_LOCKS=0`, so even the index refresh is not
 *    written. Only `add`, `commit`, `fetch`, `push` and `merge --ff-only` may
 *    write, and each is the direct consequence of a named user action.
 * 5. **Nothing is forced.** Push never uses `--force`; the only update is
 *    `merge --ff-only`, which advances or fails without touching the working
 *    copy. A divergence, a conflict or an in-progress operation stops the
 *    action and explains the human step instead.
 * 6. **No secret is kept.** Authentication is whatever Git already has on the
 *    machine — SSH agent, Keychain, Git Credential Manager. The runner disables
 *    the interactive prompt (`GIT_TERMINAL_PROMPT=0`) so a missing credential
 *    is a fast, readable failure instead of a hang, and every diagnostic is
 *    redacted before it reaches a log or the page.
 *
 * @module newpi-plugin-project-model/git
 */

import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { ProjectError, resolveInside } from './model.js';

/** `execFile` as a promise: arguments are still a list, never a shell string. */
const execFileAsync = promisify(execFile);

/** The Git that ships with macOS, by absolute path. `NEWPI_GIT` overrides it. */
export function gitBinary() {
  const override = process.env.NEWPI_GIT;
  return typeof override === 'string' && override !== '' ? override : '/usr/bin/git';
}

/** How long a command that touches only the local repository may take. */
export const GIT_LOCAL_TIMEOUT_MS = 30_000;

/** How long a command that talks to a remote may take. */
export const GIT_NETWORK_TIMEOUT_MS = 180_000;

/** The largest diff the interface is handed, in characters. */
export const MAX_DIFF_CHARS = 200_000;

/** The longest commit message NewPi accepts. */
export const MAX_COMMIT_MESSAGE = 5_000;

/** The most paths one commit may stage. */
export const MAX_COMMIT_PATHS = 500;

/** How deep the nested-repository scan goes below the project root. */
export const NESTED_SCAN_DEPTH = 6;

/** How many directory entries the nested-repository scan visits at most. */
export const NESTED_SCAN_ENTRIES = 20_000;

/** The Git verbs NewPi may run. Anything else is a bug, not a policy. */
export const ALLOWED_SUBCOMMANDS = Object.freeze([
  'rev-parse',
  'status',
  'symbolic-ref',
  'rev-list',
  'merge-base',
  'diff',
  'ls-files',
  'show',
  'fetch',
  'push',
  'merge',
  'add',
  'commit',
  'remote',
]);

/**
 * Flags that would make an operation destructive or forced. Never produced by
 * this module; refused by the runner so one cannot arrive from a later edit.
 */
const FORBIDDEN_FLAGS = Object.freeze([
  '-f',
  '-D',
  '--force',
  '--force-with-lease',
  '--hard',
  '--mixed',
  '--soft',
  '--delete',
  '--mirror',
  '--prune',
  '--all',
  '--tags',
]);

/** Directories the nested scan does not descend into. */
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'target',
  'dist',
  'build',
  '.next',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  'Pods',
  '.build',
  'DerivedData',
]);

/**
 * Assert that one argv is one of the six verbs, assembled safely.
 *
 * This is the last gate before `execFile`. It is intentionally dumber than the
 * callers: it does not know *why* a flag is there, it only knows that the
 * destructive ones never are.
 *
 * @param args - the argv about to be run.
 * @returns the same argv.
 * @throws {ProjectError} when the verb is not allowed or a forbidden flag is present.
 */
export function assertSafeGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new ProjectError('GIT_UNSAFE_ARGUMENT', 'a git command needs an argument list');
  }
  for (const token of args) {
    if (typeof token !== 'string' || token === '') {
      throw new ProjectError('GIT_UNSAFE_ARGUMENT', 'every git argument must be a non-empty string');
    }
  }
  // Flags are only flags before the `--` separator; everything after it is a
  // path, and Git will never read `--force` there as an option.
  const separator = args.indexOf('--');
  const optionEnd = separator === -1 ? args.length : separator;
  for (const token of args.slice(0, optionEnd)) {
    if (FORBIDDEN_FLAGS.some((flag) => token === flag) || token.startsWith('--force')) {
      throw new ProjectError(
        'GIT_UNSAFE_ARGUMENT',
        `the git argument ${JSON.stringify(token)} is not one NewPi may run`,
        500,
      );
    }
  }
  const [verb] = args;
  if (!ALLOWED_SUBCOMMANDS.includes(verb)) {
    throw new ProjectError(
      'GIT_UNSAFE_ARGUMENT',
      `the git command ${JSON.stringify(verb)} is not one NewPi may run`,
      500,
    );
  }
  // The one allowed `merge` is the fast-forward-only update; a plain merge could
  // create a commit and resolve a conflict on the user's behalf.
  if (verb === 'merge' && !args.includes('--ff-only')) {
    throw new ProjectError('GIT_UNSAFE_ARGUMENT', 'the only merge NewPi runs is --ff-only', 500);
  }
  // `git remote` is read as a list, or asked for one URL. Every other form
  // (`add`, `remove`, `set-url`, `prune`) mutates the configured remote.
  if (verb === 'remote') {
    const action = args[1];
    if (action !== undefined && action !== 'get-url' && action !== 'show') {
      throw new ProjectError(
        'GIT_UNSAFE_ARGUMENT',
        `git remote ${JSON.stringify(action)} is not one NewPi may run`,
        500,
      );
    }
  }
  return args;
}

/**
 * Replace anything that looks like a credential in one diagnostic.
 *
 * A remote URL may legally carry `https://user:token@host/...`; it must never
 * reach a log line or the page. The user name is kept, the secret is not.
 *
 * @param text - the raw diagnostic.
 * @returns the redacted text.
 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(/(\w+:\/\/)[^/\s@]+@/g, '$1***@')
    .replace(/(password|passwd|token|secret)=([^\s&]+)/gi, '$1=***');
}

/**
 * Reduce one command's stderr and stdout to one readable line.
 *
 * @param result - the command result.
 * @returns a short, redacted message.
 */
export function scrubGitOutput(result) {
  const text = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`.replace(/\s+/g, ' ').trim();
  return redactSecrets(text).slice(0, 400);
}

/**
 * Run one Git command and always answer with its result.
 *
 * A non-zero exit is a result, not an exception: the callers classify it into a
 * `ProjectError` with the code the interface switches on. A missing binary and
 * a timeout are the two cases that become errors here, because neither carries
 * a diagnostic worth classifying.
 *
 * @param args - the argv, checked by {@link assertSafeGitArgs}.
 * @param options - the run.
 * @param options.cwd - the repository root the command runs in.
 * @param options.timeoutMs - how long it may take.
 * @param options.locks - `false` for a read, which must not refresh the index.
 * @returns `{code, stdout, stderr, timedOut}`.
 * @throws {ProjectError} when Git is not installed at all.
 */
export async function runGit(args, options = {}) {
  assertSafeGitArgs(args);
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : GIT_LOCAL_TIMEOUT_MS;
  const env = { ...process.env };
  // An inherited external diff or textconv would run a second program of the
  // user's choosing while NewPi reads; the variable is removed rather than
  // emptied, so Git sees it as unset. `--no-ext-diff` covers the diff commands
  // too.
  delete env.GIT_EXTERNAL_DIFF;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  if (options.locks === false) {
    // A read that refreshes the index would write to the repository; this makes
    // `git status` and `git diff` observably read-only.
    env.GIT_OPTIONAL_LOCKS = '0';
  }
  try {
    const { stdout, stderr } = await execFileAsync(gitBinary(), args, {
      cwd: options.cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
      env,
    });
    return { code: 0, stdout, stderr, timedOut: false };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ProjectError(
        'GIT_NOT_INSTALLED',
        `Git est introuvable (${gitBinary()}) : installez Git ou définissez NEWPI_GIT.`,
        500,
      );
    }
    const timedOut = error?.killed === true || error?.signal !== null && error?.signal !== undefined;
    return {
      code: timedOut ? 124 : typeof error?.code === 'number' ? error.code : 1,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: timedOut
        ? `la commande a dépassé ${timeoutMs} ms`
        : typeof error?.stderr === 'string'
          ? error.stderr
          : '',
      timedOut: timedOut === true,
    };
  }
}

// ------------------------------------------------------------- porcelain

/**
 * The kind of change one porcelain status letter pair names.
 *
 * @param xy - the two status columns, as Git spells them.
 * @returns one of `modified`, `added`, `deleted`, `renamed`, `untracked`,
 *   `conflicted`, `typechange`.
 */
export function changeKind(xy) {
  const index = xy?.[0] ?? '.';
  const worktree = xy?.[1] ?? '.';
  if (index === '?' || worktree === '?') return 'untracked';
  if (index === 'U' || worktree === 'U') return 'conflicted';
  const code = index !== '.' ? index : worktree;
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R' || code === 'C') return 'renamed';
  if (code === 'T') return 'typechange';
  return 'modified';
}

/**
 * Build one file entry from its porcelain letter pair.
 *
 * @param xy - the two status columns.
 * @param path - the file's path, as Git printed it.
 * @param options - the entry.
 * @param options.originalPath - the source path of a rename or copy.
 * @returns the frozen entry.
 */
export function changeEntry(xy, path, options = {}) {
  const index = xy?.[0] ?? '.';
  const worktree = xy?.[1] ?? '.';
  const kind = changeKind(xy);
  return Object.freeze({
    path,
    index,
    worktree,
    kind,
    originalPath: options.originalPath ?? null,
    staged: index !== '.' && index !== '?',
    unstaged: worktree !== '.' && worktree !== '?',
    added: null,
    removed: null,
    binary: false,
  });
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * The NUL-terminated v2 format is used rather than the short one because it
 * carries the branch, its upstream and the ahead/behind counts in the same
 * answer, and because it spells a path with spaces unambiguously.
 *
 * @param text - the command's standard output.
 * @returns `{oid, branch, upstream, ahead, behind, files}`.
 */
export function parsePorcelainV2(text) {
  const records = String(text ?? '').split('\0');
  const result = { oid: null, branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === '') continue;
    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') result.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') result.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match !== null) {
          result.ahead = Number(match[1]);
          result.behind = Number(match[2]);
        }
      }
      continue;
    }
    const kind = record[0];
    if (kind === '1') {
      const parts = record.split(' ');
      result.files.push(changeEntry(parts[1], parts.slice(8).join(' ')));
    } else if (kind === '2') {
      const parts = record.split(' ');
      const originalPath = records[index + 1] ?? '';
      index += 1;
      result.files.push(changeEntry(parts[1], parts.slice(9).join(' '), { originalPath }));
    } else if (kind === 'u') {
      const parts = record.split(' ');
      result.files.push(changeEntry(parts[1], parts.slice(10).join(' ')));
    } else if (kind === '?') {
      result.files.push(changeEntry('??', record.slice(2)));
    }
  }
  return result;
}

/**
 * Parse `git diff HEAD --numstat -z --no-renames`: the added and removed lines
 * per file, and whether Git calls it binary.
 *
 * `--no-renames` is deliberate: a rename then appears as one deletion and one
 * addition with plain paths, which is what a readable per-file count wants.
 *
 * @param text - the command's standard output.
 * @returns a `Map` from path to `{added, removed, binary}`.
 */
export function parseNumstat(text) {
  const stats = new Map();
  for (const record of String(text ?? '').split('\0')) {
    if (record === '') continue;
    const parts = record.split('\t');
    if (parts.length < 3) continue;
    const [added, removed, ...rest] = parts;
    const path = rest.join('\t');
    const binary = added === '-' || removed === '-';
    stats.set(path, {
      added: binary ? null : Number(added),
      removed: binary ? null : Number(removed),
      binary,
    });
  }
  return stats;
}

/**
 * Parse one `git show -s --format=%h%x1f%s%x1f%an%x1f%ct` line.
 *
 * @param text - the command's standard output.
 * @returns `{shortId, subject, author, at}`, or `null` when there is no commit.
 */
export function parseCommitRecord(text) {
  const line = String(text ?? '').trim();
  if (line === '') return null;
  const [shortId, subject, author, at] = line.split('\x1f');
  if (shortId === undefined || shortId === '') return null;
  return Object.freeze({
    shortId,
    subject: subject ?? '',
    author: author ?? null,
    at: Number.isInteger(Number(at)) && Number(at) > 0 ? Number(at) * 1000 : null,
  });
}

// ----------------------------------------------------------------- errors

/** stderr shapes that mean the credential Git has on this machine was refused. */
const AUTH_FAILURES = [
  /Permission denied \(publickey\)/i,
  /Authentication failed/i,
  /could not read Username/i,
  /could not read Password/i,
  /terminal prompts disabled/i,
  /support for password authentication was removed/i,
  /Invalid username or password/i,
  /Host key verification failed/i,
  /no such identity/i,
];

/** stderr shapes that mean the network, not the repository, is the problem. */
const NETWORK_FAILURES = [
  /Could not resolve host/i,
  /unable to access/i,
  /Connection refused/i,
  /Connection timed out/i,
  /Network is unreachable/i,
  /Operation timed out/i,
  /TLS|SSL/i,
];

/** stderr shapes that mean the remote has commits the local branch does not. */
const REJECTED_PUSH = [/non-fast-forward/i, /\[rejected\]/i, /fetch first/i, /failed to push some refs/i];

/**
 * Turn a failed network command into the error the interface explains.
 *
 * @param result - the failed command result.
 * @param operation - `fetch` or `push`, for the message.
 * @returns the error to throw.
 */
export function classifyRemoteFailure(result, operation) {
  const text = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`;
  if (AUTH_FAILURES.some((pattern) => pattern.test(text))) {
    return new ProjectError(
      'GIT_AUTH_REQUIRED',
      "Git n'a pas pu s'authentifier auprès du dépôt distant. NewPi n'enregistre aucun identifiant : " +
        'configurez votre clé SSH ou vos identifiants Git sur cette machine (par exemple avec ' +
        '`gh auth login` ou le trousseau macOS), puis réessayez.',
      409,
    );
  }
  if (REJECTED_PUSH.some((pattern) => pattern.test(text))) {
    return new ProjectError(
      'GIT_PUSH_REJECTED',
      "Le dépôt distant a refusé l'envoi : il contient des commits que vous n'avez pas encore. " +
        'Récupérez les nouveautés, puis renvoyez. NewPi ne force jamais un envoi.',
      409,
    );
  }
  if (NETWORK_FAILURES.some((pattern) => pattern.test(text))) {
    return new ProjectError(
      'GIT_NETWORK_UNAVAILABLE',
      `Le dépôt distant est injoignable (${scrubGitOutput(result) || 'réseau indisponible'}).`,
      409,
    );
  }
  if (/does not appear to be a git repository|Repository not found|No such remote/i.test(text)) {
    return new ProjectError(
      'GIT_REMOTE_UNAVAILABLE',
      `Le dépôt distant configuré est introuvable ou inaccessible : ${scrubGitOutput(result)}`,
      409,
    );
  }
  return new ProjectError(
    'GIT_COMMAND_FAILED',
    `git ${operation} a échoué : ${scrubGitOutput(result) || 'raison inconnue'}`,
    500,
  );
}

/**
 * Turn a failed `git commit` into the error the interface explains.
 *
 * @param result - the failed command result.
 * @returns the error to throw.
 */
export function classifyCommitFailure(result) {
  const text = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`;
  if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(text)) {
    return new ProjectError(
      'GIT_NOTHING_TO_COMMIT',
      "Les fichiers choisis n'ont aucun changement à enregistrer.",
      409,
    );
  }
  if (/Please tell me who you are|unable to auto-detect email address|empty ident name/i.test(text)) {
    return new ProjectError(
      'GIT_IDENTITY_MISSING',
      "Git ne connaît pas votre identité sur cette machine : renseignez `git config --global user.name` " +
        'et `user.email`, puis réessayez.',
      409,
    );
  }
  if (/hook declined|pre-commit hook|commit-msg hook/i.test(text)) {
    return new ProjectError(
      'GIT_HOOK_FAILED',
      `Un hook Git a refusé le commit : ${scrubGitOutput(result)}`,
      409,
    );
  }
  return new ProjectError(
    'GIT_COMMAND_FAILED',
    `git commit a échoué : ${scrubGitOutput(result) || 'raison inconnue'}`,
    500,
  );
}

// ------------------------------------------------------------- validation

/**
 * Validate a commit message.
 *
 * @param value - the candidate.
 * @returns the trimmed message.
 * @throws {ProjectError} when it is absent, blank, too long or carries a NUL.
 */
export function normalizeCommitMessage(value) {
  if (typeof value !== 'string') {
    throw new ProjectError('GIT_MESSAGE_REQUIRED', 'un message est nécessaire pour enregistrer une étape');
  }
  const message = value.replaceAll('\r\n', '\n').trim();
  if (message === '') {
    throw new ProjectError('GIT_MESSAGE_REQUIRED', 'le message du commit ne peut pas être vide');
  }
  if (message.includes('\0')) {
    throw new ProjectError('GIT_INVALID_MESSAGE', 'le message du commit contient un caractère interdit');
  }
  if (message.length > MAX_COMMIT_MESSAGE) {
    throw new ProjectError(
      'GIT_INVALID_MESSAGE',
      `le message du commit dépasse ${MAX_COMMIT_MESSAGE} caractères`,
    );
  }
  return message;
}

/**
 * Resolve one selected path to a spelling `git` can take, inside the root.
 *
 * @param root - the project root.
 * @param candidate - the path the interface selected.
 * @returns the path relative to the root.
 * @throws {ProjectError} when the path escapes the root or names `.git`.
 */
export function resolveRepositoryPath(root, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ProjectError('GIT_INVALID_PATH', 'un chemin de fichier doit être une chaîne non vide');
  }
  const absolute = resolveInside(root, candidate);
  const path = relative(resolve(root), absolute);
  if (path === '' || path.startsWith('..') || isAbsolute(path)) {
    throw new ProjectError('PROJECT_OUTSIDE_ROOT', `${JSON.stringify(candidate)} is outside the project`, 403);
  }
  if (path === '.git' || path.startsWith('.git/') || path.includes('/.git/')) {
    throw new ProjectError('GIT_INVALID_PATH', `${JSON.stringify(candidate)} appartient au dépôt lui-même`);
  }
  if (path.includes('\0') || path.includes('\n')) {
    throw new ProjectError('GIT_INVALID_PATH', 'un chemin de fichier contient un caractère interdit');
  }
  return path;
}

/**
 * Validate the file list of one commit.
 *
 * @param root - the project root.
 * @param value - the candidate list.
 * @returns the relative paths, deduplicated, in the order given.
 * @throws {ProjectError} when the list is empty, too long or wrongly shaped.
 */
export function normalizeCommitPaths(root, value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ProjectError('GIT_NO_PATHS', 'choisissez au moins un fichier à enregistrer');
  }
  if (value.length > MAX_COMMIT_PATHS) {
    throw new ProjectError('GIT_TOO_MANY_PATHS', `un commit ne peut pas dépasser ${MAX_COMMIT_PATHS} fichiers`);
  }
  const paths = [];
  for (const candidate of value) {
    const path = resolveRepositoryPath(root, candidate);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

// ---------------------------------------------------------------- the seam

/** The `.git` markers that mean an operation is already under way. */
const IN_PROGRESS_MARKERS = Object.freeze({
  MERGE_HEAD: 'merge',
  CHERRY_PICK_HEAD: 'cherry-pick',
  REVERT_HEAD: 'revert',
  BISECT_LOG: 'bisect',
});

/** How each in-progress operation is explained to a person. */
const IN_PROGRESS_LABELS = Object.freeze({
  merge: 'une fusion est en cours et n\'est pas terminée',
  rebase: 'un rebasage est en cours',
  'cherry-pick': 'un cherry-pick est en cours',
  revert: 'une annulation est en cours',
  bisect: 'une recherche de régression (bisect) est en cours',
  locked: 'une autre commande Git est en cours (fichier index.lock présent)',
});

/** Whether a path exists, without following it into an error. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The canonical spelling of a path, best effort. */
async function canonical(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Find the first repository nested below the project root.
 *
 * The scan is bounded on purpose: it never leaves the root, never follows a
 * symlinked directory, skips dependency and build directories, and stops at
 * {@link NESTED_SCAN_DEPTH} or {@link NESTED_SCAN_ENTRIES}. The bound is the
 * honest limit of the check, not a claim that no nested repository exists.
 *
 * @param root - the project root.
 * @returns the relative path of the nested repository, or `null`.
 */
export async function findNestedRepository(root) {
  const queue = [{ directory: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    if (depth >= NESTED_SCAN_DEPTH) continue;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= NESTED_SCAN_ENTRIES) return null;
      visited += 1;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const child = join(directory, entry.name);
      if (await exists(join(child, '.git'))) return relative(root, child);
      queue.push({ directory: child, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * The operation already under way in a repository, if any.
 *
 * @param gitDir - the repository's Git directory.
 * @returns a marker name, or `null`.
 */
export async function detectInProgress(gitDir) {
  for (const [marker, kind] of Object.entries(IN_PROGRESS_MARKERS)) {
    if (await exists(join(gitDir, marker))) return kind;
  }
  if (await exists(join(gitDir, 'rebase-merge'))) return 'rebase';
  if (await exists(join(gitDir, 'rebase-apply'))) return 'rebase';
  if (await exists(join(gitDir, 'index.lock'))) return 'locked';
  return null;
}

/**
 * The Git behaviour of one project root.
 *
 * The class is injectable: a test hands it a recording runner and proves the
 * argv, while the real runner is the `execFile` above.
 */
export class ProjectGit {
  /** The runner every command goes through. */
  _run;

  /**
   * @param options - the seam.
   * @param options.run - the command runner; defaults to {@link runGit}.
   */
  constructor(options = {}) {
    this._run = typeof options.run === 'function' ? options.run : runGit;
  }

  // ----------------------------------------------------------- the fence

  /**
   * Locate the repository that a project root names, and every reason it may
   * not be usable.
   *
   * @param root - the project root.
   * @returns `{repo, toplevel?, gitDir?, blocked?, inProgress?, reason?}`.
   */
  async locate(root) {
    const local = { cwd: root, locks: false, timeoutMs: GIT_LOCAL_TIMEOUT_MS };
    const top = await this._run(['rev-parse', '--show-toplevel'], local);
    if (top.code !== 0) return { repo: false, reason: 'not-a-repository' };

    const toplevel = await canonical(top.stdout.trim());
    const projectRoot = await canonical(root);
    if (toplevel !== projectRoot) {
      return {
        repo: true,
        toplevel,
        blocked: {
          code: 'GIT_ROOT_MISMATCH',
          message:
            `Le dépôt Git trouvé est à ${toplevel}, alors que le projet ouvert est ${projectRoot}. ` +
            "NewPi n'agit que sur un dépôt dont la racine est exactement le dossier du projet.",
        },
      };
    }

    const superproject = await this._run(['rev-parse', '--show-superproject-working-tree'], local);
    if (superproject.code === 0 && superproject.stdout.trim() !== '') {
      return { repo: true, toplevel, blocked: submoduleBlocked() };
    }
    if (await exists(join(projectRoot, '.gitmodules'))) {
      return { repo: true, toplevel, blocked: submoduleBlocked() };
    }
    const staged = await this._run(['ls-files', '--stage'], local);
    if (staged.code === 0 && /(^|\n)160000 /.test(staged.stdout)) {
      return { repo: true, toplevel, blocked: submoduleBlocked() };
    }
    const nested = await findNestedRepository(projectRoot);
    if (nested !== null) {
      return {
        repo: true,
        toplevel,
        blocked: {
          code: 'GIT_NESTED_REPOSITORY',
          message:
            `Le projet contient un second dépôt Git (${nested}). NewPi ne sait pas encore gérer ` +
            'les dépôts imbriqués : cette première version refuse le projet au lieu de risquer ' +
            'une action dans le mauvais dépôt.',
        },
      };
    }

    const gitDirResult = await this._run(['rev-parse', '--absolute-git-dir'], local);
    const gitDir = gitDirResult.code === 0 ? gitDirResult.stdout.trim() : join(projectRoot, '.git');
    const inProgress = await detectInProgress(gitDir);
    return { repo: true, toplevel, gitDir, blocked: null, inProgress };
  }

  /**
   * The full state of the project's repository.
   *
   * A project without a repository is an answer, not an error: the interface
   * must be able to say "no Git here" as calmly as it says "clean".
   *
   * @param root - the project root.
   * @returns the frozen snapshot.
   */
  async status(root) {
    const located = await this.locate(root);
    if (!located.repo) return emptyStatus(root, 'not-a-repository', null);
    if (located.blocked !== null) return emptyStatus(root, 'blocked', located);
    return this._snapshot(root, located);
  }

  /**
   * The diff of one file, as text the interface can show.
   *
   * @param root - the project root.
   * @param input - the diff.
   * @param input.path - the file, relative to the root or absolute inside it.
   * @param input.area - `work` for the working tree, `index` for the staged version.
   * @returns the frozen diff.
   */
  async diff(root, input = {}) {
    const located = await this.locate(root);
    assertRepository(located);
    const path = resolveRepositoryPath(root, input.path);
    const area = input.area === 'index' ? 'index' : 'work';
    const args = ['diff', '--no-color', '--no-ext-diff', '--unified=3'];
    if (area === 'index') args.push('--cached');
    args.push('--', path);
    const result = await this._run(args, { cwd: root, locks: false, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
    if (result.code !== 0) {
      throw new ProjectError('GIT_DIFF_FAILED', `git diff a échoué : ${scrubGitOutput(result)}`, 500);
    }
    let text = result.stdout;
    if (text.trim() === '' && area === 'work') {
      // `git diff` says nothing about an untracked file; a no-index diff against
      // `/dev/null` shows it as the addition it is. A staged-only file is left
      // alone, which is why the file must first be proved untracked.
      const tracked = await this._run(['ls-files', '--error-unmatch', '--', path], {
        cwd: root,
        locks: false,
        timeoutMs: GIT_LOCAL_TIMEOUT_MS,
      });
      if (tracked.code !== 0) {
        const untracked = await this._run(['diff', '--no-index', '--no-color', '--no-ext-diff', '--', '/dev/null', path], {
          cwd: root,
          locks: false,
          timeoutMs: GIT_LOCAL_TIMEOUT_MS,
        });
        text = untracked.stdout;
      }
    }
    const binary = /^Binary files .* differ/m.test(text) || /^GIT binary patch/m.test(text);
    const truncated = text.length > MAX_DIFF_CHARS;
    return Object.freeze({
      path,
      area,
      binary,
      truncated,
      chars: text.length,
      text: truncated ? text.slice(0, MAX_DIFF_CHARS) : text,
    });
  }

  /**
   * Create one local commit from the files the user selected.
   *
   * The message is the user's, the file list is the user's, and nothing else is
   * staged: the commit is taken with an explicit pathspec, so a change staged
   * outside NewPi is not swept in.
   *
   * @param root - the project root.
   * @param input - the commit.
   * @param input.message - the commit message.
   * @param input.paths - the selected files.
   * @returns `{ok, commit, status}`.
   */
  async commit(root, input = {}) {
    const located = await this.locate(root);
    assertRepository(located);
    const before = await this._snapshot(root, located);
    assertIdle(located, before);
    const message = normalizeCommitMessage(input.message);
    const paths = normalizeCommitPaths(root, input.paths);

    const add = await this._run(['add', '--', ...paths], {
      cwd: root,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (add.code !== 0) {
      throw new ProjectError('GIT_ADD_FAILED', `git add a échoué : ${scrubGitOutput(add)}`, 500);
    }
    const commit = await this._run(['commit', '-m', message, '--', ...paths], {
      cwd: root,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (commit.code !== 0) throw classifyCommitFailure(commit);

    const after = await this._snapshot(root, await this.locate(root));
    return Object.freeze({ ok: true, commit: after.lastCommit, status: after });
  }

  /**
   * Ask the configured remote what it has. Read-only for the working copy.
   *
   * @param root - the project root.
   * @returns `{ok, fetched, remote, status}`.
   */
  async fetch(root) {
    const located = await this.locate(root);
    assertRepository(located);
    const before = await this._snapshot(root, located);
    assertIdle(located, before);
    const remote = requireRemote(before);

    const result = await this._run(['fetch', '--no-tags', remote.name], {
      cwd: root,
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    if (result.code !== 0) throw classifyRemoteFailure(result, 'fetch');

    const after = await this._snapshot(root, await this.locate(root));
    return Object.freeze({ ok: true, fetched: true, remote, status: after });
  }

  /**
   * Push the local commits of the current branch. Never forced, never deleting.
   *
   * @param root - the project root.
   * @returns `{ok, pushed, remote, branch, status}`.
   */
  async push(root) {
    const located = await this.locate(root);
    assertRepository(located);
    const before = await this._snapshot(root, located);
    assertIdle(located, before);
    if (before.branch === null) {
      throw new ProjectError(
        'GIT_DETACHED_HEAD',
        'La branche courante est détachée : NewPi ne sait pas quoi envoyer. Revenez sur une branche nommée.',
        409,
      );
    }
    if (before.upstream !== null && before.ahead === 0) {
      throw new ProjectError(
        'GIT_NOTHING_TO_PUSH',
        "Aucun commit local n'attend d'être envoyé : le dépôt distant est déjà à jour pour cette branche.",
        409,
      );
    }
    const remote = requireRemote(before);
    const target = pushTarget(before, remote);

    const result = await this._run(['push', remote.name, target], {
      cwd: root,
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    if (result.code !== 0) throw classifyRemoteFailure(result, 'push');

    const after = await this._snapshot(root, await this.locate(root));
    return Object.freeze({
      ok: true,
      pushed: true,
      remote,
      branch: before.branch,
      status: after,
    });
  }

  /**
   * Update the local branch from its upstream, by fast-forward only.
   *
   * The remote is fetched first so the decision is made on what is really
   * there, and the local copy is only touched by `merge --ff-only`: a
   * divergence, a dirty working tree or an unrelated history stops here with
   * the local branch exactly where it was.
   *
   * @param root - the project root.
   * @returns `{ok, updated, alreadyUpToDate, status}`.
   */
  async pull(root) {
    const located = await this.locate(root);
    assertRepository(located);
    const before = await this._snapshot(root, located);
    assertIdle(located, before);
    if (before.branch === null) {
      throw new ProjectError(
        'GIT_DETACHED_HEAD',
        'La branche courante est détachée : revenez sur une branche nommée avant de récupérer les nouveautés.',
        409,
      );
    }
    if (before.upstream === null) {
      throw new ProjectError(
        'GIT_NO_UPSTREAM',
        "Cette branche ne suit aucune branche distante : NewPi ne sait pas d'où récupérer. " +
          'Configurez le suivi, par exemple avec `git branch --set-upstream-to`.',
        409,
      );
    }
    if (before.dirty) {
      throw new ProjectError(
        'GIT_WORKTREE_DIRTY',
        'Des modifications ne sont pas enregistrées : NewPi ne met à jour que sur une copie propre, ' +
          'pour ne rien perdre. Enregistrez une étape ou remisez vos changements, puis réessayez.',
        409,
      );
    }
    const remote = requireRemote(before);
    const fetched = await this._run(['fetch', '--no-tags', remote.name], {
      cwd: root,
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    if (fetched.code !== 0) throw classifyRemoteFailure(fetched, 'fetch');

    const fresh = await this._snapshot(root, await this.locate(root));
    if (fresh.dirty) {
      throw new ProjectError('GIT_WORKTREE_DIRTY', 'Des modifications sont apparues pendant la lecture du distant.', 409);
    }
    if (fresh.ahead > 0 && fresh.behind > 0) throw divergedError(fresh);
    if (fresh.behind === 0) {
      return Object.freeze({ ok: true, updated: false, alreadyUpToDate: true, status: fresh });
    }
    if (!fresh.fastForward) throw divergedError(fresh);

    const merge = await this._run(['merge', '--ff-only', fresh.upstream], {
      cwd: root,
      timeoutMs: GIT_LOCAL_TIMEOUT_MS,
    });
    if (merge.code !== 0) {
      const text = `${merge.stderr}\n${merge.stdout}`;
      if (/not possible to fast-forward|would be overwritten|untracked working tree files/i.test(text)) {
        throw new ProjectError(
          'GIT_UPDATE_BLOCKED',
          "La mise à jour n'a pas pu se faire sans conflit ou sans écraser un fichier local. " +
            'La copie locale est intacte : rien n\'a été modifié.',
          409,
        );
      }
      throw new ProjectError('GIT_COMMAND_FAILED', `git merge --ff-only a échoué : ${scrubGitOutput(merge)}`, 500);
    }

    const after = await this._snapshot(root, await this.locate(root));
    return Object.freeze({
      ok: true,
      updated: after.oid !== fresh.oid,
      alreadyUpToDate: after.oid === fresh.oid,
      status: after,
    });
  }

  // --------------------------------------------------------- the snapshot

  /** Read the full snapshot of a repository already located and unblocked. */
  async _snapshot(root, located) {
    const read = (args) => this._run(args, { cwd: root, locks: false, timeoutMs: GIT_LOCAL_TIMEOUT_MS });
    const porcelain = await read(['status', '--porcelain=v2', '--branch', '-z']);
    if (porcelain.code !== 0) {
      throw new ProjectError('GIT_STATUS_FAILED', `git status a échoué : ${scrubGitOutput(porcelain)}`, 500);
    }
    const parsed = parsePorcelainV2(porcelain.stdout);
    const numstat = await read(['diff', 'HEAD', '--numstat', '-z', '--no-renames', '--no-ext-diff']);
    const stats = numstat.code === 0 ? parseNumstat(numstat.stdout) : new Map();

    const files = parsed.files.map((entry) => {
      const stat = stats.get(entry.path);
      return Object.freeze({
        ...entry,
        added: stat?.added ?? null,
        removed: stat?.removed ?? null,
        binary: stat?.binary ?? false,
      });
    });
    const staged = files.filter((file) => file.staged).length;
    const unstaged = files.filter((file) => file.unstaged).length;
    const untracked = files.filter((file) => file.kind === 'untracked').length;
    const conflicted = files.filter((file) => file.kind === 'conflicted').length;
    const dirty = files.some((file) => file.staged || file.unstaged);

    const remotes = await this._remotes(root, read);
    const remote = await this._remoteFor(parsed.upstream, remotes, read);

    let fastForward = false;
    if (parsed.upstream !== null && parsed.behind > 0 && parsed.ahead === 0) {
      const ancestor = await read(['merge-base', '--is-ancestor', 'HEAD', '@{upstream}']);
      fastForward = ancestor.code === 0;
    }
    const diverged = parsed.ahead > 0 && parsed.behind > 0;

    const head = await read(['show', '-s', '--format=%h%x1f%s%x1f%an%x1f%ct', 'HEAD']);
    const lastCommit = head.code === 0 ? parseCommitRecord(head.stdout) : null;

    return Object.freeze({
      repo: true,
      usable: true,
      blocked: null,
      reason: null,
      rootPath: root,
      toplevel: located.toplevel ?? root,
      oid: parsed.oid,
      branch: parsed.branch,
      detached: parsed.branch === null,
      upstream: parsed.upstream,
      remote,
      remotes,
      ahead: parsed.ahead,
      behind: parsed.behind,
      fastForward,
      diverged,
      clean: !dirty && conflicted === 0,
      dirty,
      conflicted: conflicted > 0,
      inProgress: located.inProgress ?? null,
      files: Object.freeze(files),
      counts: Object.freeze({
        files: files.length,
        staged,
        unstaged,
        untracked,
        conflicted,
      }),
      lastCommit,
      lastSync: null,
    });
  }

  /** The configured remote names, in Git's order. */
  async _remotes(root, read) {
    const listed = await read(['remote']);
    if (listed.code !== 0) return Object.freeze([]);
    return Object.freeze(
      listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    );
  }

  /**
   * The remote the interface should talk about: the upstream's when there is
   * one, the only configured remote otherwise, and nothing when the choice
   * would be a guess.
   */
  async _remoteFor(upstream, remotes, read) {
    const name = upstream !== null ? upstream.split('/')[0] : remotes.length === 1 ? remotes[0] : null;
    if (name === null) return null;
    const url = await read(['remote', 'get-url', name]);
    return Object.freeze({
      name,
      url: url.code === 0 ? redactSecrets(url.stdout.trim()) : null,
      followsUpstream: upstream !== null,
    });
  }
}

// -------------------------------------------------------------- helpers

/** The refusal a submodule produces. */
function submoduleBlocked() {
  return {
    code: 'GIT_SUBMODULE_UNSUPPORTED',
    message:
      "Ce projet est un sous-module Git (ou en contient un). NewPi ne sait pas encore les gérer : " +
      'cette première version refuse le projet au lieu de risquer une action dans le mauvais dépôt.',
  };
}

/** Refuse a project that names no usable repository. */
function assertRepository(located) {
  if (!located.repo) {
    throw new ProjectError(
      'GIT_NOT_A_REPOSITORY',
      "Ce dossier n'est pas un dépôt Git. NewPi ne crée pas de dépôt à votre place : " +
        'initialisez-en un (`git init`) si vous voulez suivre ce projet.',
      409,
    );
  }
  if (located.blocked !== null) {
    throw new ProjectError(located.blocked.code, located.blocked.message, 409);
  }
}

/** Refuse a mutating action while Git is already in the middle of something. */
function assertIdle(located, snapshot) {
  if (located.inProgress !== null && located.inProgress !== undefined) {
    throw new ProjectError(
      'GIT_OPERATION_IN_PROGRESS',
      `NewPi s'arrête ici : ${IN_PROGRESS_LABELS[located.inProgress] ?? 'une opération Git est en cours'}. ` +
        "Terminez-la ou annulez-la dans un terminal, puis revenez ici. Rien n'a été forcé.",
      409,
    );
  }
  if (snapshot.conflicted) {
    throw new ProjectError(
      'GIT_CONFLICT_UNRESOLVED',
      'Des fichiers sont en conflit et ne sont pas résolus. NewPi ne choisit pas à votre place : ' +
        'résolvez le conflit dans un éditeur, puis enregistrez une étape.',
      409,
    );
  }
}

/** The error a divergence produces. */
function divergedError(snapshot) {
  return new ProjectError(
    'GIT_DIVERGED',
    `Les histoires ont divergé : ${snapshot.ahead} commit(s) local(aux) et ${snapshot.behind} sur le distant. ` +
      'NewPi ne fusionne pas automatiquement. La copie locale est intacte : faites la fusion vous-même ' +
      'dans un terminal, puis revenez ici.',
    409,
  );
}

/** The remote a fetch, push or update needs; refuses an ambiguous choice. */
function requireRemote(snapshot) {
  if (snapshot.remote !== null) return snapshot.remote;
  if (Array.isArray(snapshot.remotes) && snapshot.remotes.length > 1) {
    throw new ProjectError(
      'GIT_REMOTE_AMBIGUOUS',
      'Plusieurs dépôts distants sont configurés et cette branche n\'en suit aucun : ' +
        'NewPi ne devine pas lequel utiliser.',
      409,
    );
  }
  throw new ProjectError(
    'GIT_NO_REMOTE',
    "Aucun dépôt distant n'est configuré pour ce projet. Ajoutez-en un dans un terminal " +
      '(`git remote add origin ...`), puis revenez ici.',
    409,
  );
}

/** The refspec one push uses: the upstream's branch when there is one. */
function pushTarget(snapshot, remote) {
  const local = `refs/heads/${snapshot.branch}`;
  if (snapshot.upstream === null) return `${local}:${local}`;
  const name = snapshot.upstream.slice(remote.name.length + 1);
  return `${local}:refs/heads/${name}`;
}

/** The snapshot of a project that has no usable repository. */
function emptyStatus(rootPath, reason, located) {
  return Object.freeze({
    repo: located?.repo === true,
    usable: false,
    blocked: located?.blocked ?? null,
    reason,
    rootPath,
    toplevel: located?.toplevel ?? null,
    oid: null,
    branch: null,
    detached: false,
    upstream: null,
    remote: null,
    remotes: Object.freeze([]),
    ahead: 0,
    behind: 0,
    fastForward: false,
    diverged: false,
    clean: true,
    dirty: false,
    conflicted: false,
    inProgress: null,
    files: Object.freeze([]),
    counts: Object.freeze({ files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }),
    lastCommit: null,
    lastSync: null,
  });
}
