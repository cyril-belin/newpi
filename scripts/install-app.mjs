// Installs the freshly built NewPi bundle into /Applications and leaves
// exactly one copy of the application on the machine.
//
// Why this exists: `tauri build` writes its bundle into the project tree, so
// a copy installed in /Applications plus the build output made Finder and
// Spotlight show NewPi twice. Worse, every disk image build mounts a temporary
// volume whose registration stayed behind in LaunchServices forever.
//
// Run it after `pnpm build`, or use `pnpm build` which does both.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = resolve(ROOT, 'src-tauri/target');
const BUILT = resolve(TARGET, 'release/bundle/macos/NewPi.app');
const INSTALLED = '/Applications/NewPi.app';
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/** Best effort: a busy LaunchServices must never fail an install. */
function lsregister(args) {
  try {
    return execFileSync(LSREGISTER, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** Every NewPi bundle LaunchServices still knows about, minus the installed one. */
function staleRegistrations() {
  const found = lsregister(['-dump'])
    .split('\n')
    .map((line) => line.match(/^\s*path:\s+(\/.*?NewPi\.app)\s+\(0x[0-9a-f]+\)/)?.[1])
    .filter((path) => path !== undefined && path !== INSTALLED);
  return [...new Set(found)];
}

if (!existsSync(BUILT)) {
  console.error(
    `Rien à installer : ${BUILT} est absent.\nLancez d'abord : pnpm bundle`,
  );
  process.exit(1);
}

// Keep Spotlight out of the build tree, so a build that is not installed yet
// never shows up as a second NewPi in search results.
mkdirSync(TARGET, { recursive: true });
writeFileSync(resolve(TARGET, '.metadata_never_index'), '');

// Replace the installed copy, refusing rather than half deleting one that is
// currently running.
try {
  rmSync(INSTALLED, { recursive: true, force: true });
} catch {
  console.error(
    `Impossible de remplacer ${INSTALLED}.\nQuittez NewPi s'il est ouvert, puis relancez.`,
  );
  process.exit(1);
}
execFileSync('ditto', [BUILT, INSTALLED], { stdio: 'inherit' });

// Drop the build tree copy, so exactly one bundle remains on disk. The next
// build recreates it.
rmSync(BUILT, { recursive: true, force: true });

// The `dmg.*` paths are volumes that no longer exist, left behind by each disk
// image build. Clearing them is what stops Finder and Launchpad showing
// several NewPi entries.
for (const path of staleRegistrations()) {
  console.log(`retrait de l'enregistrement : ${path}`);
  lsregister(['-u', path]);
}

// Registered last, so it is the one Finder resolves.
lsregister(['-f', INSTALLED]);

console.log(`NewPi installé dans ${INSTALLED}, et c'est désormais la seule copie.`);
