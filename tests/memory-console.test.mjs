/**
 * Behaviour tests for the memory console: the two sections' backend, and the
 * backup format they rest on.
 *
 * These run against the fake PocketBase in `tests/fake-pocketbase.mjs`, whose
 * backup endpoints write and read real archives, so the whole transaction —
 * snapshot, delete, restore, verify — is exercised here. What the real binary
 * adds on top is proved separately by `tests/backup-live.mjs`.
 *
 * The properties worth naming, because they are the ones a later change would
 * quietly break:
 *
 * - the console can only ever act on the project it was configured with;
 * - no action accepts a project scope from the browser, and an undeclared
 *   parameter is refused rather than ignored;
 * - a deletion and a restore both require an explicit confirmation;
 * - memory writes are held off while a restore replaces the database;
 * - an archive this build cannot read is refused before anything is touched;
 * - every error the interface can receive has a readable message.
 *
 * `node --test tests/` runs them.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakePocketBase, TEST_IDENTITY, TEST_PASSWORD } from './fake-pocketbase.mjs';
import {
  BACKUP_FORMAT,
  MAX_READABLE_FORMAT_VERSION,
  MemoryBackups,
  backupFileName,
  buildManifest,
  checkCompatibility,
  compareVersions,
  parseVersion,
  readManifest,
  summarizeManifest,
} from '../plugins/memory-console/backup.js';
import {
  CONSOLE_ENDPOINT,
  ConsoleError,
  assertParams,
  apply as applyConsole,
} from '../plugins/memory-console/index.js';
import {
  appleScriptString,
  panelOutcome,
  savePanelScript,
} from '../plugins/memory-console/platform.js';
import {
  CONSOLE_ATTRIBUTE,
  NAV_SEATS,
  PANELLIST_SLOT,
  clientConsole,
  consoleScript,
  consoleStyle,
  installConsole,
} from '../plugins/memory-console/ui.js';
import {
  MEMORY_KINDS,
  previewOf,
  toIsoTimestamp,
  toMemorySummary,
} from '../plugins/pocketbase-memory/core.js';

const VERSIONS = { newpi: '0.1.0', pocketbase: '0.40.4' };

/**
 * Boot the memory backend and the console on one Cordis context, with a fake
 * web server and a fake connection — the two services the real host provides.
 *
 * @param options - the fake backend and where the console keeps its files.
 * @param options.baseUrl - the fake PocketBase base URL.
 * @param options.projectId - the configured project scope.
 * @param options.backupDir - where NewPi keeps the user's archives.
 * @param options.snapshotDir - where the sidecar keeps its snapshots.
 * @returns the console, and what the fake services recorded.
 */
async function bootConsole({ baseUrl, projectId, backupDir, snapshotDir, dataDir }) {
  const backend = await import('../plugins/pocketbase-memory/index.js');
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

  backend.apply(ctx, { url: baseUrl, identity: TEST_IDENTITY, password: TEST_PASSWORD, projectId });
  const memory = ctx.get('pocketbaseMemory');
  assert.ok(memory, 'the backend did not provide ctx.pocketbaseMemory');

  applyConsole(ctx, {
    backupDir,
    snapshotDir,
    dataDir,
    newpiVersion: VERSIONS.newpi,
    pocketbaseVersion: VERSIONS.pocketbase,
    announce: false,
  });
  const console = ctx.get('memoryConsole');
  assert.ok(console, 'the console did not provide ctx.memoryConsole');

  return {
    console,
    memory,
    routes,
    tapped,
    /** Call one action the way the browser's request would. */
    call: (action, params) => console.dispatch(action, params),
    /** Call one action through the HTTP surface, as the section does. */
    async http(action, params) {
      const route = routes.get(CONSOLE_ENDPOINT);
      assert.ok(route, 'the console endpoint is not registered');
      const response = await route.fetch(
        new Request(`http://127.0.0.1${CONSOLE_ENDPOINT}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, params }),
        }),
      );
      return { status: response.status, body: await response.json() };
    },
  };
}

/** One temporary workspace per test. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'newpi-console-test-'));
  const dirs = {
    root,
    backups: join(root, 'backups'),
    snapshots: join(root, 'pb_data-backups'),
    data: join(root, 'pb_data'),
  };
  await Promise.all([
    mkdir(dirs.backups, { recursive: true }),
    mkdir(dirs.snapshots, { recursive: true }),
  ]);
  return dirs;
}

/**
 * Run one archive command and wait for it.
 *
 * @param command - the executable.
 * @param args - its arguments.
 * @param options - an optional working directory.
 * @throws when the command exits non-zero.
 */
async function archiveCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.on('error', reject);
  });
}

test('the console exposes exactly one authenticated endpoint', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const booted = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    assert.deepEqual([...booted.routes.keys()], [CONSOLE_ENDPOINT]);
    assert.equal(CONSOLE_ENDPOINT, '/api/newpi.console');
    // The interface injection is registered as a tap, not as a web server
    // route: nothing the console does is reachable without the session cookie.
    assert.equal(booted.tapped.length, 1);
    const html = booted.tapped[0]('<html><head></head><body></body></html>');
    assert.ok(html.includes(`<style ${CONSOLE_ATTRIBUTE}>`));
    assert.ok(html.includes(`<script ${CONSOLE_ATTRIBUTE}>`));
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('a request cannot name a project, and an undeclared parameter is refused', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const booted = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    await booted.call('memory.page', {});

    // Every action that could leak another project's memory refuses the key
    // outright, before any query is built.
    for (const [action, params] of [
      ['memory.page', { project_id: 'beta' }],
      ['memory.page', { projectId: 'beta' }],
      ['memory.status', { project_id: 'beta' }],
      ['memory.read', { id: 'x', project_id: 'beta' }],
      ['memory.delete', { id: 'x', confirm: true, project_id: 'beta' }],
      ['backup.status', { project_id: 'beta' }],
      ['backup.restore', { path: '/tmp/x.zip', confirm: true, project_id: 'beta' }],
    ]) {
      await assert.rejects(booted.call(action, params), (error) => {
        assert.equal(error.code, 'CONSOLE_INVALID_ARGS', `${action} accepted a project scope`);
        assert.match(error.message, /unknown parameter/);
        return true;
      });
    }

    // The scope itself never crosses the wire: the interface learns it, and
    // cannot set it.
    const status = await booted.call('memory.status', {});
    assert.equal(status.project_id, 'alpha');

    const http = await booted.http('memory.page', { project_id: 'beta' });
    assert.equal(http.status, 400);
    assert.equal(http.headers === undefined, true);
    assert.equal(http.body.ok, false);
    assert.equal(http.body.error.code, 'CONSOLE_INVALID_ARGS');
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('the validator refuses anything an action does not declare', () => {
  assert.deepEqual(assertParams(undefined, ['id']), {});
  assert.deepEqual(assertParams({ id: 'a' }, ['id']), { id: 'a' });
  assert.throws(() => assertParams({ nope: 1 }, ['id']), ConsoleError);
  assert.throws(() => assertParams([1], ['id']), ConsoleError);
});

test('memory.status counts by kind and reports the newest write', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    const beta = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'beta',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });

    const empty = await alpha.call('memory.status', {});
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.kinds, { note: 0, decision: 0, bugfix: 0, lesson: 0 });
    assert.equal(empty.last_write, '');

    await alpha.memory.remember({ content: 'alpha note', kind: 'note' });
    await alpha.memory.remember({ content: 'alpha bug', kind: 'bugfix' });
    await beta.memory.remember({ content: 'beta note', kind: 'note' });

    const stats = await alpha.call('memory.status', {});
    assert.equal(stats.project_id, 'alpha');
    assert.equal(stats.total, 2, 'another project must not be counted');
    assert.equal(stats.kinds.note, 1);
    assert.equal(stats.kinds.bugfix, 1);
    assert.equal(stats.kinds.lesson, 0);
    assert.ok(stats.last_write.length > 0);
    assert.equal(new Date(stats.last_write).getTime() > 0, true, 'last_write is ISO 8601');
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('the listing is scoped, paginated, filtered, and carries no content', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    const beta = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'beta',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });

    for (let index = 0; index < 7; index += 1) {
      await alpha.memory.remember({ content: `widget note ${index}`, kind: 'note' });
    }
    await alpha.memory.remember({ content: 'the only decision', kind: 'decision' });
    await beta.memory.remember({ content: 'widget note from beta', kind: 'note' });

    const first = await alpha.call('memory.page', { perPage: 3, page: 1 });
    assert.equal(first.total, 8, 'beta\'s memory must not be in the total');
    assert.equal(first.items.length, 3);
    assert.ok(
      first.items.every((item) => item.content === undefined && item.project_id === undefined),
      'a listing must not carry the text or the scope of a memory, only a preview',
    );
    assert.ok(first.items[0].preview.length > 0);
    assert.equal(first.items[0].characters > 0, true, 'the preview reports the full length');

    const second = await alpha.call('memory.page', { perPage: 3, page: 2 });
    assert.notEqual(first.items[0].id, second.items[0].id);

    const notes = await alpha.call('memory.page', { kind: 'note', perPage: 100 });
    assert.equal(notes.total, 7);
    assert.ok(notes.items.every((item) => item.kind === 'note'));

    const searched = await alpha.call('memory.page', { query: 'only decision', perPage: 100 });
    assert.equal(searched.total, 1);
    assert.equal(searched.items[0].kind, 'decision');

    await assert.rejects(alpha.call('memory.page', { kind: 'gossip' }), /kind must be one of/);
    await assert.rejects(alpha.call('memory.page', { perPage: 0 }), /between 1 and 100/);
    await assert.rejects(alpha.call('memory.page', { query: 'x'.repeat(501) }), /at most 500/);
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('reading one memory is scoped, and a foreign id is indistinguishable from a missing one', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    const beta = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'beta',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });

    const secret = await alpha.memory.remember({
      content: 'alpha only: never touch the billing table',
      kind: 'lesson',
    });
    const own = await alpha.call('memory.read', { id: secret.id });
    assert.equal(own.memory.content, 'alpha only: never touch the billing table');
    assert.equal(own.memory.kind, 'lesson');

    await assert.rejects(beta.call('memory.read', { id: secret.id }), (error) => {
      assert.equal(error.code, 'CONSOLE_NOT_FOUND');
      assert.equal(error.status, 404);
      return true;
    });
    await assert.rejects(beta.call('memory.read', { id: 'does-not-exist' }), /Aucun souvenir/);
    await assert.rejects(alpha.call('memory.read', { id: '   ' }), /non-empty string/);
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('deleting needs an explicit confirmation, and cannot cross projects', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    const beta = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'beta',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });

    const kept = await alpha.memory.remember({ content: 'keep me', kind: 'note' });

    await assert.rejects(alpha.call('memory.delete', { id: kept.id }), (error) => {
      assert.equal(error.code, 'CONSOLE_CONFIRMATION_REQUIRED');
      return true;
    });
    await assert.rejects(alpha.call('memory.delete', { id: kept.id, confirm: false }), /confirmée/);
    assert.equal(pocketbase.records.length, 1, 'an unconfirmed delete must not remove anything');

    // Another project cannot delete it, and is told the same thing it would be
    // told for an id that never existed.
    const foreign = await beta.call('memory.delete', { id: kept.id, confirm: true });
    assert.deepEqual(foreign, { id: kept.id, deleted: false });
    assert.equal(pocketbase.records.length, 1);

    const removed = await alpha.call('memory.delete', { id: kept.id, confirm: true });
    assert.deepEqual(removed, { id: kept.id, deleted: true });
    assert.equal(pocketbase.records.length, 0);
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('a backup round trips: create, delete, restore, and the memory comes back', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    // A second project writes through its own console, so the archive has to
    // carry both and the restore has to bring both back.
    const beta = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'beta',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });

    const doomed = await alpha.memory.remember({ content: 'restore me please', kind: 'bugfix' });
    await beta.memory.remember({ content: 'beta keeps its own', kind: 'note' });

    const created = await alpha.call('backup.create', { pick: false });
    assert.equal(created.cancelled, false);
    assert.ok(created.bytes > 0);
    assert.equal(created.manifest.format, BACKUP_FORMAT);
    assert.equal(created.manifest.format_version, 1);
    assert.equal(created.manifest.created_by.version, VERSIONS.newpi);
    assert.equal(created.manifest.pocketbase.version, VERSIONS.pocketbase);
    assert.equal(created.manifest.memories.total, 2);
    assert.deepEqual(created.manifest.contents.entries, [
      'pb_data/data.db',
      'pb_data/auxiliary.db',
      'pb_data/types.d.ts',
    ]);
    assert.match(created.manifest.contents.sha256['pb_data/data.db'], /^[0-9a-f]{64}$/);
    assert.ok(created.path.startsWith(dirs.backups), 'a backup with pick:false lands in the folder');

    // What the archive is, verified before anything is touched.
    const inspected = await alpha.call('backup.inspect', { path: created.path });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.cancelled, false);
    assert.equal(inspected.manifest.memories.total, 2);
    assert.equal(inspected.current.total, 2, 'the archive describes the whole database');
    assert.equal(inspected.current.project_total, 1, 'and this project\'s share of it');

    // The deletion the restore must undo.
    await alpha.call('memory.delete', { id: doomed.id, confirm: true });
    assert.equal((await alpha.call('memory.status', {})).total, 0);
    assert.equal((await beta.call('memory.status', {})).total, 1);

    const report = await alpha.call('backup.restore', { path: created.path, confirm: true });
    assert.equal(report.rolled_back, false);
    assert.equal(report.verification.matches, true);
    assert.equal(report.verification.expected_total, 2);
    assert.equal(report.verification.total, 2);
    assert.equal(report.verification.project_total, 1);
    assert.equal(report.verification.project_id, 'alpha');
    assert.ok(report.safety.path.includes('avant-restauration'), 'a safety archive is always taken');
    assert.equal(await readFile(report.safety.path).then((bytes) => bytes.byteLength > 0), true);
    assert.equal(pocketbase.state.restores, 1);

    // The deleted memory is back, with its id, and the other project is intact.
    const restored = await alpha.call('memory.read', { id: doomed.id });
    assert.equal(restored.memory.content, 'restore me please');
    assert.equal(restored.memory.kind, 'bugfix');
    const betaRows = await beta.call('memory.page', { perPage: 100 });
    assert.equal(betaRows.total, 1);
    assert.equal(betaRows.items[0].preview, 'beta keeps its own');

    // The console is still usable afterwards: the client re-authenticated
    // across the restart and the collection answers.
    assert.match(await alpha.memory.health(), /collection memories/);
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('a restore holds memory writes off until it is done', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    await alpha.memory.remember({ content: 'before the backup', kind: 'note' });
    const created = await alpha.call('backup.create', { pick: false });

    // A write that arrives while the restore holds the barrier must wait, and
    // must land after it, never inside the snapshot replacement.
    const restoring = alpha.call('backup.restore', { path: created.path, confirm: true });
    const deadline = Date.now() + 2000;
    while (alpha.memory._barrier === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.notEqual(alpha.memory._barrier, null, 'the restore must raise the write barrier');

    let writeSettled = false;
    const write = alpha.memory
      .remember({ content: 'written during the restore', kind: 'note' })
      .then(() => {
        writeSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(writeSettled, false, 'the write must still be parked while the restore runs');

    const report = await restoring;
    assert.equal(report.verification.total, 1, 'the write must not be inside the restored snapshot');
    assert.equal(alpha.memory._barrier, null, 'the barrier is lifted when the restore ends');

    await write;
    assert.equal(writeSettled, true);
    const after = await alpha.call('memory.page', { perPage: 100 });
    assert.equal(after.total, 2, 'the parked write lands once the barrier lifts');
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('an archive this build cannot read is refused before anything is touched', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    await alpha.memory.remember({ content: 'the only memory', kind: 'note' });

    // A file that is not an archive at all.
    const junk = join(dirs.backups, 'not-a-backup.zip');
    await writeFile(junk, 'this is not a zip file');
    const refusedJunk = await alpha.call('backup.inspect', { path: junk });
    assert.equal(refusedJunk.ok, false);
    assert.equal(refusedJunk.code, 'ARCHIVE_CORRUPT');

    // An archive with no manifest: a zip, but not one of ours.
    const created = await alpha.call('backup.create', { pick: false });
    const plain = join(dirs.root, 'plain');
    await mkdir(plain, { recursive: true });
    await writeFile(join(plain, 'data.db'), Buffer.from('SQLite format 3\0'));
    const noManifest = join(dirs.backups, 'no-manifest.zip');
    await archiveCommand('/usr/bin/zip', ['-q', '-r', '-X', noManifest, 'data.db'], { cwd: plain });
    const refusedPlain = await alpha.call('backup.inspect', { path: noManifest });
    assert.equal(refusedPlain.ok, false);
    assert.equal(refusedPlain.code, 'MANIFEST_MISSING');
    assert.match(refusedPlain.message, /sauvegarde NewPi/);

    // A manifest that declares a newer format: the readable message matters
    // more than the refusal itself.
    const verdict = checkCompatibility(
      {
        format: BACKUP_FORMAT,
        format_version: MAX_READABLE_FORMAT_VERSION + 1,
        pocketbase: { version: VERSIONS.pocketbase },
        contents: { entries: ['pb_data/data.db'] },
      },
      { pocketbaseVersion: VERSIONS.pocketbase },
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'FORMAT_TOO_RECENT');
    assert.match(verdict.message, /trop récente/);
    assert.match(verdict.message, /Mettez NewPi à jour/);

    // A database written by a newer PocketBase than this NewPi embeds.
    const newer = checkCompatibility(
      {
        format: BACKUP_FORMAT,
        format_version: 1,
        pocketbase: { version: '0.99.1' },
        contents: { entries: ['pb_data/data.db'] },
      },
      { pocketbaseVersion: VERSIONS.pocketbase },
    );
    assert.equal(newer.ok, false);
    assert.equal(newer.code, 'POCKETBASE_TOO_RECENT');
    assert.match(newer.message, /plus récent/);

    // An older PocketBase is restorable, with a warning that says so.
    const older = checkCompatibility(
      {
        format: BACKUP_FORMAT,
        format_version: 1,
        pocketbase: { version: '0.39.0' },
        contents: { entries: ['pb_data/data.db'] },
      },
      { pocketbaseVersion: VERSIONS.pocketbase },
    );
    assert.equal(older.ok, true);
    assert.match(older.warning, /migrations/);

    // Restoring without a confirmation is refused, whatever the archive says.
    await assert.rejects(
      alpha.call('backup.restore', { path: created.path }),
      /confirmée explicitement/,
    );
    assert.equal(pocketbase.state.restores, 0, 'nothing may be replaced without a confirmation');
    await assert.rejects(
      alpha.call('backup.restore', { path: created.path, confirm: true, extra: 1 }),
      /unknown parameter/,
    );
    assert.equal(pocketbase.state.restores, 0);
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('an archive chosen in the window is taken in, and only a zip is', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    await alpha.memory.remember({ content: 'the only memory', kind: 'note' });
    const created = await alpha.call('backup.create', { pick: false });

    // What the window sends when the user picks a file: its name and its bytes.
    const archive = await readFile(created.path);
    const received = await alpha.call('backup.upload', {
      name: created.name,
      bytes: archive.toString('base64'),
    });
    assert.equal(received.bytes, archive.byteLength);
    assert.ok(received.path.endsWith(created.name));
    assert.ok(
      received.path.includes('.incoming'),
      'a file the user picked is held apart from the backups NewPi made',
    );
    // What was received is what gets inspected, and it still describes itself.
    const inspected = await alpha.call('backup.inspect', { path: received.path });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.manifest.format, 'newpi-memory-backup');
    assert.equal(inspected.manifest.memories.total, 1);

    // Anything that is not a zip is refused before it is written, and the
    // refusal says so rather than failing three steps later.
    await assert.rejects(
      alpha.call('backup.upload', {
        name: 'notes.txt',
        bytes: Buffer.from('this is not an archive').toString('base64'),
      }),
      /n'est pas une archive zip/,
    );
    // A path separator in the name cannot escape the holding directory.
    const nested = await alpha.call('backup.upload', {
      name: '../../escape.zip',
      bytes: archive.toString('base64'),
    });
    assert.equal(nested.path.includes('..'), false);
    assert.ok(nested.path.startsWith(dirs.backups));

    await assert.rejects(
      alpha.call('backup.upload', { name: 'x.zip', bytes: 'not base64 at all!' }),
      /base64/,
    );
    await assert.rejects(alpha.call('backup.upload', { name: '', bytes: 'AAAA' }), /name/);
    await assert.rejects(
      alpha.call('backup.upload', { name: 'x.zip', bytes: 'A'.repeat(400 * 1024 * 1024) }),
      (error) => {
        assert.equal(error.code, 'CONSOLE_ARCHIVE_TOO_LARGE');
        assert.equal(error.status, 413);
        return true;
      },
    );
    // And an inspect without a path is refused rather than guessing.
    await assert.rejects(alpha.call('backup.inspect', {}), /needs a path/);
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('a tampered archive is refused by its digest, not restored', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    const kept = await alpha.memory.remember({ content: 'original', kind: 'note' });
    const created = await alpha.call('backup.create', { pick: false });

    // Rewrite the database entry while leaving the manifest alone: the archive
    // is still a valid zip, so only the digest check can catch it.
    const tampered = join(dirs.backups, 'tampered.zip');
    const staging = await mkdtemp(join(dirs.root, 'tamper-'));
    await archiveCommand('/usr/bin/unzip', ['-o', '-q', created.path, '-d', staging]);
    await writeFile(
      join(staging, 'pb_data', 'data.db'),
      Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('[]')]),
    );
    await archiveCommand('/usr/bin/zip', ['-q', '-r', '-X', tampered, 'manifest.json', 'pb_data'], {
      cwd: staging,
    });

    const inspected = await alpha.call('backup.inspect', { path: tampered });
    assert.equal(inspected.ok, true, 'the manifest itself is intact');

    await assert.rejects(
      alpha.call('backup.restore', { path: tampered, confirm: true }),
      (error) => {
        assert.match(error.message, /empreinte/);
        assert.match(error.message, /remise dans son état précédent/);
        return true;
      },
    );
    // The tampered archive never became the database: the only replacement the
    // sidecar performed is the rollback to the safety archive, and the memory
    // that was there before is still there.
    assert.equal(pocketbase.state.restores, 1, 'only the rollback may replace the database');
    assert.equal((await alpha.call('memory.status', {})).total, 1);
    assert.equal((await alpha.call('memory.read', { id: kept.id })).memory.content, 'original');

    await rm(staging, { recursive: true, force: true });
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('the backup listing reports local archives, newest first, with their manifests', async () => {
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  try {
    const alpha = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: dirs.backups,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    await alpha.memory.remember({ content: 'something to save', kind: 'note' });

    const before = await alpha.call('backup.status', {});
    assert.deepEqual(before.backups, []);
    assert.equal(before.total, 0);
    assert.equal(before.versions.newpi, VERSIONS.newpi);
    assert.equal(before.directory, dirs.backups);
    assert.equal(before.project_id, 'alpha');

    await alpha.call('backup.create', { pick: false });
    await alpha.call('backup.create', { pick: false });

    const status = await alpha.call('backup.status', {});
    assert.equal(status.total, 2);
    assert.equal(status.backups.length, 2);
    assert.equal(status.backups[0].kind, 'manual');
    assert.equal(status.backups[0].manifest.total, 1);
    assert.ok(status.backups[0].bytes > 0);
    assert.ok(status.backups[0].name.endsWith('.zip'));
    assert.equal(status.busy, false);

    // The sidecar's own snapshot is removed once it has been exported, so
    // `pb_data/backups` does not grow by one file per backup the user makes.
    assert.equal(pocketbase.state.snapshots.length, 0);
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('the manifest and its compatibility rules are pure functions of their inputs', () => {
  assert.deepEqual(parseVersion('0.40.4'), { major: 0, minor: 40, patch: 4 });
  assert.equal(parseVersion('nonsense'), null);
  assert.equal(compareVersions('0.40.4', '0.40.4'), 0);
  assert.equal(compareVersions('0.40.3', '0.40.4'), -1);
  assert.equal(compareVersions('0.41.0', '0.40.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('nonsense', '0.1.0'), -1);

  const at = new Date('2026-09-12T20:52:03.253Z');
  const manifest = buildManifest({
    at,
    newpiVersion: '0.1.0',
    pocketbaseVersion: '0.40.4',
    projectId: 'twin',
    collection: 'memories',
    entries: [{ name: 'pb_data/data.db', bytes: 10, sha256: 'a'.repeat(64) }],
    memories: { total: 3 },
  });
  assert.equal(manifest.created_at, at.toISOString());
  assert.deepEqual(manifest.reader, {
    min_format_version: 1,
    max_format_version: MAX_READABLE_FORMAT_VERSION,
  });
  assert.equal(manifest.source.project_id, 'twin');
  assert.equal(summarizeManifest(manifest).total, 3);

  // A manifest that parses but describes something else is refused with words
  // a person can act on.
  const notOurs = readManifest(Buffer.from('{"format":"something-else"}'), {
    pocketbaseVersion: '0.40.4',
  });
  assert.equal(notOurs.ok, false);
  assert.equal(notOurs.code, 'FORMAT_UNKNOWN');
  assert.equal(
    readManifest(Buffer.from('not json'), { pocketbaseVersion: '0.40.4' }).code,
    'MANIFEST_UNREADABLE',
  );

  const incomplete = checkCompatibility(
    {
      format: BACKUP_FORMAT,
      format_version: 1,
      pocketbase: { version: '0.40.4' },
      contents: { entries: ['manifest.json'] },
    },
    { pocketbaseVersion: '0.40.4' },
  );
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.code, 'ARCHIVE_INCOMPLETE');

  // The file name is local time, so it is computed here rather than written
  // out: a fixture with a fixed string would fail in another time zone.
  const pad = (value) => String(value).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  assert.equal(
    backupFileName({ at, label: 'avant-restauration' }),
    `newpi-memory-avant-restauration-${stamp}.zip`,
  );
  assert.equal(backupFileName({ at }), `newpi-memory-${stamp}.zip`);
});

test('the destination panel is asked for once the folder exists, and its answer is honoured', async () => {
  // The real panel waits for a person, so the panel itself is replaced here and
  // what is checked is everything around it: the folder the panel opens at must
  // exist (AppleScript refuses to coerce `POSIX file` for a folder that is not
  // there, and the panel then fails instead of asking), the answer must be used
  // as given, and a cancel must be an answer rather than an error.
  const dirs = await workspace();
  const pocketbase = await startFakePocketBase({ snapshots: dirs.snapshots });
  const missing = join(dirs.root, 'not-created-yet', 'backups');
  try {
    const asked = [];
    const booted = await bootConsole({
      baseUrl: pocketbase.baseUrl,
      projectId: 'alpha',
      backupDir: missing,
      snapshotDir: dirs.snapshots,
      dataDir: dirs.data,
    });
    await booted.memory.remember({ content: 'something worth saving', kind: 'note' });

    // 1. A folder that does not exist yet is created *before* the panel is
    //    asked, so the panel opens at a real place.
    booted.console.backups.panel = async (options) => {
      const info = await stat(options.directory).catch(() => null);
      asked.push({ ...options, existed: info !== null && info.isDirectory() });
      return null;
    };
    const cancelled = await booted.console.dispatch('backup.create', { pick: true });
    assert.equal(cancelled.cancelled, true, 'a cancel must come back as a cancellation');
    assert.equal(asked.length, 1);
    assert.equal(asked[0].existed, true, 'the panel was asked for before its folder existed');
    assert.equal(asked[0].directory, missing);
    assert.match(asked[0].name, /^newpi-memory-\d{8}-\d{6}\.zip$/);
    assert.match(asked[0].prompt, /sauvegarde/);

    // 2. The path the panel returns is the path the archive is written to, with
    //    the extension added when the user did not type one.
    const chosen = join(dirs.root, 'chosen-by-the-panel');
    booted.console.backups.panel = async () => chosen;
    const created = await booted.console.dispatch('backup.create', { pick: true });
    assert.equal(created.path, `${chosen}.zip`);
    assert.ok((await readFile(`${chosen}.zip`)).byteLength > 0, 'no archive was written');
    assert.equal(created.manifest.memories.total, 1);

    // 3. A backup that is not asked for a destination still works when its
    //    folder is missing: the folder comes back with it.
    await rm(missing, { recursive: true, force: true });
    const withoutPanel = await booted.console.dispatch('backup.create', { pick: false });
    assert.equal(withoutPanel.cancelled, false);
    assert.ok(withoutPanel.path.startsWith(missing), 'the archive did not land in the backups folder');
    assert.ok((await stat(missing)).isDirectory(), 'the backups folder was not restored');
    assert.ok((await readFile(withoutPanel.path)).byteLength > 0);

    // 4. A path that already ends in .zip is left alone.
    booted.console.backups.panel = async () => `${chosen}-twice.zip`;
    const again = await booted.console.dispatch('backup.create', { pick: true });
    assert.equal(again.path, `${chosen}-twice.zip`);
  } finally {
    await pocketbase.stop();
    await rm(dirs.root, { recursive: true, force: true });
  }
});

test('the backup engine refuses to run two operations at once', async () => {
  const backups = new MemoryBackups({
    memory: { projectId: 'alpha', backupCreate: async () => 'x.zip', backupDelete: async () => {} },
    directory: '/tmp',
    snapshots: '/tmp',
    versions: VERSIONS,
  });
  backups.busy = true;
  await assert.rejects(backups.create({ pick: false }), /déjà en cours/);
  await assert.rejects(backups.restore({ path: '/tmp/x.zip', confirm: true }), /déjà en cours/);
  backups.busy = false;
});

test('every preview is one flattened line, and every timestamp is ISO', () => {
  assert.equal(previewOf('a\n\n  b\tc '), 'a b c');
  assert.equal(previewOf('x'.repeat(400)).length <= 241, true);
  assert.equal(previewOf('x'.repeat(400)).endsWith('…'), true);
  // A cut lands on a word boundary when one is close enough to the limit.
  const words = `${'word '.repeat(60)}end`;
  assert.equal(/word…$/.test(previewOf(words)), true, previewOf(words).slice(-12));

  assert.equal(toIsoTimestamp('2026-09-12 20:55:47.983Z'), '2026-09-12T20:55:47.983Z');
  assert.equal(toIsoTimestamp(''), '');
  assert.equal(toIsoTimestamp('not a date'), '');

  const summary = toMemorySummary({
    id: 'abc',
    kind: 'note',
    created_at: '2026-09-12 20:55:47.983Z',
    content: 'hello world',
  });
  assert.equal(summary.preview, 'hello world');
  assert.equal(summary.characters, 11);
  assert.equal(toMemorySummary({ id: 'abc' }), null);
  assert.deepEqual(MEMORY_KINDS, ['note', 'decision', 'bugfix', 'lesson']);
});

test('the injected script is well formed, scoped, and keeps user data out of markup', async () => {
  const script = consoleScript();
  // It is syntactically valid JavaScript, which is the one thing a string
  // transform can get wrong invisibly.
  assert.doesNotThrow(() => new Function(script));

  // The client code is a real function, so what is shipped is what is checked.
  assert.equal(script.startsWith('(function clientConsole()'), true);

  // No markup from data: every value the section renders goes through
  // textContent, and innerHTML is never used at all.
  assert.equal(script.includes('innerHTML'), false);
  assert.equal(script.includes('outerHTML'), false);
  assert.equal(script.includes('insertAdjacentHTML'), false);
  assert.equal(script.includes('document.write'), false);
  // It knows only the endpoint; no URL, credential or project scope is baked in.
  assert.equal(script.includes('127.0.0.1'), false);
  assert.equal(script.includes('password'), false);
  // The engine's panel list is deliberately *not* a seat any more: the shell
  // renders it inside the panel row's glyph, so an injected button there lands
  // inside another plugin's button. See the seat regression test below.
  assert.deepEqual(NAV_SEATS, ['sidebar.footer.action']);
  assert.equal(script.includes('sidebar.footer.action'), true);
  // The one place a project scope appears is reading it back out of the chosen
  // archive's manifest, which the user picked. It is never sent to the host.
  assert.equal(/call\([^)]*project_id/.test(script), false);
  assert.equal(script.includes('manifest.source.project_id'), true);

  const style = consoleStyle();
  // Every selector is anchored on the console's own classes or marker.
  assert.equal(/(^|[},])\s*(body|html|\*|button|input|div)\s*\{/.test(style), false);
  assert.equal(style.includes(`[${CONSOLE_ATTRIBUTE}]`), true);
  assert.equal(style.includes('--dsw-alias-label-primary'), true, 'the theme is inherited');
  // A filled button must take its text colour from the theme's own pairing:
  // measured on the shipped dark theme, the brand fill is white, so hard-coded
  // white text made the primary button invisible.
  assert.equal(style.includes('background:var(--dsw-alias-button-primary-fill'), true);
  assert.equal(style.includes('color:var(--dsw-alias-label-primary-foreground'), true);
});

test('the panel renders the empty state, the listing and a memory, against a fake DOM', async () => {
  // The script only ever runs in the page, so this runs it for real against a
  // DOM small enough to read — including a fetch that answers from a script.
  const calls = [];
  const answers = {
    'memory.page': { project_id: 'alpha', items: [], total: 0, page: 1, perPage: 25 },
    'memory.status': {
      project_id: 'alpha',
      total: 0,
      kinds: { note: 0, decision: 0, bugfix: 0, lesson: 0 },
      last_write: '',
    },
  };
  const { document, fetch: fakeFetch, flush } = fakeDocument({
    fetch: async (url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      const value = answers[request.action];
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value }),
      };
    },
  });
  globalThis.document = document;
  globalThis.window = { addEventListener() {}, console };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.fetch = fakeFetch;

  try {
    new Function(consoleScript())();
    // The two sidebar rows are added to the sidebar's own list.
    const slot = document.querySelector('[data-slot="sidebar.footer.action"]');
    assert.ok(slot, 'the footer seat was not found');
    assert.deepEqual(slot.children.map((child) => textOf(child).trim()), ['Memory', 'Backup']);

    // Opening Memory loads the listing and the counters.
    slot.children[0].click();
    await flush();
    assert.ok(calls.some((call) => call.action === 'memory.page'));
    assert.ok(calls.some((call) => call.action === 'memory.status'));
    const root = document.body.children.find((node) => node.className === 'npc-root');
    assert.equal(root.hidden, false, 'the panel opens');
    const body = root.children[0].children[1];
    assert.match(textOf(body), /Aucun souvenir dans ce projet/);
    // The fake DOM keeps each node's own text, so a composed label reads with
    // the whitespace of its parts rather than as one string.
    assert.match(textOf(body), /0\s+souvenirs/);
    assert.match(textOf(body), /dernière écriture/);
    assert.match(textOf(body), /note 0 · decision 0 · bugfix 0 · lesson 0/);
    assert.match(textOf(body), /Tous les kinds/);
    // The search field is found by its type, since a placeholder is not text.
    const search = findNode(body, (node) => node.type === 'search');
    assert.ok(search, 'the search field is missing');
    assert.equal(search.placeholder, 'Rechercher dans le contenu');
    assert.equal(calls[0].params.project_id, undefined, 'the section never sends a project scope');

    // Opening Backup asks the host for its status.
    slot.children[1].click();
    await flush();
    assert.ok(calls.some((call) => call.action === 'backup.status'));
    assert.match(textOf(body), /Créer une sauvegarde/);
    assert.match(textOf(body), /Restaurer une sauvegarde/);
    assert.match(textOf(body), /Ouvrir le dossier des sauvegardes/);
    assert.match(textOf(body), /Aucune sauvegarde locale/);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.MutationObserver;
    delete globalThis.fetch;
  }
});

/** The first node below (or including) `node` that matches a predicate. */
function findNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

/** The text of a node and everything below it. */
function textOf(node) {
  return [node.textContent, ...(node.children ?? []).map(textOf)].join(' ');
}

/**
 * The smallest DOM the injected script touches.
 *
 * It is deliberately not a DOM implementation: it supports what the console
 * uses — element creation, `textContent`, class names, `querySelector` over
 * the two attributes the script asks for, event listeners and clicks — and
 * nothing else, so a new DOM API in the script fails this test rather than
 * passing unnoticed.
 */
function fakeDocument({ fetch: fetchImpl, slots = ['sidebar.footer.action'] }) {

  function element(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      value: '',
      type: '',
      hidden: false,
      disabled: false,
      style: {},
      children: [],
      attributes: {},
      listeners: {},
      /** The rail adaptation adds and removes one class; nothing reads classes
       * back except the tests' own assertions. */
      classList: {
        add() {},
        remove() {},
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      addEventListener(name, handler) {
        (this.listeners[name] = this.listeners[name] ?? []).push(handler);
      },
      click() {
        for (const handler of this.listeners.click ?? []) handler({ target: this });
      },
      focus() {},
      setSelectionRange() {},
      /** Present a file as if the operating system's panel had returned one. */
      choose(file) {
        this.files = [file];
        for (const handler of this.listeners.change ?? []) handler({ target: this });
      },
      querySelector(selector) {
        const name = /\[data-slot="([^"]+)"\]/.exec(selector)?.[1];
        if (name !== undefined) {
          if (this.attributes['data-slot'] === name) return this;
          for (const child of this.children) {
            const found = child.querySelector(selector);
            if (found) return found;
          }
          return null;
        }
        const marker = /\[(data-newpi-console-nav)[^\]]*\]/.exec(selector)?.[1];
        if (marker !== undefined) {
          for (const child of this.children) {
            if (child.attributes[marker] !== undefined) return child;
            const found = child.querySelector(selector);
            if (found) return found;
          }
        }
        return null;
      },
    };
    return node;
  }

  const body = element('body');
  for (const name of slots) {
    const seat = element('div');
    seat.setAttribute('data-slot', name);
    body.appendChild(seat);
  }
  const documentElement = element('html');

  return {
    document: {
      documentElement,
      body,
      createElement: element,
      createElementNS: (_namespace, tag) => element(tag),
      querySelector: (selector) => body.querySelector(selector),
    },
    fetch: (...args) => fetchImpl(...args),
    /** Let every queued promise settle. */
    async flush() {
      for (let round = 0; round < 12; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test('the restore flow reads the archive the window chose, and shows its metadata', async () => {
  // The archive chooser is a file input, so this runs the real client code with
  // a stand-in for the panel: what a user does is click the button, pick a
  // file, and read the screen that follows.
  const calls = [];
  const reading = 'UEsDBAoAAAAAAA=='; // a base64 payload; the host decides what it is
  const answers = {
    'backup.status': {
      directory: '/state/backups',
      busy: false,
      activity: '',
      versions: { newpi: '0.1.0', pocketbase: '0.40.4' },
      backups: [],
      listed: 0,
      total: 0,
      project_id: 'alpha',
    },
    'backup.upload': { path: '/state/backups/.incoming/archive.zip', bytes: 1234 },
    'backup.inspect': {
      cancelled: false,
      archive: { path: '/state/backups/.incoming/archive.zip', name: 'archive.zip', bytes: 1234 },
      ok: true,
      code: 'OK',
      message: 'Sauvegarde compatible.',
      manifest: {
        format: 'newpi-memory-backup',
        format_version: 1,
        created_at: '2026-09-12T21:15:41.211Z',
        created_by: { name: 'NewPi', version: '0.1.0' },
        pocketbase: { version: '0.40.4' },
        source: { project_id: 'alpha' },
        memories: { total: 3 },
        contents: { entries: ['pb_data/data.db'], bytes: 1000 },
      },
      current: { project_id: 'alpha', project_total: 3, total: 4 },
    },
  };
  const { document, fetch: fakeFetch, flush } = fakeDocument({
    slots: ['sidebar.footer.action'],
    fetch: async (url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: answers[request.action] }),
      };
    },
  });
  globalThis.document = document;
  globalThis.window = { addEventListener() {} };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.fetch = fakeFetch;
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = `data:application/zip;base64,${reading}`;
      this.onload();
    }
  };

  try {
    new Function(consoleScript())();
    const footer = document.querySelector('[data-slot="sidebar.footer.action"]');
    footer.children[1].click();
    await flush();

    const panel = document.body.children.find((node) => node.className === 'npc-root');
    const dialog = panel.children[0];
    const body = dialog.children[1];
    const chooser = findNode(dialog, (node) => node.attributes['data-newpi-console-chooser'] !== undefined);
    assert.ok(chooser, 'the window has no archive chooser');
    assert.equal(chooser.type, 'file');
    assert.equal(chooser.accept, '.zip,application/zip');

    // "Restaurer une sauvegarde" opens the panel the window owns.
    let clicked = 0;
    chooser.click = () => {
      clicked += 1;
    };
    findNode(body, (node) => node.textContent === 'Restaurer une sauvegarde').click();
    assert.equal(clicked, 1, 'the archive chooser was not opened');

    // The operating system hands back a file, and the flow continues by itself.
    chooser.choose({ name: 'archive.zip', size: 1234 });
    await flush();
    assert.deepEqual(calls.map((call) => call.action), [
      'backup.status',
      'backup.upload',
      'backup.inspect',
    ]);
    // The bytes travel as base64, without the data URL prefix.
    assert.equal(calls[1].params.name, 'archive.zip');
    assert.equal(calls[1].params.bytes, reading);
    assert.deepEqual(calls[2].params, { path: '/state/backups/.incoming/archive.zip' });

    // And the screen a user reads before confirming is on the page.
    const text = textOf(body);
    assert.match(text, /newpi-memory-backup/);
    assert.match(text, /Souvenirs dans l’archive/);
    assert.match(text, /Restaurer remplace toute la mémoire locale actuelle/);
    assert.ok(
      findNode(body, (node) => node.textContent === 'Restaurer et remplacer la mémoire locale'),
      'the confirmation button is missing',
    );
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.MutationObserver;
    delete globalThis.fetch;
    delete globalThis.FileReader;
  }
});

test('the rows land in the footer seat, and never in the engine’s panel list', async () => {
  // Both seats are rendered here, which is what the application does once the
  // file console registers a real panel. The rows must still go to the footer:
  // `sidebar.panellist` is where the *shell* renders the component an occupant
  // registered, and that component is drawn inside the panel row's own glyph
  // box. Appending an injected button there put Memory and Backup inside the
  // Files button — stacked in a 16-pixel box, reading as one label, and
  // swallowing every click meant for Files. This is that regression, kept.
  const calls = [];
  const { document, fetch: fakeFetch } = fakeDocument({
    slots: ['sidebar.panellist', 'sidebar.footer.action'],
    fetch: async (url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      const values = {
        'memory.page': { project_id: 'alpha', items: [], total: 0, page: 1, perPage: 25 },
        'memory.status': {
          project_id: 'alpha',
          total: 0,
          kinds: { note: 0, decision: 0, bugfix: 0, lesson: 0 },
          last_write: '',
        },
      };
      return { ok: true, status: 200, json: async () => ({ ok: true, value: values[request.action] }) };
    },
  });

  globalThis.document = document;
  globalThis.window = { addEventListener() {} };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.fetch = fakeFetch;
  try {
    new Function(consoleScript())();
    const panellist = document.querySelector(`[data-slot="${PANELLIST_SLOT}"]`);
    assert.ok(panellist !== null, 'this build renders the panel list');
    assert.deepEqual(
      panellist.children,
      [],
      'the panel list belongs to the shell; an injected row must not be put in it',
    );
    const footer = document.querySelector('[data-slot="sidebar.footer.action"]');
    assert.ok(footer, 'the footer seat is missing');
    assert.deepEqual(footer.children.map((child) => textOf(child).trim()), ['Memory', 'Backup']);
    // And the sections open from there.
    footer.children[1].click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((call) => call.action), ['backup.status']);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.MutationObserver;
    delete globalThis.fetch;
  }
});

test('the save panel script compiles with the real AppleScript compiler', async () => {
  // A panel script is a string the operating system compiles, and it waits for
  // a person: neither the compiler nor the wait can be skipped in a test, so
  // the compiler is the part that is checked here. It caught a real defect —
  // two statements joined without a line break, which made every save panel
  // fail with a syntax error the moment it was opened.
  const dir = await mkdtemp(join(tmpdir(), 'newpi-applescript-'));
  const script = savePanelScript({
    prompt: 'Enregistrer la sauvegarde de la mémoire NewPi',
    name: 'newpi-memory-20260912-232654.zip',
    directory: '/Users/x/Library/Application Support/NewPi/backups',
  });

  assert.equal(script.split('\n').length, 2, 'each statement needs its own line');
  assert.ok(!script.includes(')return'), 'statements must not be glued together');
  // A quote in the pre-filled name cannot end the literal early.
  const hostile = savePanelScript({
    prompt: 'a "quoted" prompt',
    name: 'we"ird.zip',
    directory: '/tmp/a\\b',
  });
  assert.ok(hostile.includes('\\"'), 'quotes must be escaped');

  const source = join(dir, 'panel.applescript');
  await writeFile(source, script);
  await archiveCommand('/usr/bin/osacompile', ['-o', join(dir, 'panel.scpt'), source]);
  await writeFile(source, hostile);
  await archiveCommand('/usr/bin/osacompile', ['-o', join(dir, 'hostile.scpt'), source]);
  await rm(dir, { recursive: true, force: true });
});

test('the panel macOS path helpers quote and classify as advertised', () => {
  assert.equal(appleScriptString('/tmp/a"b'), '"/tmp/a\\"b"');
  assert.equal(appleScriptString('/tmp/a\\b'), '"/tmp/a\\\\b"');
  assert.equal(panelOutcome({ code: 1, stderr: 'execution error: User canceled. (-128)' }), 'cancelled');
  assert.equal(panelOutcome({ code: 1, stderr: 'No user interaction allowed. (-1713)' }), 'no-session');
  assert.equal(panelOutcome({ code: 1, stderr: 'something else' }), 'failed');
  // A panel whose process was killed ended without an answer: the flow was
  // abandoned, so nothing was chosen and nothing failed.
  assert.equal(panelOutcome({ code: 1, stderr: '', signal: 'SIGTERM' }), 'cancelled');
});
