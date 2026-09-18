/**
 * The Git seam of the Project Model, proven against real repositories.
 *
 * Nothing here is faked at the boundary that matters: every test builds a real
 * repository under a temporary directory, most of them with a real **bare remote
 * on the local disk**, and runs the same `execFile(git, argv)` the application
 * runs. A fake filesystem would prove the parser; it would not prove that a
 * fast-forward update really leaves the working copy alone, that a divergence is
 * really refused, or that a force push is really impossible.
 *
 * The refusals carry the weight. A Git feature in a desktop tool is only
 * trustworthy if it cannot rewrite history, cannot lose a local change, and
 * cannot operate on the wrong repository. So the suite proves, in order:
 *
 * - the fence (`--show-toplevel` must equal the project root exactly);
 * - nested repositories, submodules and non-repositories are refused;
 * - status, diff and a commit of the selected files only;
 * - a normal push works, and a forced push is impossible by construction;
 * - fetch works, and a fast-forward update is the only update;
 * - a divergence and a conflict change nothing locally;
 * - an in-flight Git operation holds the Project Model's guard, so a project
 *   change, a removal and a relaunch are refused while it runs.
 *
 * @module newpi/tests/project-git
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import {
  ProjectGit,
  assertSafeGitArgs,
  findNestedRepository,
  normalizeCommitMessage,
  parseNumstat,
  parsePorcelainV2,
  parseCommitRecord,
  redactSecrets,
  resolveRepositoryPath,
  runGit,
} from '../plugins/project-model/git.js';
import { ProjectError } from '../plugins/project-model/model.js';

const run = promisify(execFile);

// The suite proves Git's behaviour, not the machine's preferences: every
// command runs without the user's global configuration, and each fixture sets
// its own identity locally. The plugin's own runner inherits this too, which is
// what keeps a global `commit.gpgsign` or hook from changing the outcome.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';

// --------------------------------------------------------------- the harness

/** Run one Git command for real; a non-zero exit rejects. */
async function git(args, cwd) {
  const { stdout } = await run('/usr/bin/git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** Resolve a path inside the harness's module tree, as the other suites do. */
function harnessPath(name) {
  const tree =
    process.env.DSH_PROFILE_MODULES ?? join(process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules');
  return join(tree, name);
}

/** Resolve a path inside this repository. */
const ROOT = new URL('../', import.meta.url);

/** Let the pending microtasks and immediates settle. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** A fresh, canonical temporary directory. */
async function directory(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), `newpi-${prefix}-`)));
}

/** Create a repository with one commit on `main`. */
async function initRepo(root) {
  await mkdir(root, { recursive: true });
  await git(['init', '-q', '-b', 'main', '.'], root);
  await git(['config', 'user.email', 'newpi@test.invalid'], root);
  await git(['config', 'user.name', 'NewPi Test'], root);
  await writeFile(join(root, 'README.md'), '# demo\n');
  await git(['add', '--', 'README.md'], root);
  await git(['commit', '-q', '-m', 'initial'], root);
}

/** Create a bare repository, the "GitHub" of these tests. */
async function initBare(root) {
  await mkdir(root, { recursive: true });
  await git(['init', '-q', '--bare', '.'], root);
}

/** The three directories one test world owns. */
async function world() {
  const base = await directory('git');
  const remote = join(base, 'remote.git');
  const repo = join(base, 'repo');
  await initBare(remote);
  await initRepo(repo);
  await git(['remote', 'add', 'origin', remote], repo);
  await git(['push', '-q', '-u', 'origin', 'main'], repo);
  return { base, remote, repo, git: new ProjectGit() };
}

/** Remove a world, whatever a test did to it. */
async function cleanup(base) {
  await rm(base, { recursive: true, force: true });
}

/** One file's content, as the local copy has it. */
function read(path) {
  return readFile(path, 'utf8');
}

/** The commit count of one revision. */
async function commitCount(repo, revision = 'HEAD') {
  const output = await git(['rev-list', '--count', revision], repo);
  return Number(output.trim());
}

/** The subject of one revision. */
async function subject(repo, revision = 'HEAD') {
  return (await git(['show', '-s', '--format=%s', revision], repo)).trim();
}

// ============================================================ the pure rules

test('the runner refuses every destructive verb and flag, and allows the six', () => {
  const refused = [
    ['reset', '--hard', 'HEAD'],
    ['reset'],
    ['clean', '-fd'],
    ['checkout', '--', '.'],
    ['checkout', 'main'],
    ['switch', 'main'],
    ['restore', '.'],
    ['rebase', 'main'],
    ['branch', '-D', 'feature'],
    ['remote', 'add', 'other', 'url'],
    ['remote', 'set-url', 'origin', 'url'],
    ['remote', 'remove', 'origin'],
    ['update-ref', 'refs/heads/x', 'HEAD'],
    ['stash'],
    ['rm', '--', 'a'],
    ['config', 'user.email', 'x@y.z'],
    ['push', '--force', 'origin', 'main'],
    ['push', '-f', 'origin', 'main'],
    ['push', '--force-with-lease', 'origin', 'main'],
    ['push', '--delete', 'origin', 'main'],
    ['merge', 'main'],
  ];
  for (const argv of refused) {
    assert.throws(
      () => assertSafeGitArgs(argv),
      (error) => error instanceof ProjectError && error.code === 'GIT_UNSAFE_ARGUMENT',
      `git ${argv.join(' ')} must be refused`,
    );
  }

  const allowed = [
    ['rev-parse', '--show-toplevel'],
    ['status', '--porcelain=v2', '--branch', '-z'],
    ['diff', 'HEAD', '--numstat', '-z', '--no-renames'],
    ['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'],
    ['merge', '--ff-only', 'origin/main'],
    ['remote'],
    ['remote', 'get-url', 'origin'],
    ['commit', '-m', 'message', '--', 'src/a.js'],
    ['push', 'origin', 'refs/heads/main:refs/heads/main'],
    // A path may be spelled like a flag: after `--` Git reads it as a path, and
    // the gate must not confuse the two.
    ['add', '--', '-f'],
    ['commit', '-m', 'x', '--', '--hard'],
  ];
  for (const argv of allowed) {
    assert.doesNotThrow(() => assertSafeGitArgs(argv), `git ${argv.join(' ')} must be allowed`);
  }
});

test('porcelain v2 is parsed with its branch, its upstream and its changes', () => {
  const parsed = parsePorcelainV2(
    '# branch.oid abc\0' +
      '# branch.head main\0' +
      '# branch.upstream origin/main\0' +
      '# branch.ab +2 -3\0' +
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.js\0' +
      '1 A. N... 000000 100644 100644 000 000 new.js\0' +
      '2 R. N... 100644 100644 100644 aaa bbb R100 moved.js\0old.js\0' +
      'u UU N... 100644 100644 100644 100644 a b c conflict.js\0' +
      '? untracked.txt\0',
  );
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.upstream, 'origin/main');
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 3);
  assert.equal(parsed.files.length, 5);
  const modified = parsed.files.find((file) => file.path === 'src/a file.js');
  assert.equal(modified.kind, 'modified');
  assert.equal(modified.staged, false, 'a worktree-only change is not staged');
  assert.equal(modified.unstaged, true);
  const added = parsed.files.find((file) => file.path === 'new.js');
  assert.equal(added.kind, 'added');
  assert.equal(added.staged, true);
  const renamed = parsed.files.find((file) => file.path === 'moved.js');
  assert.equal(renamed.kind, 'renamed');
  assert.equal(renamed.originalPath, 'old.js');
  const conflict = parsed.files.find((file) => file.path === 'conflict.js');
  assert.equal(conflict.kind, 'conflicted');
  assert.equal(parsed.files.find((file) => file.path === 'untracked.txt').kind, 'untracked');

  // A detached head is spelled `(detached)` and means "no branch".
  const detached = parsePorcelainV2('# branch.oid abc\0# branch.head (detached)\0');
  assert.equal(detached.branch, null);
});

test('numstat and the commit record are parsed, and secrets are redacted', () => {
  const stats = parseNumstat('3\t1\tsrc/a.js\0-\t-\tlogo.png\0');
  assert.deepEqual(stats.get('src/a.js'), { added: 3, removed: 1, binary: false });
  assert.deepEqual(stats.get('logo.png'), { added: null, removed: null, binary: true });

  const commit = parseCommitRecord('abc1234\x1fInitial commit\x1fAda\x1f1700000000\n');
  assert.equal(commit.shortId, 'abc1234');
  assert.equal(commit.subject, 'Initial commit');
  assert.equal(commit.author, 'Ada');
  assert.equal(commit.at, 1_700_000_000_000);
  assert.equal(parseCommitRecord(''), null);

  assert.equal(
    redactSecrets('fatal: https://user:ghp_secret@github.com/x/y.git refused'),
    'fatal: https://***@github.com/x/y.git refused',
  );
  assert.ok(!redactSecrets('token=abcd1234').includes('abcd1234'));
});

test('a commit message and a selected path are validated before Git sees them', () => {
  assert.equal(normalizeCommitMessage('  étape 1  '), 'étape 1');
  assert.throws(() => normalizeCommitMessage('   '), (error) => error.code === 'GIT_MESSAGE_REQUIRED');
  assert.throws(() => normalizeCommitMessage(42), (error) => error.code === 'GIT_MESSAGE_REQUIRED');
  assert.throws(
    () => normalizeCommitMessage('x'.repeat(5_001)),
    (error) => error.code === 'GIT_INVALID_MESSAGE',
  );

  const root = '/Users/x/project';
  assert.equal(resolveRepositoryPath(root, 'src/a.js'), join('src', 'a.js'));
  assert.equal(resolveRepositoryPath(root, join(root, 'src/a.js')), join('src', 'a.js'));
  assert.throws(
    () => resolveRepositoryPath(root, '../elsewhere'),
    (error) => error.code === 'PROJECT_OUTSIDE_ROOT' && error.status === 403,
  );
  assert.throws(() => resolveRepositoryPath(root, '.git/config'), (error) => error.code === 'GIT_INVALID_PATH');
});

// =================================================== a real repository, read

test('status reads branch, upstream, remote and a clean tree from a real repo', async () => {
  const { base, remote, repo, git: seam } = await world();
  try {
    const status = await seam.status(repo);
    assert.equal(status.repo, true);
    assert.equal(status.usable, true);
    assert.equal(status.blocked, null);
    assert.equal(status.branch, 'main');
    assert.equal(status.detached, false);
    assert.equal(status.upstream, 'origin/main');
    assert.equal(status.remote.name, 'origin');
    assert.equal(status.remote.url, remote);
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);
    assert.equal(status.clean, true);
    assert.deepEqual(
      status.files.map((file) => file.path),
      [],
    );
    assert.equal(status.lastCommit.subject, 'initial');
    assert.equal(status.counts.files, 0);
    assert.equal(status.inProgress, null);
  } finally {
    await cleanup(base);
  }
});

test('status lists modified, staged and untracked files with their line counts', async () => {
  const { base, repo, git: seam } = await world();
  try {
    await writeFile(join(repo, 'README.md'), '# demo\nligne 2\nligne 3\n');
    await writeFile(join(repo, 'notes.txt'), 'nouveau\n');
    const staged = join(repo, 'staged.txt');
    await writeFile(staged, 'contenu\n');
    await git(['add', '--', 'staged.txt'], repo);

    const status = await seam.status(repo);
    assert.equal(status.clean, false);
    assert.equal(status.dirty, true);
    assert.equal(status.counts.files, 3);
    assert.equal(status.counts.untracked, 1);
    assert.equal(status.counts.staged, 1);
    assert.equal(status.counts.unstaged, 1);

    const readme = status.files.find((file) => file.path === 'README.md');
    assert.equal(readme.kind, 'modified');
    assert.equal(readme.added, 2);
    assert.equal(readme.removed, 0);
    const notes = status.files.find((file) => file.path === 'notes.txt');
    assert.equal(notes.kind, 'untracked');
    assert.equal(notes.added, null, 'an untracked file has no diff against HEAD yet');
    assert.equal(status.files.find((file) => file.path === 'staged.txt').staged, true);
  } finally {
    await cleanup(base);
  }
});

test('a diff of a selected file is readable, staged or not, binary included', async () => {
  const { base, repo, git: seam } = await world();
  try {
    await writeFile(join(repo, 'README.md'), '# demo\nligne 2\n');
    await writeFile(join(repo, 'nouveau.txt'), 'bonjour\n');
    await git(['add', '--', 'README.md'], repo);

    const staged = await seam.diff(repo, { path: 'README.md', area: 'index' });
    assert.equal(staged.area, 'index');
    assert.match(staged.text, /\+ligne 2/);
    assert.equal(staged.binary, false);
    assert.equal(staged.truncated, false);

    const untracked = await seam.diff(repo, { path: 'nouveau.txt', area: 'work' });
    assert.match(untracked.text, /nouveau\.txt/);
    assert.match(untracked.text, /\+bonjour/);

    // A path outside the root never reaches Git.
    await assert.rejects(
      seam.diff(repo, { path: '../outside.txt' }),
      (error) => error.code === 'PROJECT_OUTSIDE_ROOT',
    );
  } finally {
    await cleanup(base);
  }
});

// ================================================= a real repository, write

test('a commit records only the selected files, with the user message', async () => {
  const { base, repo, git: seam } = await world();
  try {
    await writeFile(join(repo, 'README.md'), '# demo\nmodifié\n');
    await writeFile(join(repo, 'autre.txt'), 'autre\n');
    await writeFile(join(repo, 'garde.txt'), 'garde\n');
    await git(['add', '--', 'garde.txt'], repo);

    const before = await commitCount(repo);
    const result = await seam.commit(repo, { message: 'étape choisie', paths: ['README.md', 'autre.txt'] });
    assert.equal(result.ok, true);
    assert.equal(result.commit.subject, 'étape choisie');
    assert.equal(await commitCount(repo), before + 1);
    assert.equal(await subject(repo), 'étape choisie');

    // The selected files are committed; the unselected one is not.
    const status = await seam.status(repo);
    assert.equal(status.files.some((file) => file.path === 'README.md'), false);
    assert.equal(status.files.some((file) => file.path === 'autre.txt'), false);
    assert.equal(
      status.files.find((file) => file.path === 'garde.txt').staged,
      true,
      'a change staged outside the selection stays staged and uncommitted',
    );
  } finally {
    await cleanup(base);
  }
});

test('an empty selection or an empty message never reaches Git', async () => {
  const { base, repo, git: seam } = await world();
  try {
    await writeFile(join(repo, 'README.md'), '# demo\nmodifié\n');
    await assert.rejects(
      seam.commit(repo, { message: 'x', paths: [] }),
      (error) => error.code === 'GIT_NO_PATHS',
    );
    await assert.rejects(
      seam.commit(repo, { message: '   ', paths: ['README.md'] }),
      (error) => error.code === 'GIT_MESSAGE_REQUIRED',
    );
    await assert.rejects(
      seam.commit(repo, { message: 'x', paths: ['../escape.txt'] }),
      (error) => error.code === 'PROJECT_OUTSIDE_ROOT',
    );
    assert.equal(await subject(repo), 'initial', 'nothing was committed');
  } finally {
    await cleanup(base);
  }
});

test('a normal push reaches the bare remote, and a forced push is impossible', async () => {
  const { base, remote, repo, git: seam } = await world();
  try {
    await writeFile(join(repo, 'README.md'), '# demo\npoussé\n');
    await seam.commit(repo, { message: 'à envoyer', paths: ['README.md'] });
    const pushed = await seam.push(repo);
    assert.equal(pushed.ok, true);
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.remote.name, 'origin');
    assert.equal(pushed.status.ahead, 0);
    // The remote really has it.
    assert.equal((await git(['show', '-s', '--format=%s', 'refs/heads/main'], remote)).trim(), 'à envoyer');

    // Now diverge both sides, and prove a push is refused rather than forced.
    const other = join(base, 'other');
    await git(['clone', '-q', remote, other], base);
    await git(['config', 'user.email', 'other@test.invalid'], other);
    await git(['config', 'user.name', 'Other'], other);
    await writeFile(join(other, 'README.md'), '# demo\npoussé\ndistant\n');
    await git(['commit', '-qam', 'distant'], other);
    await git(['push', '-q', 'origin', 'main'], other);

    await writeFile(join(repo, 'README.md'), '# demo\npoussé\nlocal\n');
    await seam.commit(repo, { message: 'local', paths: ['README.md'] });
    await assert.rejects(
      seam.push(repo),
      (error) => error.code === 'GIT_PUSH_REJECTED' && error.status === 409,
    );
    assert.equal(
      (await git(['show', '-s', '--format=%s', 'refs/heads/main'], remote)).trim(),
      'distant',
      'the rejected push left the remote exactly where it was',
    );
  } finally {
    await cleanup(base);
  }
});

test('fetch reads the remote, and a fast-forward update is the only update', async () => {
  const { base, remote, repo, git: seam } = await world();
  try {
    const other = join(base, 'other');
    await git(['clone', '-q', remote, other], base);
    await git(['config', 'user.email', 'other@test.invalid'], other);
    await git(['config', 'user.name', 'Other'], other);
    await writeFile(join(other, 'README.md'), '# demo\ndistant\n');
    await git(['commit', '-qam', 'distant'], other);
    await git(['push', '-q', 'origin', 'main'], other);

    const fetched = await seam.fetch(repo);
    assert.equal(fetched.fetched, true);
    assert.equal(fetched.status.behind, 1);
    assert.equal(fetched.status.ahead, 0);
    assert.equal(fetched.status.fastForward, true);
    assert.equal(await read(join(repo, 'README.md')), '# demo\n', 'fetch did not touch the working copy');

    const before = await commitCount(repo);
    const updated = await seam.pull(repo);
    assert.equal(updated.updated, true);
    assert.equal(updated.alreadyUpToDate, false);
    assert.equal(updated.status.behind, 0);
    assert.equal(await read(join(repo, 'README.md')), '# demo\ndistant\n');
    assert.equal(await commitCount(repo), before + 1, 'a fast-forward adds the remote commit, no merge commit');
    assert.equal((await git(['rev-list', '--parents', '-n', '1', 'HEAD'], repo)).trim().split(' ').length, 2);

    // Already up to date is an answer, not an error, and changes nothing.
    const again = await seam.pull(repo);
    assert.equal(again.updated, false);
    assert.equal(again.alreadyUpToDate, true);
  } finally {
    await cleanup(base);
  }
});

test('a divergence is refused and leaves the local copy untouched', async () => {
  const { base, remote, repo, git: seam } = await world();
  try {
    const other = join(base, 'other');
    await git(['clone', '-q', remote, other], base);
    await git(['config', 'user.email', 'other@test.invalid'], other);
    await git(['config', 'user.name', 'Other'], other);
    await writeFile(join(other, 'README.md'), '# demo\ndistant\n');
    await git(['commit', '-qam', 'distant'], other);
    await git(['push', '-q', 'origin', 'main'], other);

    await writeFile(join(repo, 'README.md'), '# demo\nlocal\n');
    await seam.commit(repo, { message: 'local', paths: ['README.md'] });
    const head = (await git(['rev-parse', 'HEAD'], repo)).trim();
    const content = await read(join(repo, 'README.md'));

    // The divergence is only knowable after the remote has been read, which is
    // exactly why the interface fetches before it offers an update.
    await seam.fetch(repo);
    const status = await seam.status(repo);
    assert.equal(status.diverged, true);
    assert.equal(status.ahead, 1);
    assert.equal(status.behind, 1);
    assert.equal(status.fastForward, false);

    await assert.rejects(seam.pull(repo), (error) => error.code === 'GIT_DIVERGED' && error.status === 409);
    assert.equal((await git(['rev-parse', 'HEAD'], repo)).trim(), head, 'HEAD did not move');
    assert.equal(await read(join(repo, 'README.md')), content, 'the file did not change');
    assert.equal(await commitCount(repo), 2, 'no merge commit was created');
  } finally {
    await cleanup(base);
  }
});

test('a conflict and an in-progress merge are refused without touching the copy', async () => {
  const { base, repo, git: seam } = await world();
  try {
    await writeFile(join(repo, 'README.md'), '# demo\nbranche\n');
    await git(['checkout', '-q', '-b', 'side'], repo);
    await git(['commit', '-qam', 'side'], repo);
    await git(['checkout', '-q', 'main'], repo);
    await writeFile(join(repo, 'README.md'), '# demo\nmain\n');
    await git(['commit', '-qam', 'main'], repo);
    await assert.rejects(git(['merge', 'side'], repo), 'the merge is expected to conflict');

    const status = await seam.status(repo);
    assert.equal(status.conflicted, true);
    assert.equal(status.counts.conflicted, 1);
    assert.equal(status.inProgress, 'merge');
    const head = (await git(['rev-parse', 'HEAD'], repo)).trim();

    await assert.rejects(
      seam.commit(repo, { message: 'x', paths: ['README.md'] }),
      (error) => error.code === 'GIT_OPERATION_IN_PROGRESS' && error.status === 409,
    );
    await assert.rejects(seam.pull(repo), (error) => error.code === 'GIT_OPERATION_IN_PROGRESS');
    await assert.rejects(seam.push(repo), (error) => error.code === 'GIT_OPERATION_IN_PROGRESS');
    await assert.rejects(seam.fetch(repo), (error) => error.code === 'GIT_OPERATION_IN_PROGRESS');
    assert.equal((await git(['rev-parse', 'HEAD'], repo)).trim(), head, 'HEAD never moved');
  } finally {
    await cleanup(base);
  }
});

test('a dirty working tree blocks the update instead of risking a loss', async () => {
  const { base, remote, repo, git: seam } = await world();
  try {
    const other = join(base, 'other');
    await git(['clone', '-q', remote, other], base);
    await git(['config', 'user.email', 'other@test.invalid'], other);
    await git(['config', 'user.name', 'Other'], other);
    await writeFile(join(other, 'README.md'), '# demo\ndistant\n');
    await git(['commit', '-qam', 'distant'], other);
    await git(['push', '-q', 'origin', 'main'], other);

    await writeFile(join(repo, 'README.md'), '# demo\nen cours\n');
    await assert.rejects(seam.pull(repo), (error) => error.code === 'GIT_WORKTREE_DIRTY');
    assert.equal(await read(join(repo, 'README.md')), '# demo\nen cours\n');
  } finally {
    await cleanup(base);
  }
});

// ============================================================ the refusals

test('a project that is not a repository is answered, not raised', async () => {
  const base = await directory('git-plain');
  try {
    const seam = new ProjectGit();
    const status = await seam.status(base);
    assert.equal(status.repo, false);
    assert.equal(status.usable, false);
    assert.equal(status.blocked, null);
    assert.equal(status.reason, 'not-a-repository');
    await assert.rejects(
      seam.commit(base, { message: 'x', paths: ['a.txt'] }),
      (error) => error.code === 'GIT_NOT_A_REPOSITORY' && error.status === 409,
    );
    await assert.rejects(seam.fetch(base), (error) => error.code === 'GIT_NOT_A_REPOSITORY');
  } finally {
    await cleanup(base);
  }
});

test('a project inside a bigger repository is refused by the exact-root fence', async () => {
  const base = await directory('git-nested-above');
  try {
    await initRepo(base);
    const inner = join(base, 'packages', 'app');
    await mkdir(inner, { recursive: true });
    await writeFile(join(inner, 'index.js'), 'export default 1;\n');
    const seam = new ProjectGit();
    const status = await seam.status(inner);
    assert.equal(status.repo, true);
    assert.equal(status.usable, false);
    assert.equal(status.blocked.code, 'GIT_ROOT_MISMATCH');
    assert.ok(status.blocked.message.includes(base), 'the message names the real repository root');
    await assert.rejects(seam.commit(inner, { message: 'x', paths: ['index.js'] }), (error) => {
      return error.code === 'GIT_ROOT_MISMATCH' && error.status === 409;
    });
  } finally {
    await cleanup(base);
  }
});

test('a nested repository is detected and refused, explicitly', async () => {
  const { base, repo, git: seam } = await world();
  try {
    const nested = join(repo, 'inner');
    await mkdir(nested, { recursive: true });
    await git(['init', '-q', '-b', 'main', '.'], nested);
    assert.equal(await findNestedRepository(repo), 'inner');

    const status = await seam.status(repo);
    assert.equal(status.usable, false);
    assert.equal(status.blocked.code, 'GIT_NESTED_REPOSITORY');
    await assert.rejects(
      seam.commit(repo, { message: 'x', paths: ['README.md'] }),
      (error) => error.code === 'GIT_NESTED_REPOSITORY',
    );
    await assert.rejects(seam.push(repo), (error) => error.code === 'GIT_NESTED_REPOSITORY');
  } finally {
    await cleanup(base);
  }
});

test('a submodule is refused, both as a superproject and as a real gitlink', async () => {
  const { base, remote, repo, git: seam } = await world();
  try {
    // A real submodule, added with the file protocol allowed for the test.
    await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', remote, 'sub'], repo);
    await git(['commit', '-q', '-m', 'add submodule'], repo);

    const status = await seam.status(repo);
    assert.equal(status.repo, true);
    assert.equal(status.usable, false);
    assert.equal(status.blocked.code, 'GIT_SUBMODULE_UNSUPPORTED');
    await assert.rejects(seam.fetch(repo), (error) => error.code === 'GIT_SUBMODULE_UNSUPPORTED');

    // And a project whose root *is* the submodule is refused too.
    const sub = join(repo, 'sub');
    const inner = await seam.status(sub);
    assert.equal(inner.usable, false);
    assert.equal(inner.blocked.code, 'GIT_SUBMODULE_UNSUPPORTED');
  } finally {
    await cleanup(base);
  }
});

// ============================================================ the service

/**
 * A stand-in for `ctx.connection`, capturing the routes a plugin registers.
 */
function fakeConnection() {
  const routes = new Map();
  return {
    routes,
    fetch: {
      register(route) {
        assert.ok(route.path.startsWith('/api/'), 'a NewPi endpoint lives under /api/');
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
}

/**
 * Seed the registry the service will load, so a launch project carries the
 * capabilities a test wants. The browser cannot set capabilities, so this is
 * the same door a person or a future settings surface would use: the record on
 * disk.
 *
 * @param stateDir - where `projects.json` lives.
 * @param project - the record to store as current.
 */
async function seedRegistry(stateDir, project) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, 'projects.json'),
    `${JSON.stringify(
      { version: 1, currentId: project.id, recent: [project.id], projects: { [project.id]: project } },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/**
 * Boot the Project Model on a real Cordis context.
 *
 * @param options - the launch facts, the seams, and an optional Git runner.
 * @returns the context, the service, the connection and the fake workspace.
 */
async function boot(options) {
  const { Context } = await import(pathToFileURL(harnessPath('@deepseek-ai/cordis/lib/index.js')));
  const ctx = new Context();
  const connection = fakeConnection();
  ctx.provide('connection', connection);
  ctx.provide('contextCache', {
    bound: null,
    bindProject(project) {
      this.bound = project;
      return project;
    },
    unbindProject() {
      this.bound = null;
    },
    project: () => null,
    versions: () => null,
    cacheStats: () => null,
  });
  const workspaces = new Map();
  ctx.provide('workspaceRegistry', {
    async create(path, title) {
      const workspace = { id: `ws-${workspaces.size + 1}`, path, title, async attachSession() {} };
      workspaces.set(path, workspace);
      return workspace;
    },
    get: (id) => [...workspaces.values()].find((workspace) => workspace.id === id),
    async resolveByPath(path) {
      return workspaces.get(path);
    },
  });
  ctx.provide('sessions', { list: () => [] });

  const { apply } = await import(new URL('plugins/project-model/index.js', ROOT));
  apply(ctx, {
    stateDir: options.stateDir,
    workspace: options.workspace,
    projectId: options.projectId,
    name: options.name ?? '',
    memoryNamespace: options.memoryNamespace ?? '',
    appId: options.appId ?? '',
    appBundle: options.appBundle ?? '',
    gitRun: options.gitRun,
    announce: false,
  });
  const model = ctx.get('projectModel');
  assert.ok(model, 'the plugin must register ctx.projectModel');
  await model.ready();
  return { ctx, model, connection };
}

/** The project endpoint a boot produced, as `{status, body}` calls. */
function endpoint(connection) {
  const route = connection.routes.get('/api/newpi.project');
  assert.ok(route, 'the authenticated project endpoint must be registered');
  return async (action, params) => {
    const response = await route.fetch(
      new Request('http://127.0.0.1/api/newpi.project', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, params }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
}

test('the Project Model refuses a change, a removal and a relaunch during a Git action', async () => {
  const { base, repo } = await world();
  const state = await directory('state');
  const other = join(base, 'other');
  await initRepo(other);
  try {
    let release = null;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let entered = null;
    const enteredPromise = new Promise((resolve) => {
      entered = resolve;
    });
    // A Git runner that is genuinely slow: the guard must hold for its whole
    // duration, not merely for a synchronous hop.
    const gitRun = async (args, options) => {
      if (args[0] === 'status') {
        entered();
        await held;
      }
      return runGit(args, options);
    };

    const { model } = await boot({
      workspace: repo,
      stateDir: state,
      projectId: 'gitproject',
      name: 'Git Project',
      appId: 'com.newpi.test',
      appBundle: '/Applications/NewPi.app',
      gitRun,
    });
    await model.create({ id: 'other', name: 'Other', rootPath: other });

    const running = model.gitStatus();
    await enteredPromise;
    assert.equal(model.operations().length, 1);
    assert.equal(model.operations()[0].kind, 'git');
    await assert.rejects(model.open('other'), (error) => error.code === 'PROJECT_BUSY');
    await assert.rejects(model.forget('other'), (error) => error.code === 'PROJECT_BUSY');
    await assert.rejects(model.restart(), (error) => error.code === 'PROJECT_BUSY');
    assert.equal(model.currentProject.id, 'gitproject', 'the refusal changed nothing');

    release();
    const status = await running;
    assert.equal(status.repo, true);
    assert.equal(model.operations().length, 0);
    assert.equal((await model.open('other')).id, 'other');
  } finally {
    await cleanup(base);
    await rm(state, { recursive: true, force: true });
  }
});

test('the endpoint exposes the six Git actions and no forced one', async () => {
  const { base, remote, repo } = await world();
  const state = await directory('state');
  try {
    // The remote half of the zone needs `network` on top of `git`; the record
    // is the only door a browser cannot open itself.
    await seedRegistry(state, {
      id: 'gitproject',
      name: 'Git Project',
      rootPath: repo,
      settings: { capabilities: { git: true, network: true } },
    });
    const { model, connection } = await boot({ workspace: repo, stateDir: state, projectId: 'gitproject' });
    await settle();
    const call = endpoint(connection);

    const status = await call('project.git.status', {});
    assert.equal(status.status, 200);
    assert.equal(status.body.value.repo, true);
    assert.equal(status.body.value.branch, 'main');
    assert.equal(status.body.value.networkAllowed, true);

    await writeFile(join(repo, 'README.md'), '# demo\nendpoint\n');
    const diff = await call('project.git.diff', { path: 'README.md', area: 'work' });
    assert.equal(diff.status, 200);
    assert.match(diff.body.value.text, /\+endpoint/);

    const committed = await call('project.git.commit', { message: 'via endpoint', paths: ['README.md'] });
    assert.equal(committed.status, 200);
    assert.equal(committed.body.value.commit.subject, 'via endpoint');

    const pushed = await call('project.git.push', {});
    assert.equal(pushed.status, 200);
    assert.equal(pushed.body.value.pushed, true);
    assert.equal(pushed.body.value.status.lastSync.kind, 'push');

    const fetched = await call('project.git.fetch', {});
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.value.fetched, true);
    assert.equal(fetched.body.value.status.lastSync.kind, 'fetch');
    assert.equal((await git(['show', '-s', '--format=%s', 'refs/heads/main'], remote)).trim(), 'via endpoint');

    const pulled = await call('project.git.pull', {});
    assert.equal(pulled.status, 200);
    assert.equal(pulled.body.value.alreadyUpToDate, true);
    assert.equal(
      pulled.body.value.status.lastSync.kind,
      'fetch',
      'a pull that only reads the remote records no update of its own',
    );

    // No action declares a force, a remote, a refspec or a branch.
    for (const params of [
      { force: true },
      { remote: 'origin' },
      { refspec: 'refs/heads/main:refs/heads/main' },
      { branch: 'main' },
      { hard: true },
    ]) {
      for (const action of [
        'project.git.status',
        'project.git.fetch',
        'project.git.push',
        'project.git.pull',
        'project.git.commit',
        'project.git.diff',
      ]) {
        const refused = await call(action, { ...params, message: 'x', paths: ['README.md'] });
        assert.equal(refused.status, 400, `${action} must refuse ${JSON.stringify(params)}`);
        assert.equal(refused.body.error.code, 'PROJECT_INVALID_ARGS');
      }
    }
  } finally {
    await cleanup(base);
    await rm(state, { recursive: true, force: true });
  }
});

test('the git capability gates all six actions, and network alone does not open them', async () => {
  const { base, repo } = await world();
  const state = await directory('state');
  const lockedRoot = join(base, 'locked-repo');
  await initRepo(lockedRoot);
  try {
    // `network` is granted, `git` is not: the remote grant must not unlock the
    // local verbs, and the local gate must cover every one of the six.
    const { model, connection } = await boot({ workspace: repo, stateDir: state, projectId: 'gitproject' });
    await model.create({
      id: 'locked',
      name: 'Locked',
      rootPath: lockedRoot,
      settings: { capabilities: { git: false, network: true } },
    });
    await model.open('locked');
    await settle();
    const call = endpoint(connection);

    const perAction = {
      'project.git.status': {},
      'project.git.diff': { path: 'README.md' },
      'project.git.commit': { message: 'x', paths: ['README.md'] },
      'project.git.fetch': {},
      'project.git.push': {},
      'project.git.pull': {},
    };
    for (const [action, params] of Object.entries(perAction)) {
      const refused = await call(action, params);
      assert.equal(refused.status, 403, `${action} must be refused without git`);
      assert.equal(refused.body.error.code, 'PROJECT_CAPABILITY_DENIED');
    }
  } finally {
    await cleanup(base);
    await rm(state, { recursive: true, force: true });
  }
});

test('the remote actions need network in addition to git, and the local ones do not', async () => {
  const { base, repo } = await world();
  const state = await directory('state');
  const localRoot = join(base, 'local-repo');
  await initRepo(localRoot);
  try {
    // The launch project takes the defaults: git yes, network no.
    const { model, connection } = await boot({ workspace: repo, stateDir: state, projectId: 'gitproject' });
    await settle();
    const call = endpoint(connection);

    const status = await call('project.git.status', {});
    assert.equal(status.status, 200, 'status is local and stays allowed');
    assert.equal(status.body.value.networkAllowed, false);

    await writeFile(join(repo, 'README.md'), '# demo\nlocal seulement\n');
    const diff = await call('project.git.diff', { path: 'README.md', area: 'work' });
    assert.equal(diff.status, 200, 'a diff is local and stays allowed');
    const committed = await call('project.git.commit', { message: 'local', paths: ['README.md'] });
    assert.equal(committed.status, 200, 'a local commit stays allowed');
    assert.equal(committed.body.value.status.networkAllowed, false);

    for (const action of ['project.git.fetch', 'project.git.push', 'project.git.pull']) {
      const refused = await call(action, {});
      assert.equal(refused.status, 403, `${action} must require network`);
      assert.equal(refused.body.error.code, 'GIT_NETWORK_DENIED');
      assert.match(refused.body.error.message, /Réseau/, 'the message names the capability to allow');
    }
    // The service refuses before Git runs, so nothing reached the remote.
    assert.equal((await git(['show', '-s', '--format=%s', 'refs/heads/main'], base + '/remote.git')).trim(), 'initial');

    // With network granted on another project, the same verbs pass the gate and
    // reach Git: the repository has no remote, so the failure is Git's own.
    await model.create({
      id: 'wired',
      name: 'Wired',
      rootPath: localRoot,
      settings: { capabilities: { git: true, network: true } },
    });
    await model.open('wired');
    assert.equal((await call('project.git.status', {})).body.value.networkAllowed, true);
    const wiredFetch = await call('project.git.fetch', {});
    assert.equal(wiredFetch.status, 409);
    assert.equal(
      wiredFetch.body.error.code,
      'GIT_NO_REMOTE',
      'the network gate opened: the refusal now comes from Git, not from a capability',
    );
  } finally {
    await cleanup(base);
    await rm(state, { recursive: true, force: true });
  }
});

test('the status action answers "no repository" calmly on a plain directory', async () => {
  const base = await directory('git-plain-service');
  const state = await directory('state');
  try {
    const { connection } = await boot({ workspace: base, stateDir: state, projectId: 'plain' });
    await settle();
    const call = endpoint(connection);
    const status = await call('project.git.status', {});
    assert.equal(status.status, 200);
    assert.equal(status.body.value.repo, false);
    const commit = await call('project.git.commit', { message: 'x', paths: ['a.txt'] });
    assert.equal(commit.status, 409);
    assert.equal(commit.body.error.code, 'GIT_NOT_A_REPOSITORY');
  } finally {
    await cleanup(base);
    await rm(state, { recursive: true, force: true });
  }
});

test('every argv the seam produces is on the safe list', async () => {
  const { base, repo } = await world();
  const state = await directory('state');
  try {
    const calls = [];
    const gitRun = async (args, options) => {
      // The real runner asserts too, but recording here proves what the seam
      // asked for, not only what survived.
      calls.push([...args]);
      return runGit(args, options);
    };
    await seedRegistry(state, {
      id: 'gitproject',
      name: 'Git Project',
      rootPath: repo,
      settings: { capabilities: { git: true, network: true } },
    });
    const { model } = await boot({ workspace: repo, stateDir: state, projectId: 'gitproject', gitRun });
    await model.gitStatus();
    await writeFile(join(repo, 'README.md'), '# demo\nargv\n');
    await model.gitDiff('README.md', 'work');
    await model.gitCommit({ message: 'argv', paths: ['README.md'] });
    await model.gitFetch();
    await model.gitPush();
    await model.gitPull();

    assert.ok(calls.length > 10, 'the seam should have run several commands');
    const allowed = new Set([
      'rev-parse',
      'status',
      'diff',
      'ls-files',
      'show',
      'remote',
      'add',
      'commit',
      'fetch',
      'push',
      'merge',
    ]);
    for (const argv of calls) {
      assertSafeGitArgs(argv);
      assert.ok(allowed.has(argv[0]), `unexpected verb ${argv[0]}`);
      assert.ok(!argv.some((token) => token === '--force' || token === '-f'), `forbidden token in ${argv.join(' ')}`);
      if (argv[0] === 'merge') assert.ok(argv.includes('--ff-only'), 'the only merge is --ff-only');
      if (argv[0] === 'remote') assert.ok(argv[1] === undefined || argv[1] === 'get-url', 'remote is read only');
    }
    const verbs = new Set(calls.map((argv) => argv[0]));
    // The verbs the run really needs, whatever else it happens to read.
    for (const verb of ['add', 'commit', 'diff', 'fetch', 'push', 'rev-parse', 'status']) {
      assert.ok(verbs.has(verb), `the seam never ran git ${verb}`);
    }
  } finally {
    await cleanup(base);
    await rm(state, { recursive: true, force: true });
  }
});

test('the capability action opens and closes the remote half of the Git zone', async () => {
  const { base, repo, remote } = await world();
  const state = await directory('state');
  try {
    // The launch project takes the defaults: git yes, network no.
    const { model, connection } = await boot({ workspace: repo, stateDir: state, projectId: 'gitproject' });
    await settle();
    const call = endpoint(connection);

    const refusedBefore = await call('project.git.fetch', {});
    assert.equal(refusedBefore.status, 403);
    assert.equal(refusedBefore.body.error.code, 'GIT_NETWORK_DENIED');
    assert.equal((await call('project.git.status', {})).body.value.networkAllowed, false);

    // The interface asks for exactly one capability, by name, on the open
    // project. Granting it is what the Git zone reads.
    const granted = await call('project.capability.set', {
      name: 'network',
      allowed: true,
      confirm: true,
    });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.value.settings.capabilities.network, true);
    assert.equal((await call('project.git.status', {})).body.value.networkAllowed, true);

    // The gate is open now: fetch reaches Git and succeeds against the
    // isolated bare remote, and the remote really receives nothing new.
    const fetched = await call('project.git.fetch', {});
    assert.equal(fetched.status, 200, 'the remote half must be available once network is granted');
    assert.equal(fetched.body.value.fetched, true);
    assert.equal(fetched.body.value.status.networkAllowed, true);

    // Local work is untouched by the grant, and so is removing it: the two
    // remote verbs are refused again, and the local ones keep working.
    await writeFile(join(repo, 'README.md'), '# demo\nréseau retiré\n');
    const revoked = await call('project.capability.set', {
      name: 'network',
      allowed: false,
      confirm: true,
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.value.settings.capabilities.network, false);
    assert.equal((await call('project.git.status', {})).body.value.networkAllowed, false);

    for (const action of ['project.git.fetch', 'project.git.push', 'project.git.pull']) {
      const refused = await call(action, {});
      assert.equal(refused.status, 403, `${action} must be refused again`);
      assert.equal(refused.body.error.code, 'GIT_NETWORK_DENIED');
    }
    const committed = await call('project.git.commit', { message: 'local', paths: ['README.md'] });
    assert.equal(committed.status, 200, 'the local half stays available');
    assert.equal(committed.body.value.status.networkAllowed, false);

    // The grant is gone from the registry too, so a fresh service agrees.
    const reloaded = await boot({ workspace: repo, stateDir: state, projectId: 'gitproject' });
    assert.equal(reloaded.model.currentProject.settings.capabilities.network, false);
    assert.equal(reloaded.model.currentProject.rootPath, repo);
    assert.ok(remote.endsWith('remote.git'));
  } finally {
    await cleanup(base);
    await rm(state, { recursive: true, force: true });
  }
});
