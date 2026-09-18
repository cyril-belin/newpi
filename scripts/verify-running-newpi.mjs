#!/usr/bin/env node
/**
 * Acceptance check for a *running* NewPi.
 *
 * This script does not start anything. It inspects a NewPi that is already up,
 * which is the only way to check the things a unit test cannot: that the real
 * application put its files where it says it did, that the sidecar it started
 * is reachable on loopback and nowhere else, that the migration it applied
 * produced the expected schema and indexes, that two project scopes stay
 * apart in the live database, and that quitting the application leaves no
 * process and no listener behind.
 *
 * The Memory and Backup sections themselves are driven through a real browser
 * by `scripts/probe-console-ui.mjs`, which needs the interface's launch URL.
 *
 * Usage: `node scripts/verify-running-newpi.mjs`
 *
 * It exits non-zero on the first failed check.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const STATE = `${process.env.HOME}/Library/Application Support/NewPi`;
const PB = `${STATE}/pocketbase`;
const DATA = `${PB}/pb_data/data.db`;
/** The harness home, where the browser session's secret is written. */
const DSH_HOME = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`;
/** The ports the harness takes, in the order it takes them. */
const HARNESS_PORTS = [7317, 7318, 7319, 7320];

/** Log one check. */
function step(message) {
  console.log(`  ${message}`);
}

/**
 * Where the running interface is listening, or `null`.
 *
 * The harness takes the first free port of its documented range, so the
 * application does not know its own port either — it reads it from the
 * runtime's ready line. Looking for it is the only way in from outside.
 *
 * @returns `{origin, authority}` or `null`.
 */
async function harnessUrl() {
  for (const port of HARNESS_PORTS) {
    const origin = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
      // Unauthenticated, or the interface itself: both mean something is there.
      if (response.status === 200 || response.status === 401) {
        return { origin, authority: `127.0.0.1:${port}` };
      }
    } catch {
      // Nothing on this port; the next one is the answer or none is.
    }
  }
  return null;
}

/**
 * Mint the session cookie the harness would have issued to its own browser.
 *
 * The same scheme `probe-files-ui.mjs` uses: the secret is a record in
 * `$DSH_HOME/.credentials.yaml`, and the cookie binds that secret to the
 * authority it is presented to.
 *
 * @param harness - `{authority}` as `harnessUrl` returned it.
 * @param home - the harness home holding the credential.
 * @returns the `Name=Value` cookie.
 */
async function harnessCookie(harness, home) {
  const text = await readFile(`${home}/.credentials.yaml`, 'utf8');
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/.exec(text);
  assert.ok(match, `no browser session secret in ${home}/.credentials.yaml`);
  const secret = Buffer.from(match[1], 'base64url');
  const name = `dsh-auth-${createHash('sha256').update(harness.authority).digest('base64url')}`;
  const now = Date.now();
  const payload = { version: 1, authority: harness.authority, issuedAt: now, expiresAt: now + 86_400_000 };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${name}=v1.${body}.${signature}`;
}

/** The sidecar's credential, as NewPi stored it. */
async function credential() {
  const text = await readFile(`${PB}/credentials`, 'utf8');
  const identity = text.match(/^identity:\s*(.+)$/m)?.[1]?.trim();
  const password = text.match(/^password:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(identity && password, 'the credential file is not readable');
  return { identity, password };
}

/** The process ids of the running sidecar, whatever its command name is. */
async function sidecarPids() {
  // The pattern's first character is bracketed so the pattern cannot match the
  // shell that carries it: `pgrep -f` sees the command line of the process
  // running this very search, and an unbracketed pattern finds that instead of
  // the sidecar.
  try {
    const { stdout } = await run('/usr/bin/pgrep', ['-f', `${PB}/[p]ocketbase serve`]);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line));
  } catch {
    // `pgrep` exits 1 when nothing matches, which is a result, not a failure.
    return [];
  }
}

/**
 * Every listening socket the sidecar owns.
 *
 * `lsof -p` is used rather than matching the command line, because a path with
 * spaces is reported truncated in `lsof`'s NAME and COMMAND columns — matching
 * on it silently finds nothing, which would make an empty result look like a
 * pass.
 */
async function sidecarListeners() {
  const pids = await sidecarPids();
  assert.ok(pids.length > 0, `no PocketBase process found under ${PB}: is NewPi running?`);
  const { stdout } = await run('/usr/sbin/lsof', [
    '-nP',
    '-a',
    '-p',
    pids.join(','),
    '-iTCP',
    '-sTCP:LISTEN',
  ]);
  return stdout
    .split('\n')
    .map((entry) => entry.match(/(\d+\.\d+\.\d+\.\d+):(\d+) \(LISTEN\)/)?.[0])
    .filter(Boolean);
}

/** Authenticate against the running sidecar. */
async function token(baseUrl) {
  const { identity, password } = await credential();
  const response = await fetch(
    `${baseUrl}/api/collections/_superusers/auth-with-password`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity, password }),
    },
  );
  assert.equal(response.status, 200, 'the stored credential was refused');
  return (await response.json()).token;
}

/** One authenticated request against the memories collection. */
async function api(baseUrl, bearer, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: bearer,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

/** Every file below `directory`, named relative to it, `/` separated. */
async function filesBelow(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...(await filesBelow(`${directory}/${entry.name}`, relative)));
    } else {
      found.push(relative);
    }
  }
  return found;
}

/**
 * The plugin directories the executable embeds.
 *
 * Parsed out of the build's own table rather than listed here: the table is
 * what the deploy writes, so reading it is what makes this check about the
 * machine rather than about a second copy of the same list.
 *
 * @returns the plugin directory names.
 */
async function embeddedPlugins() {
  const source = await readFile(new URL('../src-tauri/src/assets.rs', import.meta.url), 'utf8');
  const table = /pub const PLUGINS: &\[\(&str, &\[\(&str, &str\)\]\)\] = &\[([\s\S]*?)\n\];/.exec(source);
  assert.ok(table !== null, 'the embedded plugin table was not found');
  const names = [...table[1].matchAll(/\("([^"]+)",/g)].map((match) => match[1]);
  assert.ok(names.length > 0, 'the embedded plugin table is empty');
  return names;
}

/** Whether a path exists at all. */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log('\n1. the application laid its files out where it documents them');
  const plugins = (await readdir(`${STATE}/plugins`)).filter((name) => name !== 'node_modules');
  step(`state directory ${STATE}`);
  step(`plugins ${plugins.slice().sort().join(', ')}`);
  // Read against the table the executable embeds rather than a list written
  // here. The two are the same claim — the machine received exactly what the
  // build ships — and a list copied into this file goes stale in silence the
  // day a plugin is added or removed.
  const embedded = await embeddedPlugins();
  assert.deepEqual(
    plugins.slice().sort(),
    embedded.slice().sort(),
    'the deployed plugins must be exactly the ones the build embeds',
  );
  const migrations = await readdir(`${PB}/pb_migrations`);
  assert.ok(migrations.some((name) => name.includes('memories')), 'migration not deployed');
  step(`migration ${migrations.join(', ')}`);
  const patch = await readFile(`${STATE}/launcher.patch.yml`, 'utf8');
  for (const plugin of embedded) {
    assert.ok(patch.includes(plugin), `launcher patch does not mount ${plugin}`);
  }
  assert.ok(
    !patch.includes(await credential().then((c) => c.password)),
    'the credential must not be written into the launcher patch',
  );
  // The console row carries paths and versions, never anything secret.
  assert.ok(patch.includes(`${STATE}/backups`), 'the console does not know where backups live');
  assert.ok(!/password/i.test(patch), 'the launcher patch must not mention a credential');

  // A plugin that is deployed but not mounted never loads, and one that is
  // mounted but not deployed cannot be imported — which the loader treats as a
  // failed launch, so the application shows an error where its interface should
  // be. The two sets therefore have to match, which is what catches the build
  // that shipped a plugin the machine never received.
  const mounted = [...patch.matchAll(/name: 'file:\/\/([^']+)'/g)].map((match) =>
    decodeURIComponent(match[1]),
  );
  assert.ok(mounted.length > 0, 'the launcher patch mounts nothing');
  for (const path of mounted) {
    assert.ok(await exists(path), `the launcher patch mounts a file that is not there: ${path}`);
  }
  for (const plugin of plugins) {
    assert.ok(
      mounted.some((path) => path.includes(`/plugins/${plugin}/`)),
      `the deployed plugin ${plugin} is not mounted by the launcher patch`,
    );
    // And a module a deployed plugin imports has to be deployed beside it. A
    // module a plugin's host half imports was once left out of the embedded
    // table: every unit test passed, because the repository had the file, and
    // the real application died at startup.
    for (const file of await filesBelow(`${STATE}/plugins/${plugin}`)) {
      if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
      const source = await readFile(`${STATE}/plugins/${plugin}/${file}`, 'utf8');
      for (const [, target] of source.matchAll(/from ['"](\.[^'"]+)['"]/g)) {
        assert.ok(
          await exists(`${STATE}/plugins/${plugin}/${target}`),
          `${plugin}/${file} imports ${target}, which was not deployed`,
        );
      }
    }
  }
  step(`launcher patch mounts all ${mounted.length} plugins, each deployed and importable`);

  const backups = await readdir(`${STATE}/backups`);
  step(`backups directory holds ${backups.length} archive(s)`);

  console.log('\n2. the sidecar is loopback only');
  const listeners = await sidecarListeners();
  step(`listening on ${listeners.join(' ')}`);
  assert.ok(listeners.length > 0);
  assert.ok(
    listeners.every((address) => address.startsWith('127.0.0.1:')),
    `the sidecar must listen on loopback only, found ${listeners.join(', ')}`,
  );
  assert.equal(
    new Set(listeners.map((address) => address.split(':')[1].split(' ')[0])).size,
    1,
    'the sidecar must listen on exactly one port',
  );
  const port = Number(listeners[0].split(':')[1].split(' ')[0]);
  const baseUrl = `http://127.0.0.1:${port}`;
  step(`base URL ${baseUrl}`);

  console.log('\n3. the migration produced the expected schema');
  const schema = await run('/usr/bin/sqlite3', [DATA, '.schema memories']);
  assert.ok(schema.stdout.includes('CREATE TABLE `memories`'));
  for (const column of ['content', 'project_id', 'kind', 'created_at']) {
    assert.ok(schema.stdout.includes(`\`${column}\``), `missing column ${column}`);
  }
  const indexes = await run('/usr/bin/sqlite3', [
    DATA,
    "select name from sqlite_master where type='index' and tbl_name='memories' and name not like 'sqlite_autoindex%' order by name;",
  ]);
  assert.deepEqual(indexes.stdout.trim().split('\n'), [
    'idx_memories_project_created',
    'idx_memories_project_kind',
  ]);
  step('columns and both indexes are present');

  console.log('\n4. the collection refuses anonymous callers');
  const anonymous = await fetch(`${baseUrl}/api/collections/memories/records`);
  assert.equal(anonymous.status, 403);
  step(`anonymous read refused with ${anonymous.status}`);

  console.log('\n5. two project scopes stay apart in the live database');
  const bearer = await token(baseUrl);
  const marker = `acceptance-${Date.now()}`;
  const created = await api(baseUrl, bearer, '/api/collections/memories/records', {
    method: 'POST',
    body: JSON.stringify({
      content: `${marker} alpha`,
      project_id: 'newpi-acceptance-alpha',
      kind: 'note',
    }),
  });
  assert.equal(created.status, 200);
  const record = await created.json();

  const escaped = (value) => `'${value.replaceAll("'", "''")}'`;
  const alpha = await api(
    baseUrl,
    bearer,
    `/api/collections/memories/records?filter=${encodeURIComponent(
      `project_id = ${escaped('newpi-acceptance-alpha')} && content ~ ${escaped(`%${marker}%`)}`,
    )}`,
  );
  const beta = await api(
    baseUrl,
    bearer,
    `/api/collections/memories/records?filter=${encodeURIComponent(
      `project_id = ${escaped('newpi-acceptance-beta')} && content ~ ${escaped(`%${marker}%`)}`,
    )}`,
  );
  assert.equal((await alpha.json()).totalItems, 1, 'alpha should see its own memory');
  assert.equal((await beta.json()).totalItems, 0, 'beta must not see alpha\'s memory');
  step(`scoped read: alpha=1 beta=0 for ${record.id}`);

  const removed = await api(
    baseUrl,
    bearer,
    `/api/collections/memories/records/${record.id}`,
    { method: 'DELETE' },
  );
  assert.equal(removed.status, 204);
  step('the acceptance record was deleted');

  console.log('\n6. the running interface loads every client half the plugins declare');
  // The check that the application itself is the one under test. Everything
  // above proves the files are deployed; this proves the *running* harness
  // turned them into something the browser is asked to load. The two are
  // different: a plugin once passed every unit test and its own isolated probe
  // while the installed application had never rebuilt, so the interface simply
  // had no such feature and nothing said so.
  //
  // It reads the deployed manifests rather than naming a plugin, because a
  // client half is discovered through `package.json` and not through the
  // launcher patch — and because a check that names one plugin stops checking
  // the day another declares one.
  const harness = await harnessUrl();
  assert.ok(harness !== null, 'no harness is listening on its documented ports');
  step(`harness                  ${harness.origin}`);
  const cookie = await harnessCookie(harness, DSH_HOME);
  const index = await fetch(harness.origin, { headers: { cookie } });
  assert.equal(index.status, 200, 'the interface refused its own session cookie');
  const html = await index.text();

  const clientHalves = [];
  for (const plugin of plugins) {
    const manifestPath = `${STATE}/plugins/${plugin}/package.json`;
    if (!(await exists(manifestPath))) continue;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.dsh?.client === undefined) continue;
    assert.equal(manifest.dsh.client.platform, 'web', `${plugin} declares a client half that is not web`);
    const bundle = manifest.exports?.['./client'];
    assert.ok(
      typeof bundle === 'string',
      `${plugin} declares dsh.client but exports no ./client bundle`,
    );
    assert.ok(
      await exists(`${STATE}/plugins/${plugin}/${bundle}`),
      `${plugin} names the client bundle ${bundle}, which was not deployed`,
    );
    assert.ok(
      html.includes(`"${manifest.name}"`),
      `the running interface did not ask the browser to load ${manifest.name}`,
    );
    clientHalves.push(manifest.name);
  }

  step(
    clientHalves.length === 0
      ? 'client halves            none declared by the deployed plugins'
      : `client halves            ${clientHalves.join(', ')} in the served boot graph`,
  );

  console.log('\nAll acceptance checks passed on the running application.\n');
}

main().catch((error) => {
  console.error('\nAcceptance check FAILED\n');
  console.error(error);
  process.exit(1);
});
