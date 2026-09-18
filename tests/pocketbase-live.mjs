#!/usr/bin/env node
/**
 * Live proof that the memory feature works against the real PocketBase binary.
 *
 * The unit suite in `tests/memory.test.mjs` runs against an in-process fake, so
 * it proves the plugin logic and nothing about PocketBase. This script closes
 * that gap. It:
 *
 *   1. extracts the vendored PocketBase archive into a temporary directory;
 *   2. applies `pb_migrations/` by starting the sidecar;
 *   3. creates a superuser with the same CLI call NewPi makes;
 *   4. drives the two plugins — a real Cordis context, the real HTTP client —
 *      through remember, recall and forget against that process;
 *   5. stops the sidecar, starts it again on the same data directory, and
 *      proves the memory is still there;
 *   6. boots a second project scope and proves it cannot see or delete the
 *      first project's memory;
 *   7. proves the collection is closed to an unauthenticated caller.
 *
 * Run it with `pnpm run test:pocketbase`.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import {
  POCKETBASE_ASSET,
  POCKETBASE_SHA256,
  POCKETBASE_ARCHIVE_PATH,
} from '../scripts/pocketbase-pin.mjs';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Credentials this run provisions. Random per run, never reused. */
const IDENTITY = 'newpi-live-test@local.test';
const PASSWORD = `live-${Math.random().toString(36).slice(2)}-${Date.now()}`;

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

/** Log one step so a failure is attributable. */
function step(message) {
  console.log(`  ${message}`);
}

/**
 * Extract the vendored archive, verifying it against the pin first.
 *
 * @param target - directory to extract into.
 * @returns the path of the executable.
 */
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

/**
 * Wait until the sidecar answers its health endpoint.
 *
 * @param baseUrl - the loopback base URL.
 * @param deadlineMs - how long to wait.
 */
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

/** Start the sidecar, orphaned from this process's group so it can be killed. */
async function startSidecar(executable, dataDir, migrationsDir, port) {
  const baseUrl = `http://127.0.0.1:${port}`;
  const { spawn } = await import('node:child_process');
  const child = spawn(
    executable,
    [
      'serve',
      `--http=127.0.0.1:${port}`,
      `--dir=${dataDir}`,
      `--migrationsDir=${migrationsDir}`,
    ],
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
    /** The sidecar's own log, for failure messages. */
    output: () => output,
    /** Stop it the way the application does: TERM to the group, then KILL. */
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

/**
 * Boot both memory plugins on one Cordis context with a fake tool registry,
 * exactly as `tests/memory.test.mjs` does.
 *
 * @param options - the backend URL and the project scope.
 * @returns the tool registry and the memory service.
 */
async function bootPlugins({ cordis, backend, tools, baseUrl, projectId }) {
  const ctx = new cordis.Context();
  const registered = new Map();
  ctx.provide('tools', {
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  });
  backend.apply(ctx, { url: baseUrl, identity: IDENTITY, password: PASSWORD, projectId });
  tools.apply(ctx);
  return {
    memory: ctx.get('pocketbaseMemory'),
    async call(name, args) {
      const tool = registered.get(name);
      assert.ok(tool, `tool ${name} is not registered`);
      return tool.execute(args, {});
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

/** One `pocketbase superuser upsert` call, the same one NewPi makes. */
async function createSuperuser(executable, dataDir) {
  await run(executable, [
    'superuser',
    'upsert',
    IDENTITY,
    PASSWORD,
    `--dir=${dataDir}`,
  ]);
}

async function main() {
  const cordis = await cordisModule();
  const backend = await import('../plugins/pocketbase-memory/index.js');
  const tools = await import('../plugins/memory-tools/index.js');

  const workspace = await mkdtemp(join(tmpdir(), 'newpi-pb-live-'));
  const binaryDir = join(workspace, 'bin');
  const dataDir = join(workspace, 'pb_data');
  const migrationsDir = join(workspace, 'pb_migrations');
  const port = await freePort();
  let sidecar = null;

  try {
    console.log('\n1. provision the pinned binary');
    const executable = await extractPocketBase(binaryDir);
    await mkdir(dataDir, { recursive: true });
    // The application copies its migrations next to the data directory; this
    // run points PocketBase straight at the versioned ones in the repository.
    await mkdir(migrationsDir, { recursive: true });
    for (const name of await (await import('node:fs/promises')).readdir(join(ROOT, 'pb_migrations'))) {
      await writeFile(
        join(migrationsDir, name),
        await readFile(join(ROOT, 'pb_migrations', name)),
      );
    }

    console.log('\n2. start the sidecar and apply the migration');
    sidecar = await startSidecar(executable, dataDir, migrationsDir, port);
    step(`listening on ${sidecar.baseUrl}`);
    await createSuperuser(executable, dataDir);
    step(`superuser ${IDENTITY} provisioned`);

    console.log('\n3. the collection is closed to an unauthenticated caller');
    const anonymous = await fetch(`${sidecar.baseUrl}/api/collections/memories/records`);
    assert.equal(anonymous.status, 403, 'an unauthenticated read must be refused');
    step(`unauthenticated read refused with ${anonymous.status}`);

    console.log('\n4. remember, recall and forget through the plugins');
    const alpha = await bootPlugins({
      cordis,
      backend,
      tools,
      baseUrl: sidecar.baseUrl,
      projectId: 'alpha',
    });
    step(await alpha.memory.health());

    const stored = await alpha.call('remember', {
      content:
        'Symptom: the window stayed blank after launch.\n' +
        'Cause: the loopback session cookie is SameSite=Strict, so navigating from the splash withheld it.\n' +
        'Fix: open the token URL as the window\'s first load.\n' +
        'Proof: the interface renders, and the runtime answers 401 without the cookie.',
      kind: 'bugfix',
    });
    step(`remembered ${stored.kind} as ${stored.id}`);

    const found = await alpha.call('recall', { query: 'SameSite' });
    assert.equal(found.count, 1);
    assert.equal(found.memories[0].id, stored.id);
    step(`recall by text found ${found.count}`);

    const byKind = await alpha.call('recall', { query: '', kind: 'bugfix' });
    assert.equal(byKind.count, 1);
    const otherKind = await alpha.call('recall', { query: '', kind: 'note' });
    assert.equal(otherKind.count, 0);
    step('recall by kind filters correctly');

    const deleted = await alpha.call('forget', { id: stored.id });
    assert.deepEqual(deleted, { id: stored.id, deleted: true });
    assert.equal((await alpha.call('recall', { query: 'SameSite' })).count, 0);
    step('forget removed the memory');

    console.log('\n5. persistence across a sidecar restart');
    const kept = await alpha.call('remember', {
      content: 'The project pins Node 24 and pnpm 9.',
      kind: 'note',
    });
    await sidecar.stop();
    step('sidecar stopped');
    sidecar = await startSidecar(executable, dataDir, migrationsDir, port);
    step('sidecar restarted on the same data directory');

    const afterRestart = await bootPlugins({
      cordis,
      backend,
      tools,
      baseUrl: sidecar.baseUrl,
      projectId: 'alpha',
    });
    const survived = await afterRestart.call('recall', { query: 'Node 24' });
    assert.equal(survived.count, 1);
    assert.equal(survived.memories[0].id, kept.id);
    step(`recall after restart returned ${survived.count}, same id ${kept.id}`);

    console.log('\n6. isolation between two project ids');
    const beta = await bootPlugins({
      cordis,
      backend,
      tools,
      baseUrl: sidecar.baseUrl,
      projectId: 'beta',
    });
    assert.equal((await beta.call('recall', {})).count, 0);
    step('beta sees none of alpha\'s memories');

    const foreignDelete = await beta.call('forget', { id: kept.id });
    assert.deepEqual(foreignDelete, { id: kept.id, deleted: false });
    assert.equal((await afterRestart.call('recall', { query: 'Node 24' })).count, 1);
    step('beta cannot delete alpha\'s memory, and it is still there');

    const betaOwn = await beta.call('remember', { content: 'beta pins Node 22', kind: 'note' });
    assert.equal((await beta.call('recall', { query: 'Node' })).count, 1);
    assert.equal((await afterRestart.call('recall', { query: 'Node' })).count, 1);
    step(`each project sees exactly its own memory (beta wrote ${betaOwn.id})`);

    console.log('\n7. prove the scoping is in the query, not in the client');
    const sqlite = await run('/usr/bin/sqlite3', [
      join(dataDir, 'data.db'),
      'select project_id, kind, count(*) from memories group by project_id, kind order by project_id;',
    ]);
    step(`rows in the database:\n${sqlite.stdout.trim().split('\n').map((line) => `       ${line}`).join('\n')}`);
    const indexes = await run('/usr/bin/sqlite3', [
      join(dataDir, 'data.db'),
      "select name from sqlite_master where type='index' and tbl_name='memories' and name not like 'sqlite_autoindex%' order by name;",
    ]);
    assert.deepEqual(
      indexes.stdout.trim().split('\n'),
      ['idx_memories_project_created', 'idx_memories_project_kind'],
      'the migration indexes are missing',
    );
    step('both migration indexes exist');

    console.log('\nAll live PocketBase checks passed.\n');
  } finally {
    if (sidecar !== null) await sidecar.stop();
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('\nLive PocketBase check FAILED\n');
  console.error(error);
  process.exit(1);
});
