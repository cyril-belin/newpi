#!/usr/bin/env node
/**
 * Interface proof for the Projects section, on a running NewPi.
 *
 * This script drives a real browser against the interface a running NewPi
 * serves. It does not start NewPi: it opens the interface, looks at what the
 * section renders, asks the Project Model's own endpoint the questions the
 * section asks, and captures the result.
 *
 * It is the check a unit test cannot be: that the row appears in the sidebar
 * the engine renders, that the panel reads the open project and the recents
 * from the live model, that the five capabilities are spelled in words, and
 * that no project id, memory namespace or session id is anywhere on the page.
 *
 * Usage:
 *   node scripts/probe-projects-ui.mjs --url "<token URL from the launch log>"
 *                                      [--out projects.png]
 *
 * The URL is the one NewPi prints as `dsh web: …`; it carries the one-shot
 * launch token, so the page it loads is authenticated. It exits non-zero on the
 * first failed check. Nothing is clicked that would change the project or
 * restart the application: the button that would is asserted, never pressed.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NAV_SEATS } from '../plugins/projects-console/ui.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

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

/**
 * A very small Chrome DevTools Protocol client.
 *
 * Chrome is driven over its own debugging socket rather than through a browser
 * automation dependency: this repository ships no npm dependencies, and the
 * three commands used here (`Page.navigate`, `Runtime.evaluate`,
 * `Page.captureScreenshot`) are the whole of what the proof needs.
 */
class Devtools {
  #socket;
  #next = 1;
  #pending = new Map();
  #listeners = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('close', () => {
      for (const [, entry] of this.#pending) {
        entry.reject(new Error('the browser closed the debugging connection'));
      }
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

  /** Send one command and await its result. */
  send(method, params = {}) {
    const id = this.#next;
    this.#next += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Resolve on the next occurrence of one protocol event. */
  once(method) {
    return new Promise((resolve) => {
      const waiters = this.#listeners.get(method) ?? [];
      waiters.push(resolve);
      this.#listeners.set(method, waiters);
    });
  }

  /** Evaluate an expression in the page and return its value. */
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

async function main() {
  const args = options(process.argv.slice(2));
  const url = args.url ?? process.env.NEWPI_WEB_URL;
  assert.ok(url, 'pass --url "<the token URL NewPi printed>" or set NEWPI_WEB_URL');
  assert.ok(url.includes('token='), 'the URL must be the one carrying the launch token');

  const profile = await mkdtemp(join(tmpdir(), 'newpi-projects-probe-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1440,960',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let page = null;
  try {
    const activePort = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 20_000;
    let port = null;
    while (Date.now() < deadline && port === null) {
      port = await readFile(activePort, 'utf8')
        .then((text) => Number(text.split('\n')[0]))
        .catch(() => null);
      if (port === null) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(port, 'Chrome never reported its debugging port');
    step(`headless Chrome on 127.0.0.1:${port}`);

    page = await connect(port);
    const loaded = page.once('Page.loadEventFired');
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Page.navigate', { url });
    await loaded;

    console.log('\n1. the Projects row is in the sidebar the engine renders');
    const ready = await page.evaluate(`
      (async () => {
        const deadline = Date.now() + 20000;
        for (;;) {
          if (document.querySelector('[data-newpi-projects-nav]')) return true;
          if (Date.now() > deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      })()
    `);
    assert.equal(ready, true, 'the Projects row never appeared in the sidebar');
    step(`document.title = ${JSON.stringify(await page.evaluate('document.title'))}`);
    const nav = await page.evaluate(`
      (() => {
        const row = document.querySelector('[data-newpi-projects-nav]');
        return { text: row.textContent.trim(), title: row.getAttribute('title') };
      })()
    `);
    assert.equal(nav.text, 'Projets');
    assert.equal(nav.title, 'Projets');
    step(`sidebar row: ${nav.text}`);
    const seat = await page.evaluate(`
      (() => {
        const seats = ${JSON.stringify(NAV_SEATS)};
        for (const name of seats) {
          if (document.querySelector('[data-slot="' + name + '"] [data-newpi-projects-nav]')) return name;
        }
        return null;
      })()
    `);
    assert.ok(NAV_SEATS.includes(seat), `the row is not in a known seat (got ${seat})`);
    step(`the row sits in the sidebar seat "${seat}"`);

    console.log('\n2. the panel reads the open project, its folder and its capabilities');
    await page.evaluate(`document.querySelector('[data-newpi-projects-nav]').click()`);
    await page.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 1500)); })()`);
    const panel = await page.evaluate(`
      (() => {
        const root = document.querySelector('.npr-root');
        return {
          open: root !== null && root.hidden === false,
          text: root === null ? '' : root.innerText,
          capabilities: Array.from(document.querySelectorAll('.npr-cap-state')).map((n) => n.textContent.trim()),
          buttons: Array.from(document.querySelectorAll('.npr-btn')).map((n) => n.textContent.trim()),
          rows: document.querySelectorAll('.npr-item').length,
        };
      })()
    `);
    assert.equal(panel.open, true, 'the Projects panel did not open');
    assert.match(panel.text, /Projet ouvert/);
    assert.match(panel.text, /Dernière ouverture/);
    assert.match(panel.text, /Dernière session connue/);
    for (const label of ['Lire le projet', 'Écrire dans le projet', 'Terminal', 'Git', 'Réseau']) {
      assert.ok(panel.text.includes(label), `the capability "${label}" must be readable`);
    }
    assert.equal(panel.capabilities.length, 5, 'exactly five capabilities are shown');
    assert.ok(panel.capabilities.includes('autorisé'));
    assert.ok(panel.capabilities.includes('refusé'), 'network is off by default');
    step(`panel text: ${JSON.stringify(panel.text.replaceAll(/\s+/g, ' ').slice(0, 240))}`);
    step(`capabilities: ${panel.capabilities.join(', ')}`);

    console.log('\n3. the recents are listed, and no internal identifier is on the page');
    assert.ok(panel.rows >= 2, `at least two projects should be recent (got ${panel.rows})`);
    assert.ok(panel.buttons.includes('Ouvrir un dossier de projet…'));
    assert.ok(panel.buttons.includes('Actualiser'));
    step(`${panel.rows} project row(s), folder button present`);
    const pageText = await page.evaluate('document.body.innerText');
    for (const forbidden of ['memoryNamespace', 'workspaceId', 'handoff', 'detached', '/api/newpi']) {
      assert.ok(!pageText.includes(forbidden), `"${forbidden}" must not be on the page`);
    }
    step('no namespace, workspace id, handoff or raw endpoint name is rendered');

    console.log('\n4. the Project Model answers the page, and refuses an undeclared key');
    const api = await page.evaluate(`
      (async () => {
        const call = async (action, params) => {
          const response = await fetch('/api/newpi.project', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, params }),
          });
          return { status: response.status, body: await response.json() };
        };
        const current = await call('project.current', {});
        const list = await call('project.list', {});
        const operations = await call('project.operations', {});
        const refused = await call('project.open', { id: 'x', capabilities: { network: true } });
        return {
          current: current.body,
          recent: Array.isArray(list.body.value) ? list.body.value.length : 0,
          operations: operations.body.value,
          refused,
        };
      })()
    `);
    assert.equal(api.current.ok, true);
    assert.equal(typeof api.current.value.name, 'string');
    assert.ok(api.recent >= 2);
    assert.deepEqual(api.operations, [], 'no operation should be in flight on a quiet application');
    assert.equal(api.refused.body.ok, false);
    assert.equal(api.refused.body.error.code, 'PROJECT_INVALID_ARGS');
    step(`endpoint: projet=${JSON.stringify(api.current.value.name)} récents=${api.recent}`);
    step(`an undeclared key is refused: ${api.refused.body.error.code}`);

    console.log('\n5. the guard is read before a change is offered');
    const confirm = await page.evaluate(`
      (async () => {
        const rows = Array.from(document.querySelectorAll('.npr-item'));
        const other = rows.find((row) => !row.className.includes('npr-current'));
        if (!other) return { skipped: true };
        const change = Array.from(other.querySelectorAll('.npr-btn'))
          .find((node) => node.textContent.trim().startsWith('Changer de projet'));
        change.click();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return {
          skipped: false,
          text: document.querySelector('.npr-root').innerText,
          buttons: Array.from(document.querySelectorAll('.npr-root .npr-btn')).map((n) => n.textContent.trim()),
        };
      })()
    `);
    if (confirm.skipped) {
      step('only one project is known; the change screen is not exercised');
    } else {
      assert.match(confirm.text, /Projet actuel/);
      assert.match(confirm.text, /Projet cible/);
      assert.match(confirm.text, /redémarrage/);
      assert.ok(confirm.buttons.includes('Changer de projet'));
      assert.ok(confirm.buttons.includes('Annuler'));
      step('the confirmation names the current and the target project, and the restart');
      // Deliberately not confirmed: this probe observes, it does not switch.
      await page.evaluate(`(() => {
        const back = Array.from(document.querySelectorAll('.npr-root .npr-btn'))
          .find((node) => node.textContent.trim() === 'Annuler');
        back.click();
      })()`);
      await page.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 800)); })()`);
    }

    if (typeof args.out === 'string' && args.out.length > 0) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(args.out, Buffer.from(shot.data, 'base64'));
      step(`screenshot of the Projects section written to ${args.out}`);
    }

    console.log('\nAll Projects interface checks passed on the running application.\n');
  } finally {
    page?.send('Browser.close').catch(() => {});
    chrome.kill('SIGTERM');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\nProjects interface check FAILED\n');
  console.error(error);
  process.exit(1);
});
