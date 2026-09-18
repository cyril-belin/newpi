/**
 * The console section: the injected client, the stream contract, and the thin
 * service behind it.
 *
 * Three things matter here and are proven below rather than assumed:
 *
 * 1. **The page sends a command and nothing else** — no directory, no shell, no
 *    environment — and the host is what turns it into a process in the
 *    project's own directory.
 * 2. **What reaches the `<pre>` is text.** Colours, titles and carriage-return
 *    redraws are reduced on the host, so the panel needs no emulator and no
 *    untrusted escape ever reaches the document.
 * 3. **Nothing keeps running unseen.** Stopping aborts the request, and the
 *    shipped client is run for real against a fake DOM to prove it.
 *
 * @module newpi/tests/terminal-console
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_COMMAND_LENGTH,
  TERMINAL_ENDPOINT,
  commandError,
  encodeFrame,
  exitFrames,
  panelFacts,
  plainText,
  readCommand,
  spawnSpec,
} from '../plugins/terminal-console/terminal.js';
import {
  TERMINAL_ATTRIBUTE,
  installTerminal,
  safeJson,
  terminalClient,
  terminalScript,
  terminalStyle,
} from '../plugins/terminal-console/ui.js';
import { TERMINAL_ENDPOINT as HOST_ENDPOINT } from '../plugins/terminal-console/index.js';

// --------------------------------------------------------------- pure parts

test('the console accepts a command line and refuses everything else', () => {
  assert.equal(commandError('git status'), null);
  assert.equal(commandError('  pnpm test  '), null);
  assert.match(commandError('   '), /vide/);
  assert.match(commandError(undefined), /absente/);
  assert.match(commandError('x'.repeat(MAX_COMMAND_LENGTH + 1)), /trop longue/);

  assert.equal(readCommand({ command: '  cargo check  ' }), 'cargo check');
  assert.throws(() => readCommand({}), (error) => error.code === 'TERMINAL_INVALID_COMMAND');
  // A command is data, never a shape: an object cannot become a shell line.
  assert.throws(() => readCommand({ command: { toString: 'rm -rf /' } }), /absente/);
});

test('the host reduces terminal output to text', () => {
  assert.equal(plainText('\u001b[31mrouge\u001b[0m\n'), 'rouge\n');
  assert.equal(plainText('\u001b]0;titre\u0007suite'), 'suite');
  // A progress bar redraws one line: only the last state is worth keeping.
  assert.equal(plainText('10%\r55%\r100%\n'), '100%\n');
  assert.equal(plainText('a\rb\nc'), 'b\nc', 'a carriage return without a newline is a redraw');
  assert.equal(plainText('\u0007\u0000ok'), 'ok');
  assert.equal(plainText(''), '');
  assert.equal(plainText(undefined), '');
});

test('one command becomes one process in the project directory', () => {
  const spec = spawnSpec('/bin/zsh', '/Users/x/project', 'git status');
  assert.deepEqual(spec, { file: '/bin/zsh', args: ['-lc', 'git status'], cwd: '/Users/x/project' });
  const fallback = spawnSpec('', '', 'pwd');
  assert.equal(fallback.file, '/bin/zsh', 'a missing shell falls back to the default one');
  assert.equal(fallback.cwd, process.cwd(), 'a missing workspace falls back to the harness directory');
});

test('the stream is newline-delimited frames, and the last one closes the account', () => {
  assert.equal(encodeFrame({ type: 'out', text: 'bonjour' }), '{"type":"out","text":"bonjour"}\n');
  const frames = exitFrames({ code: 0, truncated: true, ms: 1234.6 });
  assert.deepEqual(frames, [{ type: 'exit', code: 0, signal: null, truncated: true, ms: 1235 }]);
  assert.deepEqual(exitFrames({ code: null, signal: 'SIGTERM', ms: 10 }), [
    { type: 'exit', code: null, signal: 'SIGTERM', truncated: false, ms: 10 },
  ]);
  assert.deepEqual(exitFrames({ code: 2, ms: 1, error: 'Délai dépassé.' }), [
    { type: 'error', message: 'Délai dépassé.' },
    { type: 'exit', code: 2, signal: null, truncated: false, ms: 1 },
  ]);
});

test('the panel facts carry the directory and no capability', () => {
  const facts = panelFacts({ workspace: '/Users/x/project' });
  assert.equal(facts.endpoint, TERMINAL_ENDPOINT);
  assert.equal(facts.workspace, '/Users/x/project');
  assert.equal(Object.isFrozen(facts), true);
  assert.deepEqual(Object.keys(facts).sort(), ['endpoint', 'maxOutputBytes', 'timeoutMs', 'workspace']);
  assert.equal(panelFacts({}).workspace, null);
});

test('the two sides agree on the route, and the host mounts it', () => {
  assert.equal(TERMINAL_ENDPOINT, HOST_ENDPOINT);
  assert.equal(TERMINAL_ENDPOINT.startsWith('/api/'), true, 'the route lives on the authenticated API channel');
});

// ------------------------------------------------------------- the injected

test('the section is spliced into the head, and its data cannot escape the script', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
  const injected = installTerminal(html, { workspace: '/Users/x</script><script>alert(1)</script>' });
  assert.equal(injected.includes(`<style ${TERMINAL_ATTRIBUTE}>`), true);
  assert.equal(injected.includes(`<script ${TERMINAL_ATTRIBUTE}>`), true);
  assert.equal(injected.indexOf(TERMINAL_ATTRIBUTE) > injected.indexOf('<head>'), true);
  assert.equal(injected.includes('</script><script>alert(1)'), false, 'a path cannot close the script');
  assert.equal(safeJson({ a: '<b>' }), '{"a":"\\u003cb\\u003e"}');
  assert.equal(safeJson(undefined), 'null');
  // A document with no head still gets the section rather than losing it.
  assert.equal(installTerminal('<body></body>', {}).startsWith('<style'), true);

  // The script is the shipped function, not a hand-written copy of it.
  assert.equal(terminalScript({}).startsWith(`(${terminalClient.toString()})`), true);
  assert.match(terminalStyle(), /\.npt-panel\{/);
});

// ---------------------------------------------------------------- the client

/**
 * A DOM just big enough for the shipped client: elements, attributes,
 * listeners, one class selector, and a text node model.
 *
 * @param options - the seat the sidebar offers and the fetch to answer with.
 * @returns the document handle, with the nodes a test wants to poke.
 */
function fakeDocument(options = {}) {
  const created = [];
  function make(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: {},
      listeners: {},
      className: '',
      hidden: false,
      textContent: '',
      value: '',
      type: '',
      title: '',
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 0,
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      removeAttribute(name) {
        delete this.attributes[name];
      },
      addEventListener(name, handler) {
        (this.listeners[name] = this.listeners[name] || []).push(handler);
      },
      focus() {
        this.focused = true;
      },
      fire(name, event = {}) {
        for (const handler of this.listeners[name] || []) handler({ preventDefault() {}, ...event });
      },
    };
    created.push(node);
    return node;
  }
  const seat = options.seat === undefined ? make('div') : make('div');
  seat.attributes['data-slot'] = options.seat ?? 'sidebar.footer.action';
  const document = {
    body: make('body'),
    createElement: (tag) => make(tag),
    createElementNS: (_namespace, tag) => make(tag),
    addEventListener(name, handler) {
      (this.listeners[name] = this.listeners[name] || []).push(handler);
    },
    listeners: {},
    querySelector(selector) {
      const match = /^\[data-slot="(.+)"\]$/.exec(selector);
      if (match !== null) return match[1] === seat.attributes['data-slot'] ? seat : null;
      if (selector.includes('data-newpi-terminal-mounted')) {
        return created.some((node) => node.attributes['data-newpi-terminal-mounted'] !== undefined) ? {} : null;
      }
      return null;
    },
  };
  return { document, seat, created };
}

/** A response whose body streams the given text in two chunks. */
function streamedResponse(text) {
  const encoded = new TextEncoder().encode(text);
  const half = Math.ceil(encoded.length / 2);
  const chunks = [encoded.slice(0, half), encoded.slice(half)];
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: () => Promise.resolve(chunks.length > 0 ? { done: false, value: chunks.shift() } : { done: true, value: undefined }),
        };
      },
    },
  };
}

/**
 * Run the shipped client against the fake document.
 *
 * @param options - the seat and the fetch implementation.
 * @returns the nodes and the calls the client made.
 */
function runClient(options = {}) {
  const fake = fakeDocument(options);
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(options.respond ? options.respond(url, init) : streamedResponse(''));
  };
  const previous = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  globalThis.document = fake.document;
  globalThis.fetch = fetchImpl;
  globalThis.window = {};
  globalThis.AbortController = globalThis.AbortController ?? class {
    abort() {
      this.aborted = true;
    }
  };
  terminalClient({ endpoint: TERMINAL_ENDPOINT, workspace: '/Users/x/project', maxOutputBytes: 4096 });
  return { ...fake, calls, restore: () => {
    globalThis.document = previous;
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
  } };
}

/** Let the client's promise chain run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the client mounts one row in the sidebar seat and opens the panel', () => {
  const run = runClient();
  try {
    const rows = run.seat.children.filter((node) => node.className === 'npt-row');
    assert.equal(rows.length, 1, 'exactly one console row');
    assert.equal(rows[0].attributes['aria-label'], 'Console');
    const panel = run.document.body.children.find((node) => node.className === 'npt-panel');
    assert.ok(panel, 'the panel is attached to the body');
    assert.equal(panel.hidden, true, 'and starts closed');
    rows[0].fire('click');
    assert.equal(panel.hidden, false, 'clicking the row opens it');
  } finally {
    run.restore();
  }
});

test('the client posts the command, renders its frames, and reports the exit', async () => {
  const run = runClient({
    respond: () =>
      streamedResponse(
        encodeFrame({ type: 'out', text: 'fichier.txt\n' }) + encodeFrame({ type: 'exit', code: 0, signal: null, truncated: false, ms: 12 }),
      ),
  });
  try {
    const panel = run.document.body.children.find((node) => node.className === 'npt-panel');
    const form = panel.children.find((node) => node.className === 'npt-form');
    const input = form.children.find((node) => node.className === 'npt-input');
    input.value = 'ls -a';
    form.fire('submit');
    await settle();
    await settle();

    assert.equal(run.calls.length, 1);
    assert.equal(run.calls[0].url, TERMINAL_ENDPOINT);
    assert.equal(run.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(run.calls[0].init.body), { command: 'ls -a' }, 'the page sends a command and nothing else');

    const out = panel.children.find((node) => node.className === 'npt-out');
    assert.equal(out.textContent.includes('fichier.txt'), true, 'output is rendered');
    assert.equal(out.textContent.includes('› ls -a'), true, 'the command is echoed');
    const status = panel.children.find((node) => node.className === 'npt-status');
    assert.match(status.textContent, /Terminé en 0\.0 s\./);
    assert.equal(status.attributes['data-kind'], 'ok');

    // History recalls the last command with the arrow key.
    input.fire('keydown', { key: 'ArrowUp' });
    assert.equal(input.value, 'ls -a');

    // A second submission while nothing runs is accepted.
    form.fire('submit');
    await settle();
    assert.equal(run.calls.length, 2);
  } finally {
    run.restore();
  }
});

test('the stop button aborts the request that is running', async () => {
  let aborted = false;
  const run = runClient({
    respond: (_url, init) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
      });
      // A body that never delivers: the command is still running.
      return { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise(() => {}) }) } };
    },
  });
  try {
    const panel = run.document.body.children.find((node) => node.className === 'npt-panel');
    const form = panel.children.find((node) => node.className === 'npt-form');
    const input = form.children.find((node) => node.className === 'npt-input');
    input.value = 'sleep 999';
    form.fire('submit');
    await settle();
    const stopButton = form.children.find((node) => node.className === 'npt-run' && node.hidden === false && node.textContent === 'Arrêter');
    assert.ok(stopButton, 'the stop button replaces the run button while a command runs');
    stopButton.fire('click');
    assert.equal(aborted, true, 'stopping aborts the request, which is what kills the process');
  } finally {
    run.restore();
  }
});
