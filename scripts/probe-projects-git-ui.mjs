#!/usr/bin/env node
/**
 * Interface proof for the Git zone of the Projects section.
 *
 * This script is self-contained: it builds an isolated world (a real repository
 * with a real bare remote on the local disk), boots the real `dsh web` runtime
 * with NewPi's two project plugins mounted by a launcher patch, drives a real
 * headless Chrome against the page it serves, and then reads the Git repository
 * and the bare remote directly to prove the UI did what it claimed.
 *
 * It is the check a unit test cannot be: that the zone rendered by the engine's
 * own sidebar actually reads the live Project Model, shows a real diff, creates
 * a real local commit and pushes it to the configured remote — without a Tauri
 * window and without touching any repository of the person running it.
 *
 * Usage:
 *   node scripts/probe-projects-git-ui.mjs [--out git.png] [--dsh /path/to/dsh]
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

/** Run one Git command for real. */
async function git(args, cwd) {
  const { stdout } = await run('/usr/bin/git', args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
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

/** Build the isolated repository, its bare remote, and its state directory. */
async function buildWorld(base) {
  const remote = join(base, 'remote.git');
  const repo = join(base, 'repo');
  const state = join(base, 'state');
  await mkdir(remote, { recursive: true });
  await mkdir(state, { recursive: true });
  await git(['init', '-q', '--bare', '.'], remote);
  await git(['init', '-q', '-b', 'main', repo], base);
  await git(['config', 'user.email', 'probe@test.invalid'], repo);
  await git(['config', 'user.name', 'NewPi Probe'], repo);
  await writeFile(join(repo, 'README.md'), 'ligne 1\n');
  await git(['add', '--', 'README.md'], repo);
  await git(['commit', '-q', '-m', 'initial'], repo);
  await git(['remote', 'add', 'origin', remote], repo);
  await git(['push', '-q', '-u', 'origin', 'main'], repo);
  // Two changes to show and to commit, one tracked and one new.
  await writeFile(join(repo, 'README.md'), 'ligne 1\nligne 2\n');
  await writeFile(join(repo, 'notes.txt'), 'nouveau\n');
  return { base, remote, repo, state };
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
    `        workspace: '${world.repo}'`,
    "        projectId: 'probe-git'",
    "        name: 'probe-git'",
    "        memoryNamespace: 'probe-git'",
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

/**
 * Seed the registry with the project the launch will open.
 *
 * The remote half of the Git zone needs the `network` capability on top of
 * `git`, and a browser deliberately cannot grant a capability. The record on
 * disk is the door this proof uses — the same one a person or a future
 * settings surface would use — so the runner is exercised with the double
 * authorization in force.
 */
async function writeRegistry(world) {
  const document = {
    version: 1,
    currentId: 'probe-git',
    recent: ['probe-git'],
    projects: {
      'probe-git': {
        id: 'probe-git',
        name: 'probe-git',
        rootPath: world.repo,
        memoryNamespace: 'probe-git',
        settings: { capabilities: { git: true, network: true } },
      },
    },
  };
  await writeFile(join(world.state, 'projects.json'), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
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
  const base = await realpath(await mkdtemp(join(tmpdir(), 'newpi-git-probe-')));
  const world = await buildWorld(base);
  await writeRegistry(world);
  const patch = await writePatch(world);
  const dshHome = await buildHarnessHome(world);
  const port = await freePort();

  const harness = spawn(
    dsh,
    ['--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)],
    {
      cwd: world.repo,
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
  const stopHarness = () => {
    try {
      process.kill(-harness.pid, 'SIGTERM');
    } catch {
      harness.kill('SIGTERM');
    }
  };

  const profile = await mkdtemp(join(tmpdir(), 'newpi-git-chrome-'));
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
    step(`isolated harness on ${url.split('?')[0]}`);

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

    console.log('\n1. the Git zone is inside the open project, and reads the repository');
    await waitFor(
      () => page.evaluate(`!!document.querySelector('[data-newpi-projects-nav]')`),
      'the Projects row never appeared',
      { attempts: 100, delay: 200 },
    );
    await page.evaluate(`document.querySelector('[data-newpi-projects-nav]').click()`);
    await waitFor(
      () => page.evaluate(`(() => { const b = document.querySelector('.npr-git'); return !!b && /Historique Git/.test(b.innerText); })()`),
      'the Git zone never rendered',
      { attempts: 100, delay: 200 },
    );
    const state = await page.evaluate(`
      (() => {
        const box = document.querySelector('.npr-git');
        return {
          text: box.innerText,
          buttons: Array.from(box.querySelectorAll('.npr-btn')).map((n) => n.textContent.trim()),
          disabled: Object.fromEntries(
            Array.from(box.querySelectorAll('.npr-btn')).map((n) => [n.textContent.trim(), n.disabled]),
          ),
          files: Array.from(box.querySelectorAll('.npr-file b')).map((n) => n.textContent.trim()),
        };
      })()
    `);
    assert.match(state.text, /Historique Git/);
    assert.match(state.text, /main/, 'the branch is shown');
    assert.match(state.text, /origin/, 'the remote is shown');
    assert.match(state.text, /Dernière synchronisation/);
    assert.ok(state.files.includes('README.md'), `README.md must be listed (got ${state.files.join(', ')})`);
    assert.ok(state.files.includes('notes.txt'), 'the untracked file must be listed');
    assert.ok(state.buttons.includes('Enregistrer une étape'));
    assert.ok(state.buttons.includes('Envoyer sur GitHub'));
    assert.ok(state.buttons.includes('Récupérer les nouveautés'));
    // The project record grants network, so the remote half is live and the
    // "allow the network" note is absent. The push button is off only because
    // no local commit exists yet; step 4 clicks it once there is one.
    assert.equal(state.disabled['Récupérer les nouveautés'], false, 'fetch is allowed with network');
    assert.ok(!state.text.includes('doit être autorisé'), 'no network warning when network is granted');
    step(`files: ${state.files.join(', ')}`);
    for (const forbidden of ['memoryNamespace', 'workspaceId', 'handoff', '/api/newpi']) {
      assert.ok(!state.text.includes(forbidden), `"${forbidden}" must not be on the page`);
    }

    console.log('\n2. a readable diff opens for a modified file');
    await page.evaluate(`
      (() => {
        const box = document.querySelector('.npr-git');
        const file = Array.from(box.querySelectorAll('.npr-file'))
          .find((item) => item.innerText.includes('README.md'));
        Array.from(file.querySelectorAll('.npr-btn')).find((n) => n.textContent.trim() === 'Voir le diff').click();
      })()
    `);
    await waitFor(
      () => page.evaluate(`(() => { const d = document.querySelector('.npr-diff'); return !!d && /ligne 2/.test(d.innerText); })()`),
      'the diff never rendered',
    );
    const diff = await page.evaluate(`document.querySelector('.npr-diff').innerText`);
    assert.match(diff, /\+ligne 2/);
    step(`diff: ${JSON.stringify(diff.replaceAll(/\s+/g, ' ').slice(0, 80))}`);

    console.log('\n3. Enregistrer une étape creates a real local commit');
    await page.evaluate(`
      (() => {
        const box = document.querySelector('.npr-git');
        Array.from(box.querySelectorAll('.npr-btn')).find((n) => n.textContent.trim() === 'Enregistrer une étape').click();
      })()
    `);
    await waitFor(() => page.evaluate(`!!document.querySelector('.npr-git .npr-message')`), 'the commit form never opened');
    await page.evaluate(`
      (() => {
        const box = document.querySelector('.npr-git');
        box.querySelector('.npr-message').value = 'preuve interface git';
        Array.from(box.querySelectorAll('.npr-btn')).find((n) => n.textContent.trim() === 'Créer le commit local').click();
      })()
    `);
    await waitFor(
      () => page.evaluate(`/Étape enregistrée/.test(document.querySelector('.npr-git').innerText)`),
      'the commit was not confirmed by the interface',
    );
    assert.equal((await git(['log', '-1', '--format=%s'], world.repo)).trim(), 'preuve interface git');
    const committed = (await git(['show', '--name-only', '--format=', 'HEAD'], world.repo))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    assert.deepEqual(committed, ['README.md', 'notes.txt'], 'the interface committed exactly the files it showed');
    step('the repository really has the commit, with both files');

    console.log('\n4. Envoyer sur GitHub pushes the local commit to the bare remote');
    await page.evaluate(`
      (() => {
        const box = document.querySelector('.npr-git');
        Array.from(box.querySelectorAll('.npr-btn')).find((n) => n.textContent.trim() === 'Envoyer sur GitHub').click();
      })()
    `);
    await waitFor(() => page.evaluate(`!!Array.from(document.querySelectorAll('.npr-git .npr-btn')).find((n) => n.textContent.trim() === 'Envoyer')`), 'no push confirmation appeared');
    await page.evaluate(`
      Array.from(document.querySelectorAll('.npr-git .npr-btn')).find((n) => n.textContent.trim() === 'Envoyer').click()
    `);
    await waitFor(
      () => page.evaluate(`/Envoi effectué/.test(document.querySelector('.npr-git').innerText)`),
      'the push was not confirmed by the interface',
    );
    assert.equal((await git(['--git-dir', world.remote, 'log', '-1', '--format=%s', 'main'])).trim(), 'preuve interface git');
    step('the bare remote really received the commit');

    console.log('\n5. Récupérer les nouveautés offers a fast-forward update, and applies it');
    const other = join(base, 'other');
    await git(['clone', '-q', world.remote, other], base);
    await git(['config', 'user.email', 'other@test.invalid'], other);
    await git(['config', 'user.name', 'Other'], other);
    await writeFile(join(other, 'README.md'), 'ligne 1\nligne 2\ndistant\n');
    await git(['commit', '-qam', 'depuis le distant'], other);
    await git(['push', '-q', 'origin', 'main'], other);

    await page.evaluate(`
      Array.from(document.querySelectorAll('.npr-git .npr-btn')).find((n) => n.textContent.trim() === 'Récupérer les nouveautés').click()
    `);
    await waitFor(
      () => page.evaluate(`!!Array.from(document.querySelectorAll('.npr-git .npr-btn')).find((n) => n.textContent.trim() === 'Mettre à jour (avance rapide)')`),
      'a fast-forward update was never offered',
    );
    step('the interface proposes the update in words: avance rapide');
    await page.evaluate(`
      Array.from(document.querySelectorAll('.npr-git .npr-btn')).find((n) => n.textContent.trim() === 'Mettre à jour (avance rapide)').click()
    `);
    await waitFor(
      () => page.evaluate(`/Mise à jour effectuée/.test(document.querySelector('.npr-git').innerText)`),
      'the update was not confirmed by the interface',
    );
    assert.equal(await readFile(join(world.repo, 'README.md'), 'utf8'), 'ligne 1\nligne 2\ndistant\n');
    assert.equal((await git(['rev-list', '--count', 'HEAD'], world.repo)).trim(), '3');
    assert.equal(
      (await git(['rev-list', '--parents', '-n', '1', 'HEAD'], world.repo)).trim().split(' ').length,
      2,
      'a fast-forward adds a commit, it does not create a merge commit',
    );
    step('the local copy advanced by fast-forward, with no merge commit');

    if (typeof args.out === 'string' && args.out.length > 0) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(args.out, Buffer.from(shot.data, 'base64'));
      step(`screenshot written to ${args.out}`);
    }

    console.log('\nAll Git interface checks passed on the isolated running harness.\n');
  } finally {
    page?.send('Browser.close').catch(() => {});
    chrome.kill('SIGTERM');
    stopHarness();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\nGit interface check FAILED\n');
  console.error(error);
  process.exit(1);
});
