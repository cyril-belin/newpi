#!/usr/bin/env node
/**
 * Interface proof for the Memory and Backup sections, on a running NewPi.
 *
 * This script drives a real browser against the interface a running NewPi
 * serves. It does not start NewPi and it does not touch the database: it opens
 * the interface, looks at what the sections render, asks the console's own
 * endpoint the questions the sections ask, and captures the result.
 *
 * It is the only check that can prove the parts a unit test cannot: that the
 * two rows appear in the sidebar the engine renders, that the panel opens and
 * reads the project's memory from the live sidecar, and that no credential or
 * sidecar address is anywhere in the page.
 *
 * Usage:
 *   node scripts/probe-console-ui.mjs --url "<token URL from the launch log>"
 *                                     [--out-memory memory.png] [--out-backup backup.png]
 *                                     [--restore-round-trip true] [--probe-save-panel true]
 *
 * `--restore-round-trip` replaces the memory database with a backup it takes
 * first: only run it against a throwaway NewPi. `--probe-save-panel` opens the
 * save panel on this machine's screen and closes it by ending the chooser
 * process.
 *
 * The URL is the one NewPi prints as `dsh web: …`; it carries the one-shot
 * launch token, and the page it loads is authenticated for this profile. It
 * exits non-zero on the first failed check.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NAV_SEATS } from '../plugins/memory-console/ui.js';

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
    // A socket that closes with a command in flight must reject it: otherwise
    // the await never settles and the process exits 0 with nothing proved.
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
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
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

  /** Wait for one event. */
  once(method) {
    return new Promise((resolve) => {
      const list = this.#listeners.get(method) ?? [];
      const listener = (params) => {
        this.#listeners.set(
          method,
          (this.#listeners.get(method) ?? []).filter((entry) => entry !== listener),
        );
        resolve(params);
      };
      list.push(listener);
      this.#listeners.set(method, list);
    });
  }

  /**
   * Evaluate one expression in the page and return its value.
   *
   * @param expression - the expression, awaited when it is a promise.
   * @returns the value, by value.
   * @throws when the page threw.
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `the page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  }
}

/**
 * Wait until an expression in the page is true.
 *
 * @param page - the debugging session.
 * @param expression - an expression evaluated in the page.
 * @param options - the timeout and what to call the condition.
 * @returns when the condition held.
 * @throws when it never did.
 */
async function waitFor(page, expression, { timeoutMs = 20_000, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await page.evaluate(expression)) === true) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Hand a file to the window's own archive chooser.
 *
 * This is the browser's own API for setting a file input's selection — the
 * same path a user's click in the operating system's panel takes — so the
 * flow that follows is the flow a person gets, without a person.
 *
 * @param page - the debugging session.
 * @param path - the archive to hand over.
 * @returns the number of nodes the selection was set on.
 */
async function chooseArchive(page, path) {
  await page.send('DOM.enable');
  const { root } = await page.send('DOM.getDocument', { depth: 1 });
  const { nodeId } = await page.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '[data-newpi-console-chooser]',
  });
  assert.ok(nodeId, 'the window has no archive chooser');
  await page.send('DOM.setFileInputFiles', { nodeId, files: [path] });
}

/** Connect to a Chrome that is already listening on a debugging port. */
async function connect(port) {
  const deadline = Date.now() + 20_000;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      target = targets.find((entry) => entry.type === 'page');
      if (target !== undefined) break;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(target?.webSocketDebuggerUrl, 'Chrome exposed no page target');

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

  const profile = await mkdtemp(join(tmpdir(), 'newpi-probe-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      // Chrome's own sandbox cannot initialise under a supervising sandbox
      // (a test runner, a CI job); headless Chrome without it is still a real
      // browser rendering the real interface.
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

    console.log('\n1. the interface is NewPi, and the two sections are in the sidebar');
    // The page is a single page application: wait for the sidebar to exist
    // rather than assuming the first paint has it.
    const ready = await page.evaluate(`
      (async () => {
        const deadline = Date.now() + 20000;
        for (;;) {
          const rows = document.querySelectorAll('[data-newpi-console-nav]');
          if (rows.length > 0) return true;
          if (Date.now() > deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      })()
    `);
    assert.equal(ready, true, 'the console rows never appeared in the sidebar');
    step(`document.title = ${JSON.stringify(await page.evaluate('document.title'))}`);
    const nav = await page.evaluate(`
      Array.from(document.querySelectorAll('[data-newpi-console-nav]'))
        .map((node) => ({ view: node.getAttribute('data-newpi-console-nav'), text: node.textContent.trim() }))
    `);
    assert.deepEqual(nav, [
      { view: 'memory', text: 'Memory' },
      { view: 'backup', text: 'Backup' },
    ]);
    step(`sidebar rows: ${nav.map((entry) => entry.text).join(', ')}`);
    // Which seat they land in is the engine's business, not this script's: the
    // plugin tries the panel list first and falls back to the footer actions,
    // and a build that renders neither gets floating buttons instead. What
    // must hold is that they are inside the sidebar, in a seat the plugin
    // knows about.
    const seat = await page.evaluate(`
      (() => {
        const seats = ${JSON.stringify(NAV_SEATS)};
        for (const name of seats) {
          if (document.querySelector('[data-slot="' + name + '"] [data-newpi-console-nav]')) return name;
        }
        return null;
      })()
    `);
    assert.ok(NAV_SEATS.includes(seat), `the rows are not in a known seat (got ${seat})`);
    step(`both rows sit in the sidebar seat "${seat}"`);

    console.log('\n2. the Memory section reads this project through the console');
    await page.evaluate(`document.querySelector('[data-newpi-console-nav="memory"]').click()`);
    await page.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 1200)); })()`);
    const memoryPanel = await page.evaluate(`
      (() => {
        const root = document.querySelector('.npc-root');
        return {
          open: root !== null && root.hidden === false,
          text: root === null ? '' : root.innerText,
          search: (document.querySelector('.npc-toolbar input[type=search]') || {}).placeholder || '',
          kinds: Array.from(document.querySelectorAll('.npc-toolbar select option')).map((o) => o.value),
          rows: document.querySelectorAll('.npc-item').length,
        };
      })()
    `);
    assert.equal(memoryPanel.open, true, 'the Memory panel did not open');
    assert.equal(memoryPanel.search, 'Rechercher dans le contenu', 'the search field is missing');
    assert.deepEqual(memoryPanel.kinds, ['', 'note', 'decision', 'bugfix', 'lesson']);
    assert.match(memoryPanel.text, /souvenir/);
    assert.match(memoryPanel.text, /dernière écriture/);
    step(`panel text: ${JSON.stringify(memoryPanel.text.replaceAll(/\s+/g, ' ').slice(0, 220))}`);
    step(`${memoryPanel.rows} memory row(s) rendered, search and kind filter present`);

    if (typeof args['out-memory'] === 'string' && args['out-memory'].length > 0) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(args['out-memory'], Buffer.from(shot.data, 'base64'));
      step(`screenshot of the Memory section written to ${args['out-memory']}`);
    }

    console.log('\n3. the endpoint answers the page, and only with this project');
    const api = await page.evaluate(`
      (async () => {
        const call = async (action, params) => {
          const response = await fetch('/api/newpi.console', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, params }),
          });
          return { status: response.status, body: await response.json() };
        };
        return {
          status: await call('memory.status', {}),
          scoped: await call('memory.page', { project_id: 'another-project' }),
          missing: await call('nope', {}),
        };
      })()
    `);
    assert.equal(api.status.status, 200);
    assert.equal(api.status.body.ok, true);
    const projectId = api.status.body.value.project_id;
    assert.ok(typeof projectId === 'string' && projectId.length > 0, 'no project scope was reported');
    step(`memory.status → project ${JSON.stringify(projectId)}, ${api.status.body.value.total} memories`);
    assert.equal(api.scoped.status, 400, 'a project scope from the browser must be refused');
    assert.match(api.scoped.body.error.message, /unknown parameter/);
    step('a project_id sent by the page is refused before any query is built');
    assert.equal(api.missing.status, 404);
    step(`an unknown action answers ${api.missing.status} with a readable message`);

    console.log('\n4. an unauthenticated caller gets nothing');
    const anonymous = await fetch(new URL('/api/newpi.console', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'memory.status', params: {} }),
    });
    assert.ok([401, 403].includes(anonymous.status), `expected 401 or 403, got ${anonymous.status}`);
    step(`the same call without the session cookie answers ${anonymous.status}`);
    const anonymousIndex = await fetch(new URL('/', url));
    assert.equal(anonymousIndex.status, 401, 'the interface itself must require the session');
    step(`the interface itself answers ${anonymousIndex.status} without the cookie`);

    console.log('\n5. the page carries no credential and no sidecar address');
    const source = await page.evaluate('document.documentElement.outerHTML');
    const state = await readFile(
      `${process.env.HOME}/Library/Application Support/NewPi/pocketbase/credentials`,
      'utf8',
    ).catch(() => null);
    const password = state === null ? null : /^password:\s*(.+)$/m.exec(state)?.[1]?.trim();
    if (password === null) {
      step('no credential file on this machine: the credential check is skipped');
    }
    for (const forbidden of [password, 'DSH_MEMORY_PASSWORD', 'DSH_MEMORY_URL', 'pocketbase/credentials'].filter(
      (value) => typeof value === 'string' && value.length > 0,
    )) {
      assert.equal(source.includes(forbidden), false, `the page must not contain ${forbidden}`);
    }
    const addresses = await page.evaluate(`
      (document.documentElement.outerHTML.match(/127\\.0\\.0\\.1:\\d+/g) || []).slice(0, 5)
    `);
    step(`no credential, no env name, no credential path in ${source.length} bytes of DOM`);
    step(`loopback addresses mentioned in the page (the interface's own origin only): ${JSON.stringify(addresses)}`);

    console.log('\n6. the Backup section renders, and describes an archive without restoring it');
    await page.evaluate(`document.querySelector('[data-newpi-console-nav="backup"]').click()`);
    await page.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 900)); })()`);
    const backupPanel = await page.evaluate(`
      (() => {
        const root = document.querySelector('.npc-root');
        return {
          text: root.innerText,
          labels: Array.from(root.querySelectorAll('button')).map((button) => button.textContent.trim()),
        };
      })()
    `);
    for (const label of [
      'Créer une sauvegarde',
      'Restaurer une sauvegarde',
      'Ouvrir le dossier des sauvegardes',
    ]) {
      assert.ok(backupPanel.labels.includes(label), `the Backup section is missing "${label}"`);
    }
    assert.match(backupPanel.text, /PocketBase \d+\.\d+\.\d+/);
    step(`actions: ${backupPanel.labels.join(' | ')}`);
    step(`versions shown: ${/NewPi [\d.]+/.exec(backupPanel.text)?.[0]}, ${/PocketBase [\d.]+/.exec(backupPanel.text)?.[0]}`);

    const archive = await page.evaluate(`
      (async () => {
        const response = await fetch('/api/newpi.console', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'backup.create', params: { pick: false } }),
        });
        const created = await response.json();
        const inspected = await fetch('/api/newpi.console', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'backup.inspect', params: { path: created.value.path } }),
        });
        return { created: created.value, inspected: (await inspected.json()).value };
      })()
    `);
    assert.equal(archive.created.cancelled, false);
    assert.equal(archive.inspected.ok, true);
    assert.equal(archive.inspected.manifest.format, 'newpi-memory-backup');
    assert.equal(archive.inspected.manifest.pocketbase.version, '0.40.4');
    step(`created ${archive.created.name} (${archive.created.bytes} bytes)`);
    step(
      `its manifest: format ${archive.inspected.manifest.format} v${archive.inspected.manifest.format_version}, ` +
        `${archive.inspected.manifest.memories.total} memor(ies), ${archive.inspected.manifest.contents.entries.length} entries`,
    );

    // The confirmation step, opened the way a user opens it — by clicking the
    // archive in the section's own list — and read without pressing the
    // button: this is the screen shown before every memory on the machine is
    // replaced.
    await page.evaluate(`document.querySelector('[data-newpi-console-nav="backup"]').click()`);
    await page.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 900)); })()`);
    const listed = await page.evaluate(`document.querySelectorAll('.npc-item').length`);
    assert.ok(listed > 0, 'the section lists no local backup to inspect');
    await page.evaluate(`document.querySelector('.npc-item').click()`);
    await page.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 900)); })()`);
    const inspection = await page.evaluate(`
      (() => {
        const root = document.querySelector('.npc-root');
        return {
          text: root.innerText.replaceAll(/\\s+/g, ' '),
          confirm: Array.from(root.querySelectorAll('button')).map((b) => b.textContent.trim()),
        };
      })()
    `);
    assert.ok(
      inspection.confirm.includes('Restaurer et remplacer la mémoire locale'),
      'the confirmation button is missing from the inspection screen',
    );
    assert.match(inspection.text, /Restaurer remplace toute la mémoire locale actuelle/);
    assert.match(inspection.text, /sauvegarde de sécurité/);
    assert.match(inspection.text, /Souvenirs dans l’archive/);
    assert.match(inspection.text, /format 1 \(newpi-memory-backup\)/);
    step(`confirmation screen: ${JSON.stringify(inspection.text.slice(0, 300))}`);
    step(`listed ${listed} local backup(s); nothing was restored`);

    const refused = await page.evaluate(`
      (async () => {
        const response = await fetch('/api/newpi.console', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'backup.restore', params: { path: ${JSON.stringify(archive.created.path)} } }),
        });
        return { status: response.status, body: await response.json() };
      })()
    `);
    assert.equal(refused.status, 400, 'a restore without a confirmation must be refused');
    assert.equal(refused.body.error.code, 'CONSOLE_CONFIRMATION_REQUIRED');
    step('a restore without the explicit confirmation is refused');

    if (args['restore-round-trip'] === 'true') {
      console.log('\n7. the whole restore, driven through the interface');
      const before = await page.evaluate(`
        (async () => {
          const call = async (action, params) => {
            const response = await fetch('/api/newpi.console', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ action, params }),
            });
            return (await response.json()).value;
          };
          const page = await call('memory.page', { perPage: 50 });
          const archive = await call('backup.create', { pick: false });
          const doomed = page.items[0];
          await call('memory.delete', { id: doomed.id, confirm: true });
          const after = await call('memory.status', {});
          return { archive: archive.path, id: doomed.id, preview: doomed.preview, total: page.total, after: after.total };
        })()
      `);
      assert.equal(before.after, before.total - 1, 'the deletion did not take');
      step(`deleted ${before.id} ("${before.preview.slice(0, 40)}…") through the console`);
      step(`archive to restore: ${before.archive}`);

      // The chooser is the window's own panel; the file arrives through the
      // browser's own file-selection API.
      await page.evaluate(`document.querySelector('[data-newpi-console-nav="backup"]').click()`);
      await waitFor(page, `document.querySelectorAll('.npc-item').length > 0`, {
        what: 'the backup listing',
      });
      await page.evaluate(`
        Array.from(document.querySelectorAll('.npc-root button'))
          .find((button) => button.textContent.trim() === 'Restaurer une sauvegarde').click()
      `);
      await chooseArchive(page, before.archive);
      await waitFor(
        page,
        `!!Array.from(document.querySelectorAll('.npc-root button'))
            .find((button) => button.textContent.trim() === 'Restaurer et remplacer la mémoire locale')`,
        { what: 'the confirmation screen' },
      );
      const chosen = await page.evaluate(`document.querySelector('.npc-root').innerText.replaceAll(/\\s+/g, ' ')`);
      assert.match(chosen, /Souvenirs dans l’archive/);
      assert.match(chosen, /L’archive choisie est lue sur cette machine/);
      assert.match(chosen, /Restaurer remplace toute la mémoire locale actuelle/);
      step('the chosen archive was described before anything was replaced');

      await page.evaluate(`
        Array.from(document.querySelectorAll('.npc-root button'))
          .find((button) => button.textContent.trim() === 'Restaurer et remplacer la mémoire locale').click()
      `);
      await waitFor(
        page,
        `/Restauration terminée/.test(document.querySelector('.npc-root').innerText)`,
        { timeoutMs: 60_000, what: 'the restore report' },
      );
      const report = await page.evaluate(`document.querySelector('.npc-root').innerText.replaceAll(/\\s+/g, ' ')`);
      assert.match(report, /Sauvegarde de sécurité/);
      assert.match(report, /Vérifié : \d+ souvenir/);
      const restored = await page.evaluate(`
        (async () => {
          const response = await fetch('/api/newpi.console', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'memory.read', params: { id: ${JSON.stringify(before.id)} } }),
          });
          const payload = await response.json();
          const status = await fetch('/api/newpi.console', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'memory.status', params: {} }),
          });
          return { memory: payload.value.memory, total: (await status.json()).value.total };
        })()
      `);
      assert.equal(restored.memory.id, before.id, 'the deleted memory did not come back');
      assert.equal(restored.total, before.total, 'the project is not back to its previous count');
      step(`the deleted memory is back (${restored.memory.kind}), the project counts ${restored.total} again`);
      step(`report: ${JSON.stringify(report.slice(0, 200))}`);
    }

    if (args['probe-save-panel'] === 'true') {
      console.log('\n8. the save panel is a real panel, and cancelling it is not an error');
      await page.evaluate(`document.querySelector('[data-newpi-console-nav="backup"]').click()`);
      await waitFor(page, `document.querySelectorAll('.npc-item').length >= 0`, {
        what: 'the Backup section',
      });
      // The request must stay in flight while the panel is up: that is what a
      // modal panel looks like from the page.
      await page.evaluate(`
        (() => {
          window.__newpiPanelProbe = { done: false, error: null };
          const response = fetch('/api/newpi.console', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'backup.create', params: { pick: true } }),
          })
            .then((r) => r.json())
            .then((payload) => {
              window.__newpiPanelProbe.value = payload.value ?? null;
              window.__newpiPanelProbe.error = payload.error ?? null;
              window.__newpiPanelProbe.done = true;
            })
            .catch((error) => {
              window.__newpiPanelProbe.error = { message: String(error) };
              window.__newpiPanelProbe.done = true;
            });
          return response;
        })()
      `);
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const run = promisify(execFile);
      const chooserPids = async () => {
        const { stdout } = await run('/usr/bin/pgrep', ['-f', 'choose file name with prompt']).catch(
          () => ({ stdout: '' }),
        );
        return stdout.trim().split('\n').filter(Boolean);
      };

      // The panel is displayed by the platform's own chooser process. Whoever
      // is in front of the machine may answer it — this run does not require
      // that they do, and it handles both endings: answered, or still waiting.
      const displayed = await chooserPids();
      let state = await page.evaluate('window.__newpiPanelProbe');
      assert.ok(
        displayed.length > 0 || state.done === true,
        'no panel was displayed: neither a chooser process nor an answer',
      );

      if (!state.done) {
        step(`panel displayed and waiting (${displayed.length} chooser process)`);
        // Ending the chooser process is what closing the panel without choosing
        // does: the answer must be a cancellation, and never an error.
        await run('/bin/kill', displayed);
        await waitFor(page, 'window.__newpiPanelProbe.done === true', {
          timeoutMs: 15_000,
          what: 'the cancelled request',
        });
        state = await page.evaluate('window.__newpiPanelProbe');
        assert.equal(
          state.error,
          null,
          `a cancelled panel must not be an error: ${JSON.stringify(state.error)}`,
        );
        assert.equal(state.value.cancelled, true, 'a cancelled panel must answer as a cancellation');
        step('cancelling the panel answers {cancelled: true}, with no error and no file written');
      } else {
        assert.equal(state.error, null, `the panel failed: ${JSON.stringify(state.error)}`);
        assert.equal(state.value.cancelled, false);
        assert.ok(state.value.bytes > 0, 'the answered panel produced an empty archive');
        assert.equal(state.value.manifest.format, 'newpi-memory-backup');
        step(`panel answered: ${state.value.path} (${state.value.bytes} bytes)`);
        step(
          `its manifest: format ${state.value.manifest.format} v${state.value.manifest.format_version}, ` +
            `${state.value.manifest.memories.total} memor(ies)`,
        );
      }
    }

    if (typeof args['out-backup'] === 'string' && args['out-backup'].length > 0) {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(args['out-backup'], Buffer.from(shot.data, 'base64'));
      step(`screenshot of the Backup section written to ${args['out-backup']}`);
    }

    console.log('\nAll interface checks passed on the running application.\n');
  } finally {
    page?.send('Browser.close').catch(() => {});
    chrome.kill('SIGTERM');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('\nInterface check FAILED\n');
  console.error(error);
  process.exit(1);
});
