#!/usr/bin/env node
/**
 * Undo what `tauri build` leaves registered behind it.
 *
 * Building a dmg has two side effects beyond the dmg itself, and both put a
 * second "NewPi" in front of the user:
 *
 * 1. The bundler assembles a real `.app` in `bundle/macos/` before it can put
 *    one inside a disk image. That copy carries the same bundle identifier as
 *    the installed application.
 * 2. It writes a temporary disk image and mounts it as `/Volumes/dmg.XXXX/`,
 *    and every mount is registered with LaunchServices as an application.
 *
 * Neither is a deliverable. Left alone they accumulate: after a few builds,
 * Launchpad and Spotlight offer several identical NewPi icons, most of which
 * lead to something that no longer exists. This script removes the copy, then
 * asks LaunchServices to forget both it and every mounted build image it still
 * remembers.
 *
 * It never touches the dmg, and it is a no-op on a clean tree.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

const here = dirname(fileURLToPath(import.meta.url));
const bundleRoot = resolve(here, '..', 'src-tauri/target/release/bundle');
const temporaryBundle = join(bundleRoot, 'macos/NewPi.app');

/** Ask LaunchServices to forget one path. Missing paths are not an error. */
function forget(path) {
  try {
    execFileSync(LSREGISTER, ['-u', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let cleaned = 0;

if (existsSync(temporaryBundle)) {
  rmSync(temporaryBundle, { recursive: true, force: true });
  cleaned += 1;
  console.log('NewPi build: removed the temporary bundle from bundle/macos');
}
// Unregistered whether or not the copy was still on disk: an entry can outlive
// the file it points at, and that stale entry is the one that shows up as a
// second icon.
forget(temporaryBundle);

// The mounted build images. `-u` accepts a path whose volume is gone, which is
// exactly what these are, and that is what prunes the registration.
const volumes = '/Volumes';
if (existsSync(volumes)) {
  for (const entry of readdirSync(volumes)) {
    if (!entry.startsWith('dmg.')) continue;
    if (forget(join(volumes, entry))) cleaned += 1;
    forget(join(volumes, entry, 'NewPi.app'));
  }
}

console.log(
  cleaned === 0
    ? 'NewPi build: nothing to clean'
    : `NewPi build: cleaned ${cleaned} leftover application registration(s)`,
);
