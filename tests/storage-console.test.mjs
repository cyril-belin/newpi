/**
 * The Storage section: measurement, catalog, cleanup, the endpoint, and the
 * injected client.
 *
 * The tests that matter most are the refusals. A cleanup engine is judged by
 * what it declines to do, so this suite spends most of its length proving that
 * a session, a memory database and a backup cannot be removed by any request
 * the plugin will answer — not with a flag, not with a confirmation, not by
 * naming a path.
 *
 * Every filesystem test runs inside a temporary home directory built for it, so
 * nothing here touches the machine's real caches.
 *
 * @module newpi/tests/storage-console
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCatalog,
  findEntry,
  isRemovable,
  RETENTION_POLICY,
  ROLES,
} from '../plugins/storage-console/catalog.js';
import {
  CleanupError,
  isStrictlyInside,
  previewCleanup,
  runSafeCleanup,
  toleranceFor,
} from '../plugins/storage-console/cleanup.js';
import { allocatedBytes, measureTree } from '../plugins/storage-console/scan.js';
import { assertParams, STORAGE_ENDPOINT } from '../plugins/storage-console/index.js';
import {
  installStorage,
  storageScript,
  storageStyle,
  STORAGE_ATTRIBUTE,
} from '../plugins/storage-console/ui.js';
import {
  formatBytes,
  measureAll,
  parseArgs,
  renderPolicy,
  renderTable,
  resolveRoots,
} from '../scripts/storage.mjs';

/**
 * Build a throwaway home directory with the shape the catalog expects.
 *
 * @returns the roots, already created.
 */
async function fakeRoots() {
  const base = await mkdtemp(join(tmpdir(), 'newpi-storage-'));
  const home = join(base, 'home');
  const workspace = join(home, 'project');
  const state = join(home, 'Library/Application Support/NewPi');
  const dshHome = join(home, '.dsh');
  await mkdir(join(workspace, 'src-tauri/target/debug/incremental'), { recursive: true });
  await mkdir(join(dshHome, 'sessions/--project--'), { recursive: true });
  await mkdir(join(dshHome, 'attachments'), { recursive: true });
  await mkdir(join(state, 'pocketbase/pb_data'), { recursive: true });
  await mkdir(join(state, 'pocketbase/pb_data/backups'), { recursive: true });
  await mkdir(join(state, 'backups'), { recursive: true });
  return {
    base,
    home,
    workspace,
    state,
    dshHome,
    data: join(state, 'pocketbase/pb_data'),
    snapshots: join(state, 'pocketbase/pb_data/backups'),
    backups: join(state, 'backups'),
  };
}

/**
 * Write a file of a requested size.
 *
 * @param path - the file.
 * @param bytes - how many bytes.
 */
async function writeBytes(path, bytes) {
  await writeFile(path, Buffer.alloc(bytes, 0x61));
}

/**
 * Boot the Storage plugin on a real Cordis context, with the two services the
 * host provides faked — the same shape the memory console is tested through.
 *
 * @param roots - the roots the plugin is configured with.
 * @returns the service, the endpoints it registered, and the injections it made.
 */
async function bootStorage(roots, options = {}) {
  const { Context } = await import(
    process.env.DSH_PROFILE_MODULES
      ? `${process.env.DSH_PROFILE_MODULES}/@deepseek-ai/cordis/lib/index.js`
      : `${process.env.HOME}/.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis/lib/index.js`
  );
  const ctx = new Context();
  const tapped = [];
  const routes = new Map();
  ctx.provide('webServer', {
    tapIndex(transform) {
      tapped.push(transform);
      return () => {};
    },
  });
  ctx.provide('connection', {
    fetch: {
      register(route) {
        assert.equal(typeof route.path, 'string');
        assert.ok(route.path.startsWith('/api/'), 'a console route must live behind /api');
        assert.ok(route.methods.includes('POST'));
        assert.equal(route.requestBody, 'buffered');
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  });

  const { apply } = await import('../plugins/storage-console/index.js');
  apply(ctx, {
    home: roots.home,
    workspace: roots.workspace,
    stateDir: roots.state,
    dshHome: roots.dshHome,
    dataDir: roots.data,
    snapshotDir: roots.snapshots,
    backupDir: roots.backups,
    projectName: options.projectName ?? '',
  });

  return { ctx, storage: ctx.get('storageConsole'), tapped, routes };
}

// --------------------------------------------------------------- measurement

test('a walk counts files and directories, and reports both sizes', async () => {
  const roots = await fakeRoots();
  try {
    await writeBytes(join(roots.workspace, 'src-tauri/target/debug/incremental/one.bin'), 4096);
    await writeBytes(join(roots.workspace, 'src-tauri/target/debug/incremental/two.bin'), 2048);

    const report = await measureTree(join(roots.workspace, 'src-tauri/target'));
    assert.equal(report.exists, true);
    assert.equal(report.kind, 'directory');
    assert.equal(report.files, 2);
    assert.equal(report.directories, 3, 'target, debug and incremental');
    assert.equal(report.bytes, 6144);
    assert.ok(report.allocated >= report.bytes, 'allocated must cover the logical size');
    assert.equal(report.truncated, false);
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('a measurement never follows a symbolic link out of the tree', async () => {
  const roots = await fakeRoots();
  try {
    // The exact shape the deployed plugins directory has, and the reason this
    // matters: a link to the home directory must not make a cache look like the
    // whole disk.
    const outside = join(roots.base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeBytes(join(outside, 'huge.bin'), 8192);
    await symlink(outside, join(roots.workspace, 'src-tauri/target/link'));

    const report = await measureTree(join(roots.workspace, 'src-tauri/target'));
    assert.equal(report.files, 0, 'the linked file must not be counted');
    assert.equal(report.links, 1);
    assert.equal(report.bytes, 0);
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('a hard link is charged to the tree once, the way du counts it', async () => {
  const roots = await fakeRoots();
  try {
    // The shape cargo produces: the artefact lives in `deps/` and is linked
    // again one level up. Counting names would report the build at twice cost.
    const { link } = await import('node:fs/promises');
    const debug = join(roots.workspace, 'src-tauri/target/debug');
    await mkdir(join(debug, 'deps'), { recursive: true });
    await writeBytes(join(debug, 'deps', 'app.bin'), 65536);
    await link(join(debug, 'deps', 'app.bin'), join(debug, 'app.bin'));

    const report = await measureTree(join(roots.workspace, 'src-tauri/target'));
    assert.equal(report.files, 2, 'both names are files that were walked');
    assert.equal(report.bytes, 65536, 'the bytes are charged once');
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('an absent path is reported, not raised', async () => {
  const report = await measureTree('/definitely/not/here/newpi-storage');
  assert.equal(report.exists, false);
  assert.equal(report.kind, 'absent');
  assert.equal(report.allocated, 0);
});

test('a walk stops at its entry budget and says the figure is partial', async () => {
  const roots = await fakeRoots();
  try {
    for (let at = 0; at < 40; at += 1) {
      await writeBytes(join(roots.workspace, 'src-tauri/target/debug', `f${at}.bin`), 16);
    }
    const report = await measureTree(join(roots.workspace, 'src-tauri/target'), { maxEntries: 5 });
    assert.equal(report.truncated, true);
    assert.ok(report.files < 40, 'the walk must not have counted everything');
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('allocated bytes fall back to the logical size without st_blocks', () => {
  assert.equal(allocatedBytes({ blocks: 8, size: 1 }), 4096);
  assert.equal(allocatedBytes({ blocks: undefined, size: 1234 }), 1234);
  assert.equal(allocatedBytes({ blocks: -1, size: 7 }), 7);
});

// ------------------------------------------------------------------ catalog

test('every catalog entry is complete, and its path hangs from a known root', async () => {
  const roots = await fakeRoots();
  try {
    const entries = buildCatalog(roots);
    const fences = [roots.home, roots.workspace, roots.state, roots.dshHome];
    assert.ok(entries.length > 20, 'the catalog must cover the whole toolchain');
    const ids = new Set();
    for (const entry of entries) {
      assert.ok(entry.id.length > 0, 'an entry has no id');
      assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
      ids.add(entry.id);
      assert.ok(entry.label.length > 0, `${entry.id} has no label`);
      assert.ok(entry.what.length > 0, `${entry.id} does not say what it holds`);
      assert.ok(entry.cost.length > 0, `${entry.id} does not say what removal costs`);
      assert.ok(Object.values(ROLES).includes(entry.role), `${entry.id} has role ${entry.role}`);
      assert.ok(['safe', 'guarded'].includes(entry.safety), `${entry.id} has class ${entry.safety}`);
      if (entry.safety === 'guarded') {
        assert.equal(entry.cleanup, null, `${entry.id} is guarded and declares a cleanup`);
      }
      if (entry.path !== null) {
        assert.ok(
          fences.some((fence) => isStrictlyInside(entry.path, fence)),
          `${entry.id} escapes every root: ${entry.path}`,
        );
      }
    }
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('sessions, memory, snapshots and backups are guarded, and never removable', async () => {
  const roots = await fakeRoots();
  try {
    const entries = buildCatalog(roots);
    for (const id of [
      'dsh-sessions',
      'dsh-attachments',
      'newpi-pb-data',
      'newpi-pb-snapshots',
      'newpi-backups',
    ]) {
      const entry = findEntry(entries, id);
      assert.ok(entry, `${id} must exist in the catalog`);
      assert.equal(entry.safety, 'guarded', `${id} must be guarded`);
      assert.equal(isRemovable(entry), false, `${id} must not be removable`);
    }
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('no removable target lives inside the memory, the snapshots or the backups', async () => {
  const roots = await fakeRoots();
  try {
    for (const protectedRoot of [roots.data, roots.snapshots, roots.backups]) {
      for (const entry of buildCatalog(roots)) {
        if (!isRemovable(entry)) continue;
        assert.equal(
          isStrictlyInside(entry.path, protectedRoot),
          false,
          `${entry.id} would delete inside ${protectedRoot}`,
        );
      }
    }
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('the retention policy names a rule for every role', () => {
  for (const role of Object.values(ROLES)) {
    const rule = RETENTION_POLICY[role];
    assert.ok(rule, `no policy for ${role}`);
    assert.ok(typeof rule.note === 'string' && rule.note.length > 0);
    assert.ok(['none', 'never', 'rotate'].includes(rule.automatic));
  }
  assert.equal(RETENTION_POLICY[ROLES.sessions].automatic, 'never');
  assert.equal(RETENTION_POLICY[ROLES.memory].automatic, 'never');
  assert.equal(RETENTION_POLICY[ROLES.backups].automatic, 'never');
  assert.equal(RETENTION_POLICY[ROLES.logs].automatic, 'rotate');
});

// ------------------------------------------------------------------ cleanup

test('a guarded target is refused before any path is resolved', async () => {
  const roots = await fakeRoots();
  try {
    const entries = buildCatalog(roots);
    const session = join(roots.dshHome, 'sessions/--project--/session.v3.jsonl.zstd');
    await writeBytes(session, 2048);
    const entry = findEntry(entries, 'dsh-sessions');

    for (const confirm of [entry.id, true, 'yes']) {
      await assert.rejects(
        runSafeCleanup({ entry, roots, confirm, expectBytes: 2048 }),
        (error) => error instanceof CleanupError && error.code === 'STORAGE_GUARDED_TARGET',
      );
    }
    // And the session is still there, which is the only assertion that counts.
    assert.ok(await stat(session));
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('the memory database and the backups survive a request that names them', async () => {
  const roots = await fakeRoots();
  try {
    const entries = buildCatalog(roots);
    await writeBytes(join(roots.data, 'data.db'), 1024);
    await writeBytes(join(roots.backups, 'newpi-memory-20260912.zip'), 4096);

    for (const id of ['newpi-pb-data', 'newpi-backups', 'newpi-pb-snapshots']) {
      await assert.rejects(
        runSafeCleanup({ entry: findEntry(entries, id), roots, confirm: id, expectBytes: 0 }),
        (error) => error.code === 'STORAGE_GUARDED_TARGET',
      );
    }
    assert.ok(await stat(join(roots.data, 'data.db')));
    assert.ok(await stat(join(roots.backups, 'newpi-memory-20260912.zip')));
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('a safe directory target is removed, and the removal is confirmed by size', async () => {
  const roots = await fakeRoots();
  try {
    const target = join(roots.workspace, 'src-tauri/target');
    await writeBytes(join(target, 'debug/incremental/a.bin'), 8192);
    const entry = findEntry(buildCatalog(roots), 'newpi-target');
    const before = await measureTree(target);

    await assert.rejects(
      runSafeCleanup({ entry, roots, confirm: 'something-else', expectBytes: before.allocated }),
      (error) => error.code === 'STORAGE_CONFIRMATION_REQUIRED',
    );
    await assert.rejects(
      runSafeCleanup({ entry, roots, confirm: entry.id, expectBytes: 1 }),
      (error) => error.code === 'STORAGE_SIZE_CHANGED',
    );

    const report = await runSafeCleanup({
      entry,
      roots,
      confirm: entry.id,
      expectBytes: before.allocated,
    });
    assert.equal(report.removed, true);
    assert.equal(report.mode, 'remove-directory');
    assert.ok(report.freed > 0, 'the report must say how much was recovered');
    await assert.rejects(stat(target), 'the directory must be gone');
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('clearing a cache keeps the directory, and its symlinks are not followed', async () => {
  const roots = await fakeRoots();
  try {
    const target = join(roots.home, '.npm/_cacache');
    const keep = join(roots.base, 'keep');
    await mkdir(join(target, 'content-v2/sha512'), { recursive: true });
    await mkdir(keep, { recursive: true });
    await writeBytes(join(target, 'content-v2/sha512/blob'), 4096);
    await writeBytes(join(keep, 'precious.bin'), 8192);
    await symlink(keep, join(target, 'escape'));

    const entry = findEntry(buildCatalog(roots), 'npm-cacache');
    const before = await measureTree(target);
    const report = await runSafeCleanup({
      entry,
      roots,
      confirm: entry.id,
      expectBytes: before.allocated,
    });

    assert.equal(report.removed, true);
    assert.equal(report.mode, 'clear-contents');
    // The directory is still there — its owner expects to find it.
    assert.ok((await stat(target)).isDirectory());
    assert.deepEqual(await readdir(target), []);
    // The link was unlinked, not followed: what it pointed at is untouched.
    assert.ok(await stat(join(keep, 'precious.bin')));
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('the fence refuses a target that is not strictly below a root', () => {
  assert.equal(isStrictlyInside('/home/user/cache', '/home/user'), true);
  assert.equal(isStrictlyInside('/home/user', '/home/user'), false, 'a root is not inside itself');
  assert.equal(isStrictlyInside('/home/user/../etc', '/home/user'), false);
  assert.equal(isStrictlyInside('/home/userX', '/home/user'), false);
});

test('the size tolerance is proportional, capped so a small target cannot be swapped', () => {
  // A tiny target gets a tolerance much smaller than itself: the confirmation
  // figure has to be the figure that is deleted.
  assert.ok(toleranceFor(0) < 8 * 1024 * 1024);
  assert.ok(toleranceFor(12 * 1024) < 8 * 1024);
  assert.ok(toleranceFor(10 * 1024 * 1024 * 1024) > 8 * 1024 * 1024);
  assert.ok(toleranceFor(Number.MAX_SAFE_INTEGER) > 0);
});

// ----------------------------------------------------------------- endpoint

test('the plugin registers exactly one authenticated endpoint and injects the section', async () => {
  const roots = await fakeRoots();
  try {
    const { routes, tapped } = await bootStorage(roots);
    assert.deepEqual([...routes.keys()], [STORAGE_ENDPOINT]);
    assert.equal(STORAGE_ENDPOINT, '/api/newpi.storage');
    assert.equal(tapped.length, 1, 'the section must be injected exactly once');
    assert.ok(tapped[0]('<html><head></head><body></body></html>').includes(STORAGE_ATTRIBUTE));
    assert.equal(storageScript().includes(STORAGE_ENDPOINT), true);
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('status reports the catalog with nothing measured yet', async () => {
  const roots = await fakeRoots();
  try {
    const { storage } = await bootStorage(roots);
    const status = storage.status();
    assert.ok(status.entries.length > 20);
    assert.equal(status.entries.every((entry) => entry.measurement === null), true);
    assert.equal(status.totals.allocated, 0);
    // The unmeasured list is what the view still has to walk: every countable
    // entry, and never a parent that only describes its children.
    const counted = status.entries.filter((entry) => !Array.isArray(entry.overlaps));
    assert.equal(status.totals.unmeasured.length, counted.length);
    assert.equal(
      status.entries
        .filter((entry) => entry.path !== null)
        .every((entry) => status.totals.measurable.includes(entry.id)),
      true,
    );
    // Guarded entries are reported too, so the view can show where the disk
    // went even for what it will not delete.
    assert.equal(status.entries.find((entry) => entry.id === 'newpi-backups').safety, 'guarded');
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('an empty project root omits project targets instead of using a personal fallback', async () => {
  const roots = await fakeRoots();
  try {
    const { storage } = await bootStorage({ ...roots, workspace: '' });
    const status = storage.status();
    assert.deepEqual(status.project, { name: '', root: '' });
    for (const id of ['newpi-target', 'newpi-node-modules', 'newpi-pnpm-store']) {
      assert.equal(status.entries.some((entry) => entry.id === id), false);
    }
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('scan measures a scope, and the totals exclude overlapping parents', async () => {
  const roots = await fakeRoots();
  try {
    await writeBytes(join(roots.workspace, 'src-tauri/target/a.bin'), 4096);
    const { storage } = await bootStorage(roots);
    const status = await storage.scan({ scopes: ['newpi'] });

    const target = status.entries.find((entry) => entry.id === 'newpi-target');
    assert.ok(target.measurement.allocated >= 4096);
    const state = status.entries.find((entry) => entry.id === 'newpi-state');
    assert.ok(state.measurement, 'the parent is measured');
    assert.ok(Array.isArray(state.overlaps));
    assert.equal(status.totals.unmeasured.includes('newpi-target'), false);
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('the endpoint refuses an unknown action, an unknown target and an unknown key', async () => {
  const roots = await fakeRoots();
  try {
    const { storage } = await bootStorage(roots);
    await assert.rejects(storage.dispatch('storage.nope', {}), (error) => {
      assert.equal(error.code, 'STORAGE_UNKNOWN_ACTION');
      return true;
    });
    await assert.rejects(storage.dispatch('storage.preview', { id: 'not-a-target' }), (error) => {
      assert.equal(error.code, 'STORAGE_UNKNOWN_TARGET');
      return true;
    });
    assert.throws(
      () => assertParams({ path: '/etc/passwd' }, ['id']),
      (error) => error.code === 'STORAGE_INVALID_ARGS',
    );
    await assert.rejects(
      storage.dispatch('storage.clean', {
        id: 'dsh-sessions',
        confirm: 'dsh-sessions',
        expectBytes: 0,
      }),
      (error) => error.code === 'STORAGE_GUARDED_TARGET',
    );
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('the endpoint answers a well formed request and reports the freed bytes', async () => {
  const roots = await fakeRoots();
  try {
    await writeBytes(join(roots.workspace, 'src-tauri/target/a.bin'), 16384);
    const { storage } = await bootStorage(roots);

    const preview = await storage.dispatch('storage.preview', { id: 'newpi-target' });
    assert.equal(preview.removable, true);
    assert.equal(preview.target, join(roots.workspace, 'src-tauri/target'));
    assert.ok(preview.measurement.allocated > 0);

    const report = await storage.dispatch('storage.clean', {
      id: 'newpi-target',
      confirm: 'newpi-target',
      expectBytes: preview.measurement.allocated,
    });
    assert.equal(report.removed, true);
    assert.ok(report.freed > 0);

    // The measurement cache was dropped, so the next status shows the truth.
    const after = storage.status().entries.find((entry) => entry.id === 'newpi-target');
    assert.equal(after.measurement, null);
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('a guarded preview states the refusal and still shows the size', async () => {
  const roots = await fakeRoots();
  try {
    await writeBytes(join(roots.dshHome, 'sessions/--project--/s.jsonl.zstd'), 3000);
    const { storage } = await bootStorage(roots);
    const preview = await storage.dispatch('storage.preview', { id: 'dsh-sessions' });
    assert.equal(preview.removable, false);
    assert.ok(preview.measurement.allocated >= 3000);
    assert.match(preview.refusal, /protégée/);
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------------------- ui

test('the injected section carries a style and a runnable script', () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  const injected = installStorage(html);
  assert.ok(injected.includes(`<style ${STORAGE_ATTRIBUTE}>`));
  assert.ok(injected.includes(`<script ${STORAGE_ATTRIBUTE}>`));
  assert.ok(injected.includes('Stockage'));
  assert.ok(storageStyle().includes(`[${STORAGE_ATTRIBUTE}]`));
  // The script is a real function serialised, so it must compile even though
  // nothing here runs it.
  assert.doesNotThrow(() => new Function(storageScript()));
  for (const placeholder of ['SEAT_NAMES', 'ROLE_LABELS_JSON', 'SCOPE_NAMES', 'RAIL_PIXELS']) {
    assert.equal(storageScript().includes(placeholder), false, `${placeholder} is not substituted`);
  }
  assert.equal(storageScript().includes('innerHTML'), false, 'no markup from data');
  assert.equal(storageScript().includes('document.write'), false);
});

test('a document with no head still gets the section', () => {
  const injected = installStorage('<body>only</body>');
  assert.ok(injected.startsWith(`<style ${STORAGE_ATTRIBUTE}>`));
  assert.ok(injected.endsWith('<body>only</body>'));
});

// ------------------------------------------------------------------- command

test('the command line parses roots, previews and cleanups without touching $HOME', () => {
  const options = parseArgs([
    '--home', '/tmp/h',
    '--workspace', '/tmp/w',
    '--state', '/tmp/s',
    '--dsh-home', '/tmp/d',
    '--clean', 'npm-cacache',
    '--confirm', 'npm-cacache',
  ]);
  const roots = resolveRoots(options);
  assert.equal(roots.home, '/tmp/h');
  assert.equal(roots.workspace, '/tmp/w');
  assert.equal(roots.state, '/tmp/s');
  assert.equal(roots.dshHome, '/tmp/d');
  assert.equal(roots.data, '/tmp/s/pocketbase/pb_data');
  assert.equal(roots.backups, '/tmp/s/backups');
  assert.throws(() => parseArgs(['--home']), /attend une valeur/);
  assert.throws(() => parseArgs(['--nope']), /inconnue/);
});

test('the table and the policy render the measured figures', async () => {
  const roots = await fakeRoots();
  try {
    await writeBytes(join(roots.workspace, 'src-tauri/target/a.bin'), 4096);
    const entries = await measureAll(buildCatalog(roots).filter((entry) => entry.scope === 'newpi'));
    const table = renderTable(entries, roots, 'newpi');
    assert.ok(table.includes('newpi-target'));
    assert.ok(table.includes('Total mesuré'));
    assert.ok(table.includes('nettoyable'));
    assert.ok(renderPolicy().includes('PocketBase'));
    assert.equal(formatBytes(0), '0 o');
    assert.equal(formatBytes(1024), '1,0 Kio');
    assert.equal(formatBytes(null), '—');
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('a preview of a guarded target through the command offers no removal', async () => {
  const roots = await fakeRoots();
  try {
    const entry = findEntry(buildCatalog(roots), 'newpi-pb-data');
    const preview = await previewCleanup({ entry, roots });
    assert.equal(preview.removable, false);
    assert.ok(preview.refusal.length > 0);
    assert.equal(preview.cleanup, null);
  } finally {
    await rm(roots.base, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- fake browser

/**
 * A small stand-in for the browser the injected client runs in.
 *
 * Deliberately minimal: it implements what this client uses and nothing else,
 * so a call the client makes that the fake does not have fails loudly rather
 * than passing silently.
 *
 * @param options - the fake.
 * @param options.slots - the `data-slot` names the document exposes.
 * @param options.fetch - the endpoint implementation.
 * @returns the document, the fetch spy and a settle helper.
 */
function fakeDocument({ slots, fetch: fetchImpl }) {
  function element(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: {},
      listeners: {},
      className: '',
      textContent: '',
      hidden: false,
      disabled: false,
      value: '',
      type: '',
      classList: { add() {}, remove() {} },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      addEventListener(name, handler) {
        this.listeners[name] = this.listeners[name] ?? [];
        this.listeners[name].push(handler);
      },
      click() {
        for (const handler of this.listeners.click ?? []) handler({ target: this });
      },
      focus() {},
      /** Set the field and fire the input event a typist would. */
      typeInto(text) {
        this.value = text;
        for (const handler of this.listeners.input ?? []) handler({ target: this });
      },
      querySelector(selector) {
        const slot = /\[data-slot="([^"]+)"\]/.exec(selector)?.[1];
        if (slot !== undefined) {
          if (this.attributes['data-slot'] === slot) return this;
          for (const child of this.children) {
            const found = child.querySelector(selector);
            if (found) return found;
          }
          return null;
        }
        const marker = /\[(data-newpi-storage-nav)[^\]]*\]/.exec(selector)?.[1];
        if (marker !== undefined) {
          for (const child of this.children) {
            if (child.attributes[marker] !== undefined) return child;
          }
        }
        return null;
      },
      /** Every descendant, depth first. */
      all() {
        return this.children.flatMap((child) => [child, ...child.all()]);
      },
    };
  }

  const body = element('body');
  for (const name of slots) {
    const seat = element('div');
    seat.setAttribute('data-slot', name);
    body.appendChild(seat);
  }
  const documentElement = element('html');
  const document = {
    documentElement,
    body,
    createElement: element,
    createElementNS: (_namespace, tag) => element(tag),
    // The client writes every value with `textContent`, so it builds no text
    // nodes of its own — except for the separators between a heading and its
    // figure, which are appended as nodes rather than concatenated.
    createTextNode: (text) => {
      const node = element('#text');
      node.textContent = String(text);
      return node;
    },
    querySelector: (selector) => body.querySelector(selector),
  };

  const calls = [];
  const fetchSpy = async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push(payload);
    return { ok: true, status: 200, json: async () => fetchImpl(payload) };
  };
  fetchSpy.calls = calls;

  return {
    document,
    fetch: fetchSpy,
    /** Let every queued promise settle. */
    async flush() {
      for (let round = 0; round < 12; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test('the client runs, lands in the footer seat, and refuses an untyped confirmation', async () => {
  const roots = await fakeRoots();
  const target = join(roots.workspace, 'src-tauri/target');
  const measurement = {
    allocated: 3_600_000_000,
    bytes: 3_600_000_000,
    files: 3,
    directories: 2,
    truncated: false,
  };
  const status = {
    project: { name: 'Projet isolé', root: roots.workspace },
    roots: {
      home: roots.home,
      workspace: roots.workspace,
      state: roots.state,
      dshHome: roots.dshHome,
    },
    scopes: ['newpi', 'dsh', 'toolchain', 'other'],
    policy: RETENTION_POLICY,
    entries: [
      {
        id: 'newpi-target',
        label: 'Build Rust du projet',
        scope: 'newpi',
        role: 'build',
        safety: 'safe',
        cleanup: 'remove-directory',
        path: target,
        what: 'Cargo.',
        cost: 'Une recompilation.',
        budgetBytes: 8 * 1024 * 1024 * 1024,
        measurement,
      },
      {
        id: 'dsh-sessions',
        label: 'Sessions du moteur',
        scope: 'dsh',
        role: 'sessions',
        safety: 'guarded',
        cleanup: null,
        path: join(roots.dshHome, 'sessions'),
        what: 'Historique.',
        cost: 'DÉFINITIF.',
        budgetBytes: null,
        measurement: { ...measurement, allocated: 15_000_000, bytes: 15_000_000 },
      },
    ],
    totals: {
      allocated: 3_615_000_000,
      byRole: { build: 3_600_000_000, sessions: 15_000_000 },
      byScope: { newpi: 3_600_000_000, dsh: 15_000_000, toolchain: 0, other: 0 },
      unmeasured: [],
      measurable: ['newpi-target', 'dsh-sessions'],
      measuredAt: '2026-09-15T00:00:00.000Z',
    },
  };
  const preview = {
    id: 'newpi-target',
    label: 'Build Rust du projet',
    role: 'build',
    safety: 'safe',
    removable: true,
    target,
    what: 'Cargo.',
    cost: 'Une recompilation.',
    cleanup: 'remove-directory',
    measurement,
    refusal: null,
  };

  const { document, fetch, flush } = fakeDocument({
    slots: ['sidebar.footer.action', 'sidebar.panellist'],
    fetch: (payload) => {
      if (payload.action === 'storage.status' || payload.action === 'storage.scan') {
        return { ok: true, value: status };
      }
      if (payload.action === 'storage.preview') return { ok: true, value: preview };
      if (payload.action === 'storage.clean') {
        return {
          ok: true,
          value: { id: payload.params.id, target, removed: true, freed: 3_600_000_000 },
        };
      }
      return { ok: false, error: { code: 'NOPE', message: 'non' } };
    },
  });

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
  };
  globalThis.document = document;
  globalThis.window = { addEventListener() {}, console };
  globalThis.fetch = fetch;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
  };

  try {
    // Run the shipped script for real, against the fake browser.
    new Function(storageScript())();

    const footer = document.querySelector('[data-slot="sidebar.footer.action"]');
    const row = footer.querySelector('[data-newpi-storage-nav]');
    assert.ok(row, 'the Storage row must land in the footer seat');
    assert.equal(
      document.querySelector('[data-slot="sidebar.panellist"]').children.length,
      0,
      'nothing may be injected into the panel list',
    );

    row.click();
    await flush();

    const panel = document.body.children.find((node) => node.className === 'nps-root');
    assert.ok(panel, 'opening the row must build the panel');
    assert.equal(panel.hidden, false);

    const texts = panel.all().map((node) => node.textContent);
    assert.ok(texts.includes('projet Projet isolé · ' + roots.workspace));
    assert.ok(texts.includes('Build Rust du projet'));
    assert.ok(texts.includes('Sessions du moteur'));
    assert.ok(texts.includes('non supprimable ici'), 'the guarded row offers no cleanup');
    assert.ok(
      texts.includes('Aucune suppression de session, de mémoire PocketBase ou de sauvegarde n\'est possible ici.'),
    );
    // The engine scopes were measured on open: the one automatic call.
    assert.ok(fetch.calls.some((call) => call.action === 'storage.scan'));

    // Cleaning asks for the target, its size, and a typed confirmation.
    const cleanButton = panel.all().find((node) => node.textContent === 'Nettoyer…');
    assert.ok(cleanButton, 'a safe row must offer a cleanup');
    cleanButton.click();
    await flush();

    const confirmTexts = panel.all().map((node) => node.textContent);
    assert.ok(confirmTexts.includes('Confirmation explicite'));
    assert.ok(confirmTexts.includes(target), 'the confirmation must show the target');
    assert.ok(
      confirmTexts.some((text) => text === '3,4 Gio'),
      'the confirmation must show the size',
    );
    const go = panel.all().find((node) => node.textContent === 'Supprimer');
    assert.ok(go, 'the confirmation has no removal button');
    assert.equal(go.disabled, true, 'removal must be disabled until the id is typed');

    const field = panel.all().find((node) => node.tagName === 'INPUT');
    field.typeInto('newpi-target');
    assert.equal(go.disabled, false);
    go.click();
    await flush();

    const clean = fetch.calls.find((call) => call.action === 'storage.clean');
    assert.equal(clean.params.confirm, 'newpi-target');
    assert.equal(clean.params.expectBytes, 3_600_000_000);
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    globalThis.MutationObserver = previous.MutationObserver;
    globalThis.ResizeObserver = previous.ResizeObserver;
    await rm(roots.base, { recursive: true, force: true });
  }
});

test('the sample launcher patch the Rust suite writes carries the storage row', async () => {
  // The patch is produced by `cargo test`, which the `pretest` hook runs before
  // this file. Reading it here ties the Rust row and the plugin's expectations
  // together: a row that is never emitted is a section that never mounts.
  const sample = new URL('../src-tauri/target/test-tmp/launcher-sample.patch.yml', import.meta.url);
  const text = await readFile(sample, 'utf8');
  assert.ok(text.includes("id: 'storage-console'"));
  assert.ok(text.includes('stateDir:'));
  assert.ok(text.includes('dshHome:'));
  assert.equal(text.includes('password'), false);
});
