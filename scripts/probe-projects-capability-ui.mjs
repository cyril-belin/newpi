#!/usr/bin/env node
/**
 * Interface proof for the project authorizations, on a real running engine.
 *
 * This script builds an isolated world — a plain project directory, a state
 * directory and a harness home under one fresh temporary directory — boots the
 * real `dsh web` runtime with NewPi's two project plugins mounted by a launcher
 * patch, drives a real headless Chrome against the page it serves, and reads
 * the Project Model's registry on disk to prove what the interface did.
 *
 * It proves the one journey this lot is about: **refused, then allowed, then
 * refused again**, entirely through the rendered section, with the Project
 * Model as the only writer. It needs no Git repository and no remote: the
 * capability is a property of the project, and the flag the Git zone reads
 * (`networkAllowed`) is asserted directly over the page's own endpoint, so
 * nothing leaves the machine and no repository of the person running it is
 * opened, read or written.
 *
 * Usage:
 *   node scripts/probe-projects-capability-ui.mjs [--out capability.png] [--dsh /path/to/dsh]
 *
 * Every path it uses is under a fresh temporary directory, which it removes on
 * exit. Nothing outside that directory is written.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const REPOSITORY = new URL('../', import.meta.url).pathname.replace(/\/$/, '');

/** Log one check. */
function step(message) {
  console.log(`  ${message}`);
}

/** Parse `--name value` arguments. */
function options(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      parsed[token.slice(2)] = argv[index + 1];
      index += 1;
    }
  }
  return parsed;
}

/** Wait until `predicate` holds, or fail. */
async function waitFor(predicate, message, { attempts = 200, delay = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  assert.fail(message);
}

/** One free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * A very small Chrome DevTools Protocol client.
 *
 * Chrome is driven over its own debugging socket rather than through a browser
 * automation dependency: this repository ships no npm dependencies, and the
 * commands used here are the whole of what the proof needs.
 */
class Devtools {
  #socket;
  #next = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('close', () => {
      for (const [, entry] of this.#pending) entry.reject(new Error('the browser closed the debugging connection'));
      this.#pending.clear();
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.#pending.get(message.id);
        if (entry === undefined) return;
        this.#pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
        return;
      }
      const waiters = this.#listeners.get(message.method);
      if (waiters === undefined) return;
      this.#listeners.delete(message.method);
      for (const waiter of waiters) waiter(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.#next;
    this.#next += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method) {
    return new Promise((resolve) => {
      const waiters = this.#listeners.get(method) ?? [];
      waiters.push(resolve);
      this.#listeners.set(method, waiters);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`the page threw: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  }
}

/** Open a debugging socket to one Chrome instance. */
async function connect(port) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = list.find((entry) => entry.type === 'page');
  assert.ok(target, 'Chrome exposed no page to drive');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return new Devtools(socket);
}

/** A plain project directory, a state directory, and a harness home. */
async function buildWorld(base) {
  const project = join(base, 'projet');
  const state = join(base, 'state');
  await mkdir(project, { recursive: true });
  await mkdir(state, { recursive: true });
  return { base, project, state };
}

/** Write the launcher patch mounting only the two project plugins. */
async function writePatch(world) {
  const file = join(world.base, 'launcher.patch.yml');
  const plugin = (name) => `file://${join(REPOSITORY, 'plugins', name, 'index.js')}`;
  const patch = [
    '- insert:',
    "    - id: 'project-model'",
    `      name: '${plugin('project-model')}'`,
    '      config:',
    `        stateDir: '${world.state}'`,
    `        workspace: '${world.project}'`,
    "        projectId: 'probe-capability'",
    "        name: 'probe-capability'",
    "        memoryNamespace: 'probe-capability'",
    "        appId: ''",
    "        appBundle: ''",
    '        announce: true',
    "    - id: 'projects-console'",
    `      name: '${plugin('projects-console')}'`,
    '      config:',
    '        announce: true',
    '',
  ].join('\n');
  await writeFile(file, patch, 'utf8');
  return file;
}

/** Seed the registry: the network refused, which is the documented default. */
async function writeRegistry(world) {
  const document = {
    version: 1,
    currentId: 'probe-capability',
    recent: ['probe-capability'],
    projects: {
      'probe-capability': {
        id: 'probe-capability',
        name: 'probe-capability',
        rootPath: world.project,
        memoryNamespace: 'probe-capability',
        settings: { capabilities: { git: true, network: false } },
      },
    },
  };
  await writeFile(join(world.state, 'projects.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/** Read the network state straight from the registry on disk. */
async function registryNetwork(world) {
  const text = await readFile(join(world.state, 'projects.json'), 'utf8');
  return JSON.parse(text).projects['probe-capability'].settings.capabilities.network;
}

/**
 * A harness home that reuses the installed profile modules without writing to
 * the user's own `$DSH_HOME`.
 */
async function buildHarnessHome(world) {
  const home = join(world.base, 'dsh-home');
  const web = join(home, 'profiles', 'web');
  await mkdir(web, { recursive: true });
  const installed = join(process.env.HOME ?? '', '.dsh', 'profiles', 'web');
  for (const name of ['cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml']) {
    await writeFile(join(web, name), await readFile(join(installed, name), 'utf8'), 'utf8');
  }
  const modules = join(process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules');
  await run('/bin/ln', ['-sfn', modules, join(home, 'profiles', 'node_modules')]);
  return home;
}

async function main() {
  const args = options(process.argv.slice(2));
  const dsh = args.dsh ?? process.env.NEWPI_DSH_BIN ?? 'dsh';
  const base = await realpath(await mkdtemp(join(tmpdir(), 'newpi-capability-probe-')));
  const world = await buildWorld(base);
  await writeRegistry(world);
  const patch = await writePatch(world);
  const dshHome = await buildHarnessHome(world);
  const port = await freePort();

  const harness = spawn(
    dsh,
    ['--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)],
    {
      cwd: world.project,
      detached: true,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  harness.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  harness.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const profile = await mkdtemp(join(tmpdir(), 'newpi-capability-chrome-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1440,1100',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let page = null;
  try {
    await waitFor(
      () => /dsh web: \S+/.test(output) || harness.exitCode !== null,
      'the harness never printed its ready URL',
      { attempts: 200, delay: 200 },
    );
    const match = /dsh web: (\S+)/.exec(output);
    assert.ok(match, `no ready URL in the harness output:\n${output}`);
    const url = match[1];
    step(`isolated harness on ${url.split('?')[0]} (no repository, no remote)`);

    const activePort = join(profile, 'DevToolsActivePort');
    let debugging = null;
    await waitFor(
      async () => {
        debugging = await readFile(activePort, 'utf8')
          .then((text) => Number(text.split('\n')[0]))
          .catch(() => null);
        return debugging !== null;
      },
      'Chrome never reported its debugging port',
    );
    page = await connect(debugging);
    const loaded = page.once('Page.loadEventFired');
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url });
    await loaded;

    /**
     * Click one button by its exact label, inside the panel or one subtree.
     *
     * @param label - the button's text.
     * @param selector - the subtree to search, defaulting to the whole panel.
     * @returns whether a button was found and clicked.
     */
    const click = (label, selector = '.npr-root') =>
      page.evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(selector)});
        if (!root) return false;
        const node = Array.from(root.querySelectorAll('.npr-btn'))
          .find((entry) => entry.textContent.trim() === ${JSON.stringify(label)});
        if (!node) return false;
        node.click();
        return true;
      })()`);

    /** Write one screenshot, when the caller asked for one. */
    const shoot = async (file) => {
      if (typeof file !== 'string' || file.length === 0) return;
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(shot.data, 'base64'));
      step(`screenshot written to ${file}`);
    };

    /** The authorizations zone's text, or `null` before it exists. */
    const zoneText = () =>
      page.evaluate(`(() => {
        const zone = document.querySelector('[data-newpi-authorizations]');
        return zone === null ? null : zone.innerText;
      })()`);

    /** Ask the model, over the page's own endpoint, what the Git zone reads. */
    const gitNetworkAllowed = () =>
      page.evaluate(`(async () => {
        const response = await fetch('/api/newpi.project', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'project.git.status', params: {} }),
        });
        const payload = await response.json();
        return payload.ok === true ? payload.value.networkAllowed : null;
      })()`);

    console.log('\n1. the open project shows its authorizations, network refused by default');
    await waitFor(
      () => page.evaluate(`!!document.querySelector('[data-newpi-projects-nav]')`),
      'the Projects row never appeared',
      { attempts: 100, delay: 200 },
    );
    await page.evaluate(`document.querySelector('[data-newpi-projects-nav]').click()`);
    await waitFor(
      () => page.evaluate(`!!document.querySelector('[data-newpi-authorizations]')`),
      'the authorizations zone never rendered',
      { attempts: 100, delay: 200 },
    );
    const initial = await zoneText();
    assert.ok(initial.includes('Autorisations du projet'), 'the zone is named');
    assert.match(initial, /Réseau\s+refusé/, 'the network is refused by default');
    for (const label of ['Lire le projet', 'Écrire dans le projet', 'Terminal', 'Git']) {
      assert.ok(initial.includes(label), `the capability "${label}" must be readable`);
    }
    assert.ok(initial.includes('services externes'), 'the zone explains what a grant opens');
    assert.ok(initial.includes('GitHub'), 'and names the concrete use');
    assert.equal(await registryNetwork(world), false, 'the registry says refused too');
    assert.equal(await gitNetworkAllowed(), false, 'and so does the fact the Git zone reads');
    step(`zone: ${JSON.stringify(initial.replaceAll(/\s+/g, ' ').slice(0, 200))}`);

    console.log('\n2. the grant asks first, and cancelling writes nothing');
    assert.equal(await click('Autoriser le réseau…', '[data-newpi-authorizations]'), true, 'the grant button exists');
    await waitFor(
      () => page.evaluate(`/Autoriser le réseau/.test(document.querySelector('.npr-root').innerText)`),
      'the confirmation never rendered',
    );
    const confirmation = await page.evaluate(`document.querySelector('.npr-root').innerText`);
    assert.ok(confirmation.includes('probe-capability'), 'the confirmation names the project');
    assert.ok(confirmation.includes(world.project), 'and its folder');
    assert.ok(confirmation.includes('GitHub'), 'and the concrete consequence');
    assert.ok(confirmation.includes("n'est pas interrompue"), 'and the in-flight promise');
    step(`confirmation: ${JSON.stringify(confirmation.replaceAll(/\s+/g, ' ').slice(0, 200))}`);

    assert.equal(await click('Annuler'), true, 'the cancel button exists');
    await waitFor(
      () => page.evaluate(`!!document.querySelector('[data-newpi-authorizations]')`),
      'the panel never came back after cancelling',
    );
    assert.equal(await registryNetwork(world), false, 'cancelling must not write the registry');
    assert.match(await zoneText(), /Réseau\s+refusé/, 'and must not change the screen');

    console.log('\n3. the confirmed grant is persisted and the Git fact follows it');
    assert.equal(await click('Autoriser le réseau…', '[data-newpi-authorizations]'), true);
    await waitFor(
      () => page.evaluate(`/Autoriser le réseau/.test(document.querySelector('.npr-root').innerText)`),
      'the confirmation never rendered the second time',
    );
    assert.equal(await click('Autoriser le réseau'), true, 'the confirming button exists');
    await waitFor(async () => (await registryNetwork(world)) === true, 'the grant never reached the registry');
    await waitFor(
      () => page.evaluate(`!!document.querySelector('[data-newpi-authorizations]')`),
      'the panel never came back after granting',
    );
    const granted = await zoneText();
    assert.match(granted, /Réseau\s+autorisé/, 'the zone shows the new state');
    assert.ok(granted.includes("Retirer l'autorisation"), 'and now offers the removal');
    assert.ok(!granted.includes('Autoriser le réseau…'), 'and no longer offers the grant');
    assert.equal(await gitNetworkAllowed(), true, 'the Git zone reads the grant immediately');
    step('grant persisted, and the fact the Git zone reads turned true');
    await shoot(args['out-allowed']);

    console.log('\n4. removing the authorization is persisted too, and closes the door again');
    assert.equal(await click("Retirer l'autorisation", '[data-newpi-authorizations]'), true);
    await waitFor(
      () => page.evaluate(`/Retirer l'autorisation réseau/.test(document.querySelector('.npr-root').innerText)`),
      'the removal confirmation never rendered',
    );
    const removal = await page.evaluate(`document.querySelector('.npr-root').innerText`);
    assert.ok(removal.includes('seront refusés à partir de maintenant'), 'the removal states its effect');
    assert.ok(removal.includes('travail Git local reste disponible'), 'and what it does not touch');
    assert.equal(await click("Retirer l'autorisation"), true, 'the confirming removal button exists');
    await waitFor(async () => (await registryNetwork(world)) === false, 'the removal never reached the registry');
    await waitFor(
      () => page.evaluate(`!!document.querySelector('[data-newpi-authorizations]')`),
      'the panel never came back after removing',
    );
    assert.match(await zoneText(), /Réseau\s+refusé/, 'the zone is back to refused');
    assert.equal(await gitNetworkAllowed(), false, 'and the Git zone reads the refusal again');
    step('removal persisted, and the fact the Git zone reads turned false');

    console.log('\n5. nothing internal reached the screen, and only one door was used');
    const pageText = await page.evaluate('document.body.innerText');
    for (const forbidden of ['probe-capability-secret', 'memoryNamespace', 'workspaceId', 'handoff', 'detached']) {
      assert.ok(!pageText.includes(forbidden), `"${forbidden}" must not be on the page`);
    }
    const requests = await page.evaluate(`
      (() => {
        const zone = document.querySelector('[data-newpi-authorizations]');
        return zone === null ? -1 : zone.querySelectorAll('.npr-btn').length;
      })()
    `);
    assert.equal(requests, 1, 'exactly one capability control is offered');
    step('no namespace, workspace id, handoff or raw state is rendered');

    if (typeof args.out === 'string' && args.out.length > 0) {
      await shoot(args.out);
    }

    console.log('\nAll project authorization checks passed on the running application.\n');
  } finally {
    try {
      process.kill(-harness.pid, 'SIGTERM');
    } catch {
      harness.kill('SIGTERM');
    }
    page?.send('Browser.close').catch(() => {});
    chrome.kill('SIGTERM');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\nProject authorization check FAILED\n');
  console.error(error);
  process.exit(1);
});
