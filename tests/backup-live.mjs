#!/usr/bin/env node
/**
 * Live proof that the Memory and Backup sections work against the real
 * PocketBase binary.
 *
 * The unit suite in `tests/memory-console.test.mjs` runs against an in-process
 * fake, so it proves the console's logic and nothing about PocketBase. This
 * script closes that gap, and follows the acceptance list exactly:
 *
 *   1. create memories in two isolated projects;
 *   2. check that one project's view shows only its own memories;
 *   3. create a backup through the console;
 *   4. delete a memory through the console;
 *   5. restore the backup through the console;
 *   6. check that the deleted memory is back, that the other project is intact,
 *      and that PocketBase is healthy again;
 *   7. check that neither the credential nor the sidecar's address reaches the
 *      interface.
 *
 * Everything it asserts is read from the real database afterwards, with
 * `sqlite3`, so the proof does not rest on the console's own reporting.
 *
 * Run it with `pnpm run test:backup`.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  POCKETBASE_ASSET,
  POCKETBASE_SHA256,
  POCKETBASE_ARCHIVE_PATH,
} from '../scripts/pocketbase-pin.mjs';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Credentials this run provisions. Random per run, never reused. */
const IDENTITY = 'newpi-backup-test@local.test';
const PASSWORD = `backup-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** Log one step so a failure is attributable. */
function step(message) {
  console.log(`  ${message}`);
}

/** Resolve the Cordis runtime the plugins are written against. */
async function cordisModule() {
  const candidates = [
    process.env.DSH_PROFILE_MODULES,
    `${process.env.HOME}/.dsh/profiles/node_modules`,
    `${process.env.HOME}/.local/lib/node_modules/@deepseek-ai/dsh/node_modules`,
  ].filter((candidate) => typeof candidate === 'string' && candidate.length > 0);
  for (const root of candidates) {
    const entry = `${root}/@deepseek-ai/cordis/lib/index.js`;
    try {
      await readFile(entry);
      return import(entry);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('cannot find @deepseek-ai/cordis; set DSH_PROFILE_MODULES');
}

/** Extract the vendored archive, verifying it against the pin first. */
async function extractPocketBase(target) {
  const archivePath = join(ROOT, POCKETBASE_ARCHIVE_PATH);
  const archive = await readFile(archivePath);
  const digest = createHash('sha256').update(archive).digest('hex');
  assert.equal(digest, POCKETBASE_SHA256, `${POCKETBASE_ASSET} does not match the pin`);
  step(`${POCKETBASE_ASSET} verified (sha256 ${digest.slice(0, 16)}…)`);

  await mkdir(target, { recursive: true });
  await run('/usr/bin/unzip', ['-o', '-q', archivePath, '-d', target]);
  const executable = join(target, 'pocketbase');
  await run('/bin/chmod', ['755', executable]);
  return executable;
}

/** Wait until the sidecar answers its health endpoint. */
async function waitForHealth(baseUrl, deadlineMs = 20_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`pocketbase did not answer at ${baseUrl} within ${deadlineMs}ms`);
}

/** Start the sidecar, detached so it can be signalled as a group. */
async function startSidecar(executable, dataDir, migrationsDir, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    executable,
    ['serve', `--http=127.0.0.1:${port}`, `--dir=${dataDir}`, `--migrationsDir=${migrationsDir}`],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  await waitForHealth(baseUrl);
  return {
    baseUrl,
    pid: child.pid,
    output: () => output,
    async stop() {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      const deadline = Date.now() + 8000;
      while (child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    },
  };
}

/** Free loopback port. */
async function freePort() {
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Boot the memory backend and the console for one project, exactly as the
 * harness does: one Cordis context, the real client, the real console.
 *
 * @param options - the runtime, the project, and where the console keeps files.
 * @returns the console's actions, its memory service, and the injected HTML.
 */
async function bootProject({
  cordis,
  baseUrl,
  projectId,
  backupDir,
  snapshotDir,
  dataDir,
  versions,
}) {
  const ctx = new cordis.Context();
  const routes = new Map();
  const taps = [];

  ctx.provide('webServer', {
    tapIndex(transform) {
      taps.push(transform);
      return () => {};
    },
  });
  ctx.provide('connection', {
    fetch: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  });

  const backend = await import('../plugins/pocketbase-memory/index.js');
  const consolePlugin = await import('../plugins/memory-console/index.js');
  backend.apply(ctx, { url: baseUrl, identity: IDENTITY, password: PASSWORD, projectId });
  consolePlugin.apply(ctx, {
    backupDir,
    snapshotDir,
    dataDir,
    newpiVersion: versions.newpi,
    pocketbaseVersion: versions.pocketbase,
    announce: false,
  });

  const memory = ctx.get('pocketbaseMemory');
  const console = ctx.get('memoryConsole');
  assert.ok(memory && console, `the plugins did not mount for ${projectId}`);

  return {
    memory,
    console,
    memoryOf: memory.projectId,
    routes,
    /** The HTML the interface receives, with the console's sections in it. */
    html: taps.length > 0 ? taps[0]('<html><head></head><body></body></html>') : '',
  };
}

/** One `pocketbase superuser upsert` call, the same one NewPi makes. */
async function createSuperuser(executable, dataDir) {
  await run(executable, ['superuser', 'upsert', IDENTITY, PASSWORD, `--dir=${dataDir}`]);
}

/** Rows per project, read from the database file itself. */
async function rowsByProject(dataDb) {
  const { stdout } = await run('/usr/bin/sqlite3', [
    dataDb,
    'select project_id || "=" || count(*) from memories group by project_id order by project_id;',
  ]);
  return stdout.trim().length === 0 ? {} : Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  );
}

async function main() {
  const cordis = await cordisModule();

  const workspace = await mkdtemp(join(tmpdir(), 'newpi-backup-live-'));
  const binaryDir = join(workspace, 'bin');
  const dataDir = join(workspace, 'pb_data');
  const migrationsDir = join(workspace, 'pb_migrations');
  const backupDir = join(workspace, 'backups');
  const snapshotDir = join(dataDir, 'backups');
  const port = await freePort();
  let sidecar = null;

  try {
    console.log('\n1. provision the pinned binary and the two project scopes');
    const executable = await extractPocketBase(binaryDir);
    await mkdir(dataDir, { recursive: true });
    await mkdir(migrationsDir, { recursive: true });
    await mkdir(backupDir, { recursive: true });
    for (const name of await readdir(join(ROOT, 'pb_migrations'))) {
      await writeFile(join(migrationsDir, name), await readFile(join(ROOT, 'pb_migrations', name)));
    }

    sidecar = await startSidecar(executable, dataDir, migrationsDir, port);
    await createSuperuser(executable, dataDir);
    step(`sidecar on ${sidecar.baseUrl}, superuser provisioned`);

    const versions = { newpi: '0.1.0', pocketbase: '0.40.4' };
    const alpha = await bootProject({
      cordis,
      baseUrl: sidecar.baseUrl,
      projectId: 'newpi-live-alpha',
      backupDir,
      snapshotDir,
      dataDir,
      versions,
    });
    const beta = await bootProject({
      cordis,
      baseUrl: sidecar.baseUrl,
      projectId: 'newpi-live-beta',
      backupDir,
      snapshotDir,
      dataDir,
      versions,
    });

    console.log('\n2. two projects, each with its own memories');
    const doomed = await alpha.memory.remember({
      content: 'alpha keeps the deployment runbook in the ops wiki',
      kind: 'note',
    });
    await alpha.memory.remember({
      content:
        'Symptom: the sidecar refused every call after a restart.\n' +
        'Confirmed cause: the cached superuser token outlived the restart.\n' +
        'Fix: retry once after a 401 and re-authenticate.\n' +
        'Proof: the memory test that rejects one token and reads the next call.',
      kind: 'bugfix',
    });
    const betaRow = await beta.memory.remember({
      content: 'beta pins Node 22 for its toolchain',
      kind: 'decision',
    });
    step(`alpha wrote 2 (${doomed.id}), beta wrote 1 (${betaRow.id})`);

    console.log('\n3. each view shows only its own project');
    const alphaPage = await alpha.console.dispatch('memory.page', { perPage: 50 });
    const betaPage = await beta.console.dispatch('memory.page', { perPage: 50 });
    assert.equal(alphaPage.total, 2);
    assert.equal(betaPage.total, 1);
    assert.ok(
      alphaPage.items.every((item) => item.id !== betaRow.id),
      'alpha must not list beta\'s memory',
    );
    const alphaMiss = await beta.console.dispatch('memory.page', { query: 'deployment runbook' });
    assert.equal(alphaMiss.total, 0, 'beta must not find alpha\'s memory by text');
    const crossRead = await beta.console
      .dispatch('memory.read', { id: doomed.id })
      .then(() => 'read')
      .catch((error) => error.code);
    assert.equal(crossRead, 'CONSOLE_NOT_FOUND', 'beta must not read alpha\'s memory by id');
    step('alpha sees 2, beta sees 1, and neither can reach the other\'s rows');

    console.log('\n4. a backup, through PocketBase\'s own snapshot machinery');
    const created = await alpha.console.dispatch('backup.create', { pick: false });
    assert.equal(created.cancelled, false);
    assert.equal(created.manifest.memories.total, 3);
    step(`${created.name} · ${created.bytes} bytes · ${created.path}`);

    const entries = (await run('/usr/bin/unzip', ['-Z1', created.path])).stdout
      .trim()
      .split('\n')
      .sort();
    assert.deepEqual(entries, [
      'manifest.json',
      'pb_data/auxiliary.db',
      'pb_data/data.db',
      'pb_data/types.d.ts',
    ]);
    const manifest = JSON.parse(
      (await run('/usr/bin/unzip', ['-p', created.path, 'manifest.json'])).stdout,
    );
    step(`archive holds ${entries.join(', ')}`);
    step(`manifest: ${JSON.stringify(manifest)}`);
    assert.equal(manifest.format, 'newpi-memory-backup');
    assert.equal(manifest.format_version, 1);
    assert.equal(manifest.created_by.name, 'NewPi');
    assert.equal(manifest.created_by.version, versions.newpi);
    assert.equal(manifest.pocketbase.version, versions.pocketbase);
    assert.match(manifest.contents.sha256['pb_data/data.db'], /^[0-9a-f]{64}$/);
    assert.ok(manifest.created_at.endsWith('Z'), 'the manifest records an absolute instant');

    // The sidecar's own copy of the snapshot is cleaned up: the archive the
    // user keeps is the NewPi one.
    const leftovers = await readdir(snapshotDir).catch(() => []);
    assert.deepEqual(leftovers.filter((name) => name.endsWith('.zip')), []);

    console.log('\n5. delete one memory through the console');
    const deleted = await alpha.console.dispatch('memory.delete', { id: doomed.id, confirm: true });
    assert.equal(deleted.deleted, true);
    assert.equal((await alpha.console.dispatch('memory.status', {})).total, 1);
    assert.deepEqual(await rowsByProject(join(dataDir, 'data.db')), {
      'newpi-live-alpha': '1',
      'newpi-live-beta': '1',
    });
    step('the memory is gone from the database, both projects still there');

    console.log('\n6. restore, and read the database back');
    const inspected = await alpha.console.dispatch('backup.inspect', { path: created.path });
    assert.equal(inspected.ok, true, inspected.message);
    assert.equal(inspected.current.total, 2, 'two rows across every project before the restore');

    const report = await alpha.console.dispatch('backup.restore', {
      path: created.path,
      confirm: true,
    });
    assert.equal(report.rolled_back, false, 'the restore must not have rolled back');
    assert.equal(report.verification.matches, true);
    assert.equal(report.verification.total, 3);
    assert.equal(report.verification.project_total, 2);
    assert.ok(report.safety.path.includes('avant-restauration'));
    step(`restored and verified: ${report.verification.total} rows, safety ${report.safety.name}`);

    // The database file itself says the deleted memory is back, and that the
    // other project never moved.
    assert.deepEqual(await rowsByProject(join(dataDir, 'data.db')), {
      'newpi-live-alpha': '2',
      'newpi-live-beta': '1',
    });
    const back = await alpha.console.dispatch('memory.read', { id: doomed.id });
    assert.equal(back.memory.content, 'alpha keeps the deployment runbook in the ops wiki');
    assert.equal(back.memory.kind, 'note');
    const betaStill = await beta.console.dispatch('memory.read', { id: betaRow.id });
    assert.equal(betaStill.memory.content, 'beta pins Node 22 for its toolchain');
    step('the deleted memory is back, beta untouched, ids unchanged');

    // PocketBase is healthy on the same port and answers the collection again.
    assert.equal((await fetch(`${sidecar.baseUrl}/api/health`)).status, 200);
    assert.match(await alpha.memory.health(), /collection memories/);
    const schema = await run('/usr/bin/sqlite3', [join(dataDir, 'data.db'), '.schema memories']);
    assert.ok(schema.stdout.includes('CREATE TABLE `memories`'), 'the schema survived the restore');
    step('PocketBase is healthy, the schema is intact');

    console.log('\n7. the interface receives no secret and no privileged address');
    for (const project of [alpha, beta]) {
      assert.deepEqual([...project.routes.keys()], ['/api/newpi.console']);
      assert.ok(project.html.includes('data-newpi-console'), 'the sections are injected');
      for (const forbidden of [PASSWORD, IDENTITY, sidecar.baseUrl, '127.0.0.1', 'DSH_MEMORY_PASSWORD']) {
        assert.equal(
          project.html.includes(forbidden),
          false,
          `the injected interface must not contain ${forbidden}`,
        );
      }
    }
    step('the injected HTML carries no credential, no address and no env name');
    step('the console answers on one route, behind /api');

    console.log('\nAll live backup checks passed.\n');
    console.log(`archive format proven on: ${created.path}`);
  } finally {
    if (sidecar !== null) await sidecar.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\nLive backup check FAILED\n');
  console.error(error);
  process.exit(1);
});
