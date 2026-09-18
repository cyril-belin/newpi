#!/usr/bin/env node
/**
 * Link the harness packages this repository's tests run against.
 *
 * The memory plugins are *profile plugins*: the harness loads them and resolves
 * `@deepseek-ai/cordis` from the harness's own module tree. The deployed copies
 * get that tree from a `node_modules` link NewPi creates beside them (see
 * `link_module_tree` in `src-tauri/src/memory.rs`), but a checkout has no such
 * link, so `node --test tests/` would fail on the first import.
 *
 * This script creates the same links in the checkout, as symlinks to whatever
 * harness is installed — nothing is copied and nothing is installed. It is
 * idempotent, runs from `pnpm install`, and is a no-op once the links exist.
 *
 * Tests also read a harness package directly (`@deepseek-ai/dsh-tools`) so the
 * tool definitions are checked against the very assertions the registry uses,
 * which is what keeps a schema mistake from passing here and failing at boot.
 */

import { existsSync, mkdirSync, symlinkSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

let linked = 0;
for (const name of PACKAGES) {
  const link = join(target, name.split('/').pop());
  const source = join(tree, name);
  if (existsSync(link)) {
    if (existsSync(join(link, 'package.json'))) continue;
    // A broken link, from a harness that moved: replace it.
  }
  try {
    readlinkSync(link);
  } catch {
    // Not a link and not usable: leave whatever is there alone.
    if (existsSync(link)) continue;
  }
  symlinkSync(source, link);
  linked += 1;
}

console.log(
  linked === 0
    ? `newpi: harness modules already linked from ${tree}`
    : `newpi: linked ${linked} harness module(s) from ${tree}`,
);
