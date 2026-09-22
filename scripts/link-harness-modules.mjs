#!/usr/bin/env node
/**
 * Copy the harness packages this repository's tests run against.
 *
 * The memory plugins are *profile plugins*: the harness loads them and resolves
 * `@deepseek-ai/cordis` from the harness's own module tree. The deployed copies
 * get that tree from a `node_modules` link NewPi creates beside them (see
 * `link_module_tree` in `src-tauri/src/memory.rs`), but a checkout has no such
 * link, so `node --test tests/` would fail on the first import.
 *
 * This script copies the packages, and the dependencies they resolve, into the
 * checkout — nothing is installed. It runs from `pnpm install`, and copies the
 * whole closure every time, which costs about 150ms for a megabyte.
 *
 * They must be *copies*, not symlinks to the installed harness. pnpm treats a
 * package directory that is a symlink as its own to repair: on the next
 * `pnpm install` it chmods the linked entry point to bin-link it, and a link
 * that leaves the project cannot be written through, so the install dies with
 * `EPERM: operation not permitted, chmod .../@deepseek-ai/cordis/bin.js` and
 * exit 255. Real directories inside the project install cleanly, every time.
 *
 * Tests also read a harness package directly (`@deepseek-ai/dsh-tools`) so the
 * tool definitions are checked against the very assertions the registry uses,
 * which is what keeps a schema mistake from passing here and failing at boot.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Packages the plugins and their tests import. */
const PACKAGES = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools'];

/**
 * Candidate harness module trees, most authoritative first.
 *
 * The profile tree is what the running harness uses, so it is tried first; the
 * install tree is the fallback for a machine that has never booted a profile.
 *
 * @returns the candidate directories.
 */
function moduleTrees() {
  return [
    process.env.DSH_PROFILE_MODULES,
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', 'node_modules') : undefined,
    process.env.HOME ? join(process.env.HOME, '.dsh', 'profiles', 'node_modules') : undefined,
    process.env.HOME
      ? join(process.env.HOME, '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules')
      : undefined,
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
}

/**
 * Find a tree that contains every package.
 *
 * @returns the tree, or `undefined` when the harness is not installed.
 */
function harnessTree() {
  for (const tree of moduleTrees()) {
    if (PACKAGES.every((name) => existsSync(join(tree, name)))) return tree;
  }
  return undefined;
}

const tree = harnessTree();
if (tree === undefined) {
  // Not a failure: `pnpm install` must work on a machine that has no harness,
  // and only the memory tests need one. They fail with their own message.
  console.log('newpi: no engine install found; the memory tests will be skipped');
  process.exit(0);
}

const target = join(ROOT, 'node_modules', '@deepseek-ai');
mkdirSync(target, { recursive: true });

/**
 * The copy of a package, inside the destination scope directory.
 *
 * @param name the package name, scoped or not.
 * @returns its path under `node_modules/@deepseek-ai`.
 */
function copyPath(name) {
  return join(target, ...name.split('/').slice(1));
}

/**
 * The installed directory of a package, in this checkout first.
 *
 * Resolution starts from the checkout so a dependency already present in the
 * project wins, and falls back to the harness tree.
 *
 * The destination is never a source. On a second run — a second `pnpm install`,
 * which is ordinary — the copy this script made last time is what resolution
 * finds first in the checkout, and the loop below deletes the destination
 * before reading it. That left an empty directory behind and five suites
 * failing on a module that had been copied correctly a moment earlier. A run
 * that copies nothing is worse than a run that fails, because nothing says so.
 *
 * @param name the package name.
 * @returns its directory, or `undefined` when it is nowhere to be found.
 */
function sourceOf(name) {
  const require = createRequire(join(ROOT, 'noop.js'));
  for (const from of [ROOT, tree]) {
    try {
      const found = dirname(require.resolve(`${name}/package.json`, { paths: [from] }));
      if (found !== target && !found.startsWith(`${target}${sep}`)) return found;
    } catch {
      // Not here; try the next root.
    }
  }
  return undefined;
}

/**
 * A package's dependencies that are packages themselves.
 *
 * @param source the package directory.
 * @returns the bare names it needs.
 */
function dependenciesOf(source) {
  const manifest = join(source, 'package.json');
  const declared = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : {};
  return [...Object.keys(declared.dependencies ?? {}), ...Object.keys(declared.optionalDependencies ?? {})].filter(
    (name) => !name.startsWith('.') && !isAbsolute(name),
  );
}

/** Every package to copy: the three entries plus everything they resolve. */
const closure = new Set(PACKAGES);
const queue = [...PACKAGES];
while (queue.length > 0) {
  const name = queue.shift();
  const source = sourceOf(name);
  if (source === undefined) continue;
  for (const dependency of dependenciesOf(source)) {
    if (closure.has(dependency)) continue;
    closure.add(dependency);
    queue.push(dependency);
  }
}

let copied = 0;
for (const name of closure) {
  const source = sourceOf(name);
  if (source === undefined) {
    // An optional dependency that is not installed in the harness tree.
    continue;
  }
  const dest = copyPath(name);
  // Copy every time rather than keeping the previous copy. The whole closure
  // is about a megabyte and copying it takes ~150ms, which a `pnpm install`
  // will never miss — and a copy compared against its own earlier signature
  // could report itself current without really being so.
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(source)) {
    // The harness's own tree is a flat install: a nested copy would only
    // duplicate packages that this loop already places at the root.
    if (entry === 'node_modules') continue;
    cpSync(join(source, entry), join(dest, entry), { recursive: true, dereference: true });
  }
  copied += 1;
}

console.log(
  copied === 0
    ? `newpi: no harness modules to copy from ${tree}`
    : `newpi: copied ${copied} harness module(s) from ${tree}`,
);
