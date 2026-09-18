/**
 * Behaviour tests for the two memory plugins, run against a fake PocketBase.
 *
 * These cover the properties that must hold no matter what the storage does:
 * the project scope is always applied, `project_id` is never a tool argument,
 * a memory from another project is invisible and undeletable, and a restart of
 * the harness does not lose what the previous one wrote.
 *
 * `node --test tests/` runs them. The real PocketBase binary is exercised by
 * `node tests/pocketbase-live.mjs`, which is a separate, heavier run because it
 * provisions a sidecar.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { startFakePocketBase, TEST_IDENTITY, TEST_PASSWORD } from './fake-pocketbase.mjs';

const ROOT = new URL('../', import.meta.url);

/**
 * Resolve a harness package the plugins and their contract depend on.
 *
 * The plugins are profile plugins: the harness loads them and resolves
 * `@deepseek-ai/cordis` from the harness's own module scope. A test run from
 * this repository has no such scope, so the harness home is used instead.
 * `DSH_PROFILE_MODULES` overrides it for a non default install.
 *
 * @param specifier - package path below the module root, e.g. `@deepseek-ai/cordis/lib/index.js`.
 * @returns the absolute path of the entry point.
 * @throws {Error} when the module tree cannot be found.
 */
function harnessModule(specifier) {
  const override = process.env.DSH_PROFILE_MODULES;
  const candidates = override !== undefined && override.length > 0
    ? [override]
    : [
        `${process.env.HOME}/.dsh/profiles/node_modules`,
        `${process.env.HOME}/.local/lib/node_modules/@deepseek-ai/dsh/node_modules`,
      ];
  for (const root of candidates) {
    const path = `${root}/${specifier}`;
    try {
      readFileSync(path);
      return path;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `cannot find ${specifier}; set DSH_PROFILE_MODULES to a node_modules directory that contains it`,
  );
}

/** The Cordis runtime, imported once for the whole file. */
const { Context } = await import(harnessModule('@deepseek-ai/cordis/lib/index.js'));

/**
 * The harness's own schema assertions, imported so the tests check exactly what
 * the registry checks.
 *
 * This is the point of importing them rather than writing an equivalent here:
 * `plugins/memory-tools/index.js` carries its own copy of the subset check so
 * it can load with nothing but Cordis, and that copy could drift. Running the
 * tool definitions through the real assertions is what makes the drift
 * detectable — an early version of these tools used
 * `{ type: 'string', required: true }` inside `properties` and passed a
 * hand-written checker while the harness rejected it outright.
 */
const {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} = await import(harnessModule('@deepseek-ai/dsh-tools/lib/index.js'));

/** Load the backend plugin under test. */
const backend = await import(new URL('plugins/pocketbase-memory/index.js', ROOT));
/** Load the tools plugin under test. */
const toolsPlugin = await import(new URL('plugins/memory-tools/index.js', ROOT));
/** Load the context & cache manager, whose shape the launcher patch must match. */
const contextCachePlugin = await import(new URL('plugins/context-cache-manager/index.js', ROOT));

/**
 * A stand-in for the harness tool registry.
 *
 * It re-runs the harness's own schema assertions on every registration and its
 * own argument validation on every call, so a definition that the real
 * registry would refuse fails here too. Skipping that would let the suite pass
 * on tool definitions the harness cannot load.
 */
function fakeToolRegistry() {
  const tools = new Map();
  return {
    tools,
    register(definition) {
      assert.equal(typeof definition?.name, 'string');
      assert.ok(!tools.has(definition.name), `duplicate tool ${definition.name}`);
      assert.ok(definition.output && typeof definition.output.render === 'function');
      assertObjectJsonSchema(definition.parameters);
      assertSupportedJsonSchema(definition.output.schema);
      tools.set(definition.name, definition);
      return () => tools.delete(definition.name);
    },
    /** Call one registered tool by name, validating arguments first. */
    async call(name, args) {
      const tool = tools.get(name);
      assert.ok(tool, `tool ${name} is not registered`);
      const violations = validateJsonSchemaValue(tool.parameters, args);
      if (violations.length > 0) {
        throw new Error(`${name}: invalid arguments: ${violations.join('; ')}`);
      }
      return tool.execute(args, {});
    },
  };
}

/**
 * Boot both plugins on one real Cordis context, the way the loader would.
 *
 * @param options - the memory project scope and the fake instance to reach.
 * @param options.baseUrl - the fake PocketBase base URL.
 * @param options.projectId - the configured project scope.
 * @returns the tool registry and the mounted memory service.
 */
async function bootPlugins({ baseUrl, projectId }) {
  const ctx = new Context();
  const registry = fakeToolRegistry();
  ctx.provide('tools', registry);

  backend.apply(ctx, { url: baseUrl, identity: TEST_IDENTITY, password: TEST_PASSWORD, projectId });

  const memory = ctx.get('pocketbaseMemory');
  assert.ok(memory, 'the backend did not provide ctx.pocketbaseMemory');

  // The provider reads the service off the context, exactly as the loader's
  // injection would have ordered it.
  toolsPlugin.apply(ctx);
  return { registry, memory };
}

test('the brand plugin renames the title and touches nothing else', async () => {
  const brand = await import(new URL('plugins/newpi-brand/index.js', ROOT));
  assert.equal(brand.name, 'newpi-brand');
  assert.deepEqual(brand.inject, ['webServer']);
  assert.equal(brand.default, undefined, 'the loader would unwrap a default export');

  const engine = '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>DeepSeek Harness</title></head><body><div id="root"></div></body></html>';
  const renamed = brand.renameTitle(engine);
  assert.equal(renamed.match(/<title>NewPi<\/title>/g)?.length, 1);
  assert.ok(!renamed.includes('DeepSeek Harness'), 'the old title must be gone');
  // Everything else survives byte for byte.
  assert.equal(renamed.replace('<title>NewPi</title>', '<title>DeepSeek Harness</title>'), engine);

  // A document with no title is returned untouched rather than mangled.
  const untitled = '<html><head></head><body></body></html>';
  assert.equal(brand.renameTitle(untitled), untitled);

  // Attributes on the element are tolerated, and only the element is replaced.
  const attributed = '<head><title data-x="1">Other</title></head>';
  assert.equal(brand.renameTitle(attributed), '<head><title>NewPi</title></head>');
});

test('the wordmark replacement is scoped to one slot and cannot throw into the page', async () => {
  const brand = await import(new URL('plugins/newpi-brand/index.js', ROOT));
  const branded = brand.installWordmark(
    '<html><head><title>x</title></head><body><div id="root"></div></body></html>',
  );

  // Both additions land inside <head>, before the body.
  const head = branded.slice(0, branded.indexOf('<body>'));
  assert.ok(head.includes('<style data-newpi="brand">'));
  assert.ok(head.includes('<script data-newpi="brand">'));

  // The style is scoped to the slot: no bare selector can leak into the rest
  // of the interface.
  const style = head.slice(head.indexOf('<style'), head.indexOf('</style>'));
  assert.ok(style.includes('[data-slot="sidebar.brand.name"]'));
  assert.ok(!/(^|[},])\s*(svg|span|body|\*)\s*\{/.test(style), 'the style must stay slot-scoped');
  assert.ok(style.includes('[data-slot="sidebar.brand.name"]>svg{display:none;}'),
    'the engine wordmark is hidden through its slot wrapper only');
  // Both engine artworks are hidden by one rule, each through its own slot
  // wrapper: no bare `svg` selector can reach the rest of the interface.
  assert.ok(
    style.includes('[data-slot="sidebar.brand.mark"]>svg,[data-slot="sidebar.brand.name"]>svg{display:none;}'),
    'both engine artworks are hidden through their slot wrappers only',
  );
  assert.ok(style.includes('.newpi-mark{display:block;width:28px;height:28px;}'),
    'the sidebar mark is 28px: the pi inside the whale is not legible at 24');

  // The script names the slot and the product, and removes nothing.
  const script = branded.slice(branded.indexOf('<script data-newpi'), branded.indexOf('</script>'));
  assert.ok(script.includes('sidebar.brand.name'));
  assert.ok(script.includes('TITLE="NewPi"'));
  assert.ok(script.includes('lockTitle()'), 'the client rewrites the title after boot');
  assert.ok(script.includes('MutationObserver'), 'the sidebar may not exist yet');
  assert.ok(!script.includes('.remove('), 'the plugin must never remove a framework-owned node');
  assert.ok(!script.includes('innerHTML'), 'the plugin must not rewrite engine markup');
  // It is syntactically valid JavaScript, which is the one thing a string
  // transform can get wrong invisibly.
  const body = script.slice(script.indexOf('>') + 1);
  assert.doesNotThrow(() => new Function(body));

  // A document without a head still gets the additions rather than an error.
  const headless = brand.installWordmark('<html><body></body></html>');
  assert.ok(headless.startsWith('<style data-newpi="brand">'));
});

test('the injected script labels the sidebar, before and after it exists', async () => {
  // The script only ever runs in the page, so this runs it for real against a
  // minimal DOM — the same way the browser would, including the case where the
  // sidebar mounts after the script.
  const brand = await import(new URL('plugins/newpi-brand/index.js', ROOT));
  const page = brand.installWordmark('<html><head><title>x</title></head><body></body></html>');
  const script = page.slice(page.indexOf('<script data-newpi'), page.indexOf('</script>'));
  const body = script.slice(script.indexOf('>') + 1);

  /**
   * The smallest DOM the script touches: both sidebar slots, an append-only
   * child list, and a switch that can mount the slots after the script runs.
   */
  function fakeDocument(slotsPresent) {
    const created = [];
    let notify = null;
    const slots = new Map();
    for (const slotName of ['sidebar.brand.mark', 'sidebar.brand.name']) {
      slots.set(slotName, {
        name: slotName,
        children: [],
        querySelector: () => null,
        appendChild(node) {
          this.children.push(node);
          created.push({ slot: this.name, node });
        },
      });
    }
    return {
      created,
      documentElement: {},
      createElement: (tag) => ({
        tag,
        className: '',
        textContent: '',
        children: [],
        setAttribute() {},
        appendChild(node) {
          this.children.push(node);
        },
      }),
      querySelector: (selector) => {
        if (!slotsPresent) return null;
        for (const [slotName, slot] of slots) {
          if (selector.includes(slotName)) return slot;
        }
        return null;
      },
      slots,
      /** Mount both slots later, the way a client render would. */
      mountSlots() {
        slotsPresent = true;
        if (notify) notify();
      },
      observers: {
        set onMutate(fn) {
          notify = fn;
        },
      },
    };
  }

  // Case 1: both sidebar slots already exist when the script runs.
  {
    const document = fakeDocument(true);
    const observers = [];
    globalThis.document = document;
    globalThis.MutationObserver = class {
      constructor(callback) {
        observers.push(callback);
      }
      observe() {}
      disconnect() {}
    };
    globalThis.window = { addEventListener() {} };
    new Function(body)();
    assert.equal(document.created.length, 2, 'the mark and the name are both filled');
    const bySlot = Object.fromEntries(document.created.map((e) => [e.slot, e.node]));
    assert.equal(bySlot['sidebar.brand.name'].textContent, 'NewPi');
    assert.equal(bySlot['sidebar.brand.name'].className, 'newpi-wordmark');
    assert.equal(bySlot['sidebar.brand.mark'].className, 'newpi-mark');
    assert.equal(bySlot['sidebar.brand.mark'].children.length, 1, 'the mark holds the artwork');
    assert.equal(bySlot['sidebar.brand.mark'].children[0].tag, 'img');
    assert.ok(bySlot['sidebar.brand.mark'].children[0].src.startsWith('/newpi/whale.svg'),
      'the mark points at the route the plugin serves');
    assert.equal(observers.length, 0, 'no observer is installed when the slots are present');
  }

  // Case 2: the sidebar mounts afterwards, which is the normal path.
  {
    const document = fakeDocument(false);
    let disconnect = 0;
    globalThis.document = document;
    globalThis.MutationObserver = class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        // The page mutates; the observer reacts and then stops watching.
        queueMicrotask(() => {
          document.mountSlots();
          this.callback();
        });
      }
      disconnect() {
        disconnect += 1;
      }
    };
    globalThis.window = { addEventListener() {} };
    new Function(body)();
    assert.equal(document.created.length, 0, 'nothing is added before the slots exist');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(document.created.length, 2, 'both slots are filled once they appear');
    assert.equal(disconnect, 1, 'the observer stops once it has succeeded');
  }

  delete globalThis.document;
  delete globalThis.MutationObserver;
  delete globalThis.window;
});

test('the full brand transform composes title and wordmark', async () => {
  const brand = await import(new URL('plugins/newpi-brand/index.js', ROOT));
  const out = brand.brand('<html><head><title>DeepSeek Harness</title></head><body></body></html>');
  assert.ok(out.includes('<title>NewPi</title>'));
  assert.ok(!out.includes('DeepSeek Harness'));
  assert.ok(out.includes('sidebar.brand.name'));
});

test('the sidebar whale stays legible at sidebar size', async () => {
  // The mark is drawn at 28px in a 24px-tall row. The blur, the halo and the
  // decorative strokes all survive at icon size but turn to mud here, so the
  // asset has to stay a silhouette — this is the test that keeps it one.
  const { readFileSync: read } = await import('node:fs');
  const whale = read(new URL('assets/whale.svg', ROOT), 'utf8');
  assert.ok(whale.includes('<svg'), 'the mark must be an SVG');
  assert.ok(!whale.includes('feGaussianBlur'), 'no blur in the sidebar mark');
  assert.ok(!whale.includes('filter='), 'no filter in the sidebar mark');
  assert.ok(whale.includes('<title id="title">NewPi whale</title>'));
  // The pi is the point of the mark: its path and the disc behind it stay.
  assert.ok(whale.includes('fill="#edfbff"'), 'the pi path is missing');
  assert.ok(whale.includes('r="47"'), 'the disc behind the pi is missing');
});

test('the rows that do not need memory survive a launch without a sidecar', async () => {
  // The Rust suite proves the rows are produced; this proves the ones that have
  // nothing to do with memory are not dropped along with the memory rows when
  // the sidecar is unavailable. The branding row is the product name, the
  // storage console measures a disk, and the context and cache manager observes
  // a context: none of the three has a reason to be conditional on a database.
  const runtime = readFileSync(new URL('../src-tauri/src/runtime.rs', import.meta.url), 'utf8');
  const filter = /fn without_memory\([\s\S]*?\n\}/.exec(runtime);
  assert.ok(filter !== null, 'the launch must decide which rows survive');
  for (const kept of ['newpi-brand', 'project-model', 'storage-console', 'context-cache-manager']) {
    assert.match(filter[0], new RegExp(`"${kept}"`), `${kept} must survive without a sidecar`);
  }
  for (const dropped of ['pocketbase-memory', 'memory-tools', 'memory-console']) {
    assert.equal(
      filter[0].includes(dropped),
      false,
      `${dropped} must be dropped when there is no sidecar, not kept`,
    );
  }
});

test('every module a plugin imports by relative path exists beside it', async () => {
  // The Rust build embeds the plugin files by name, so a file added to a plugin
  // but not to `assets.rs` would be missing from the deployed copy and the
  // harness would fail to import it — which happened once, with
  // `environment.js`. This walks the imports the plugin actually declares.
  const { readFileSync: read, readdirSync } = await import('node:fs');
  for (const directory of [
    'pocketbase-memory',
    'memory-tools',
    'memory-console',
    'storage-console',
    'project-model',
    'newpi-brand',
  ]) {
    const root = new URL(`../plugins/${directory}/`, import.meta.url);
    // `.mjs` counts: a browser module a plugin serves is one the suite may also
    // import directly, and the extension states that on its own rather than
    // relying on a package.json the deployed plugin directory would not have.
    const local = readdirSync(root).filter((name) => name.endsWith('.js') || name.endsWith('.mjs'));
    for (const file of local) {
      const source = read(fileURLToPath(new URL(file, root)), 'utf8');
      for (const match of source.matchAll(/from '(\.\/[^']+)'/g)) {
        const imported = match[1].replace('./', '');
        assert.ok(
          local.includes(imported),
          `${directory}/${file} imports ./${imported}, which is not a file in the plugin`,
        );
      }
    }
  }
});

test('the launcher patch Rust generates parses as the document the harness expects', async () => {
  // The Rust side writes this file by hand, so the tests there assert the exact
  // text. This one reads the sample that `cargo test` dumps and parses it with
  // the YAML reader the harness itself uses, which is the only check that
  // proves the *document* — not the strings — is what the loader will accept.
  const { load } = await import(harnessModule('js-yaml/index.js'));
  const sample = new URL('../src-tauri/target/test-tmp/launcher-sample.patch.yml', import.meta.url);
  let text;
  try {
    text = readFileSync(sample, 'utf8');
  } catch {
    // `cargo test` has not run yet; `pnpm run test` runs it first.
    return;
  }

  const document = load(text);
  assert.ok(Array.isArray(document), 'a patch layer is a top level array');
  assert.equal(document.length, 1);
  const [layer] = document;
  assert.ok(Array.isArray(layer.insert), 'the layer inserts rows');

  const rows = layer.insert;
  assert.deepEqual(
    rows.map((row) => row.id),
    [
      'newpi-brand',
      // The project model comes before the plugins it is the source of truth
      // for: it names the workspace root, the memory scope, and the state
      // directory the storage console is fenced by.
      'project-model',
      // The Projects section is the interface over that model. It is mounted
      // whatever the sidecar decided, and owns no endpoint of its own.
      'projects-console',
      'pocketbase-memory',
      'memory-tools',
      'memory-console',
      'storage-console',
      // The context & cache manager is mounted with every launch, sidecar or
      // not, and routing plan or not: it observes, carries no project
      // configuration of its own (the project binds it), and decides nothing.
      'context-cache-manager',
      // The console runs commands in the project's own directory, which the
      // row carries: the page names a command and never a directory.
      'terminal-console',
      'mem0',
      // The model router is attached after the memory rows and is the one row
      // that is not about memory at all. It survives a launch with no sidecar,
      // which is why it is appended rather than inserted among them.
      'model-router',
    ],
  );

  // The branding row mounts first, is never disabled, and carries the whale
  // artwork so the deployed plugin needs no second copy of the file.
  assert.equal(rows[0].disabled, undefined);
  assert.match(rows[0].name, /newpi-brand\/index\.js$/);
  const whale = rows[0].config.whale;
  assert.ok(whale.startsWith('<svg'), 'the artwork must survive YAML as one scalar');
  assert.ok(whale.trimEnd().endsWith('</svg>'));
  assert.ok(!whale.includes('<?xml'), 'the XML declaration is stripped for HTML embedding');
  assert.ok(whale.includes('NewPi whale'));

  // The project model follows the branding row and precedes the plugins whose
  // scope it names. It carries the state directory, the workspace root, the
  // project id, the display name, the memory namespace, and the application
  // identity the Projects section needs to offer a clean restart — never a
  // credential and never a backend port.
  const model = rows[1];
  assert.match(model.name, /project-model\/index\.js$/);
  assert.equal(model.disabled, undefined);
  assert.deepEqual(Object.keys(model.config), [
    'appBundle',
    'appId',
    'memoryNamespace',
    'name',
    'projectId',
    'stateDir',
    'workspace',
  ]);
  assert.equal(model.config.stateDir, '/state');
  assert.equal(model.config.workspace, '/workspace');
  assert.equal(model.config.projectId, 'twin');
  assert.equal(model.config.memoryNamespace, 'twin');
  assert.equal(typeof model.config.appId, 'string');

  // The Projects section reads that model and injects itself into the page. It
  // carries no configuration and owns no endpoint, so it has nothing to leak.
  const projects = rows[2];
  assert.match(projects.name, /projects-console\/index\.js$/);
  assert.equal(projects.disabled, undefined);
  assert.deepEqual(Object.keys(projects.config ?? {}), []);

  const backend = rows[3];
  assert.equal(backend.config.projectId, 'twin');
  // The module specifier has to survive YAML as one scalar: a bare path is
  // resolved against the profile directory and would not find the plugin.
  assert.match(backend.name, /^file:\/\/\//);
  assert.match(backend.name, /pocketbase-memory\/index\.js$/);
  assert.match(rows[4].name, /memory-tools\/index\.js$/);

  // The console row carries the two paths and two versions its manifests need,
  // and nothing that could be a secret.
  const console = rows[5];
  assert.match(console.name, /memory-console\/index\.js$/);
  assert.equal(console.config.backupDir, '/state/backups');
  assert.equal(console.config.snapshotDir, '/state/pocketbase/pb_data/backups');
  assert.equal(console.config.dataDir, '/state/pocketbase/pb_data');
  assert.equal(typeof console.config.newpiVersion, 'string');
  assert.equal(typeof console.config.pocketbaseVersion, 'string');

  // The storage console is mounted whatever memory decides, and carries the
  // roots it measures and is fenced by — never a target it could be redirected
  // to, and never a credential.
  const storage = rows[6];
  assert.match(storage.name, /storage-console\/index\.js$/);
  assert.equal(storage.disabled, undefined);
  assert.deepEqual(Object.keys(storage.config), [
    'backupDir',
    'dataDir',
    'dshHome',
    'home',
    'snapshotDir',
    'stateDir',
    'workspace',
  ]);

  // The context & cache manager is mounted whatever memory decides too, and
  // carries no configuration at all: it observes the context and the provider's
  // cache counters, and decides nothing.
  const cacheManager = rows[7];
  assert.match(cacheManager.name, /context-cache-manager\/index\.js$/);
  assert.equal(cacheManager.disabled, undefined);
  assert.deepEqual(Object.keys(cacheManager.config ?? {}), []);

  // The console runs commands in the project's own directory, which travels in
  // the row: the page names a command and never a directory.
  const terminalRow = rows[8];
  assert.match(terminalRow.name, /terminal-console\/index\.js$/);
  assert.equal(terminalRow.disabled, undefined);
  assert.deepEqual(Object.keys(terminalRow.config ?? {}), ['workspace']);
  assert.equal(terminalRow.config.workspace, '/workspace');

  assert.equal(rows[9].name, '@deepseek-ai/dsh-memory-mem0');
  assert.equal(rows[9].disabled, true, 'Mem0 is disabled by a row, never removed');

  // The credential is deliberately absent: it travels in the environment.
  assert.ok(!text.includes('password'), 'the patch must not carry a credential');
});

test('every plugin exports the loader-visible shape, with no default export', async () => {
  // The loader normalizes a module carrying a `default` export down to that
  // value, so `export default apply` would discard `inject` and `name` and
  // leave the plugin injecting nothing. That failure is silent at import time
  // and only shows up as "cannot get property ... without inject" at boot, so
  // the shape is asserted here.
  const brandPlugin = await import(new URL('plugins/newpi-brand/index.js', ROOT));
  const consolePlugin = await import(new URL('plugins/memory-console/index.js', ROOT));
  const projectPlugin = await import(new URL('plugins/project-model/index.js', ROOT));
  for (const [label, module, expectedInject] of [
    ['pocketbase-memory', backend, []],
    ['memory-tools', toolsPlugin, ['tools', 'pocketbaseMemory']],
    ['newpi-brand', brandPlugin, ['webServer']],
    ['memory-console', consolePlugin, ['webServer', 'pocketbaseMemory', 'connection']],
    ['context-cache-manager', contextCachePlugin, []],
    // The project model mounts on a bare context and reaches every optional
    // seam (workspace registry, sessions, context cache, connection) itself:
    // a deployment without one of them still gets a project.
    ['project-model', projectPlugin, []],
  ]) {
    assert.equal(typeof module.apply, 'function', `${label} must export apply`);
    assert.equal(module.default, undefined, `${label} must not have a default export`);
    assert.equal(module.name, label);
    assert.deepEqual(module.inject, expectedInject);
  }
});

test('the three tools register under the agreed names', async () => {
  const pocketbase = await startFakePocketBase();
  try {
    const { registry } = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'alpha' });
    assert.deepEqual([...registry.tools.keys()].sort(), ['forget', 'recall', 'remember']);
  } finally {
    await pocketbase.stop();
  }
});

test('no tool schema exposes a project_id argument', async () => {
  const pocketbase = await startFakePocketBase();
  try {
    const { registry } = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'alpha' });
    for (const tool of registry.tools.values()) {
      const properties = Object.keys(tool.parameters.properties ?? {});
      assert.ok(
        !properties.includes('project_id') && !properties.includes('projectId'),
        `${tool.name} must not accept a project scope from the model`,
      );
      assert.equal(tool.parameters.additionalProperties, false);
    }
  } finally {
    await pocketbase.stop();
  }
});

test('remember, recall and forget round trip through the backend', async () => {
  const pocketbase = await startFakePocketBase();
  try {
    const { registry } = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'alpha' });

    const stored = await registry.call('remember', {
      content: 'Symptom: blank window.\nCause: SameSite=Strict cookie withheld.\nFix: first-load the token URL.\nProof: window renders and 401 without cookie.',
      kind: 'bugfix',
    });
    assert.equal(stored.kind, 'bugfix');
    assert.match(stored.id, /^rec/);

    const found = await registry.call('recall', { query: 'SameSite' });
    assert.equal(found.count, 1);
    assert.equal(found.memories[0].id, stored.id);
    assert.match(found.memories[0].content, /Cause: SameSite=Strict/);

    const deleted = await registry.call('forget', { id: stored.id });
    assert.deepEqual(deleted, { id: stored.id, deleted: true });

    const after = await registry.call('recall', { query: 'SameSite' });
    assert.equal(after.count, 0);
  } finally {
    await pocketbase.stop();
  }
});

test('recall filters by kind and honours the limit', async () => {
  const pocketbase = await startFakePocketBase();
  try {
    const { registry } = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'alpha' });
    await registry.call('remember', { content: 'note one about widgets', kind: 'note' });
    await registry.call('remember', { content: 'note two about widgets', kind: 'note' });
    await registry.call('remember', { content: 'decision about widgets', kind: 'decision' });

    const notes = await registry.call('recall', { query: 'widgets', kind: 'note' });
    assert.equal(notes.count, 2);
    assert.ok(notes.memories.every((memory) => memory.kind === 'note'));

    const limited = await registry.call('recall', { query: 'widgets', limit: 1 });
    assert.equal(limited.count, 1);

    const recent = await registry.call('recall', { query: '' });
    assert.equal(recent.count, 3, 'an empty query lists the newest memories of the project');
  } finally {
    await pocketbase.stop();
  }
});

test('a memory written by one project is invisible and undeletable from another', async () => {
  const pocketbase = await startFakePocketBase();
  try {
    const alpha = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'alpha' });
    const beta = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'beta' });

    const secret = await alpha.registry.call('remember', {
      content: 'alpha internal convention: never touch the billing table',
      kind: 'lesson',
    });

    // Beta cannot see it, even with a query that would match the text exactly.
    const betaRead = await beta.registry.call('recall', { query: 'billing table' });
    assert.equal(betaRead.count, 0);
    const betaList = await beta.registry.call('recall', { query: '' });
    assert.equal(betaList.count, 0);

    // Beta cannot delete it by id either, and the row survives the attempt.
    const betaDelete = await beta.registry.call('forget', { id: secret.id });
    assert.deepEqual(betaDelete, { id: secret.id, deleted: false });
    assert.equal(pocketbase.records.length, 1);
    assert.equal(pocketbase.records[0].project_id, 'alpha');

    // Alpha still sees its own memory.
    const alphaRead = await alpha.registry.call('recall', { query: 'billing table' });
    assert.equal(alphaRead.count, 1);
  } finally {
    await pocketbase.stop();
  }
});

test('memories survive a harness restart', async () => {
  const pocketbase = await startFakePocketBase();
  try {
    const first = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'alpha' });
    const stored = await first.registry.call('remember', {
      content: 'the project pins Node 24',
      kind: 'note',
    });

    // A restart is a fresh context, a fresh service, and a fresh client: only
    // the PocketBase data directory is shared.
    const second = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'alpha' });
    const recalled = await second.registry.call('recall', { query: 'Node 24' });
    assert.equal(recalled.count, 1);
    assert.equal(recalled.memories[0].id, stored.id);
    assert.equal(recalled.memories[0].content, 'the project pins Node 24');
  } finally {
    await pocketbase.stop();
  }
});

test('invalid arguments fail before reaching the backend', async () => {
  const pocketbase = await startFakePocketBase();
  try {
    const { registry } = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'alpha' });

    await assert.rejects(
      registry.call('remember', { content: '   ', kind: 'note' }),
      /non-empty/,
    );
    // The schema rejects a bad enum before `execute` is reached.
    await assert.rejects(
      registry.call('remember', { content: 'x', kind: 'gossip' }),
      /must be one of \["note","decision","bugfix","lesson"\]/,
    );
    await assert.rejects(registry.call('recall', { query: 'x', kind: 'gossip' }), /must be one of/);
    // `limit` has no numeric bound in the schema, so the tool body owns it.
    await assert.rejects(registry.call('recall', { query: 'x', limit: 0 }), /positive integer/);

    // Unknown arguments are refused by the schema before `execute` runs, which
    // is the property that keeps a `project_id` argument from ever being read.
    await assert.rejects(
      registry.call('recall', { query: 'x', project_id: 'beta' }),
      /not a declared property/,
    );
    await assert.rejects(registry.call('remember', { content: 'x' }), /missing required property/);

    // A well formed id that names nothing is a normal miss, not an error.
    assert.deepEqual(await registry.call('forget', { id: 'does-not-exist' }), {
      id: 'does-not-exist',
      deleted: false,
    });

    assert.equal(pocketbase.records.length, 0);
  } finally {
    await pocketbase.stop();
  }
});

test('an unreachable sidecar is reported, and the boot still succeeds', async () => {
  const pocketbase = await startFakePocketBase();
  const baseUrl = pocketbase.baseUrl;
  await pocketbase.stop();

  const { registry, memory } = await bootPlugins({ baseUrl, projectId: 'alpha' });
  assert.equal(memory.projectId, 'alpha', 'the service still loads with its scope');

  await assert.rejects(registry.call('recall', { query: 'anything' }), (error) => {
    assert.equal(error.code, 'MEMORY_UNREACHABLE');
    assert.match(error.message, /does not answer/);
    return true;
  });
});

test('a missing project_id is reported instead of silently writing nowhere', async () => {
  const pocketbase = await startFakePocketBase();
  try {
    const { registry, memory } = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: '' });
    assert.equal(memory.projectId, '');
    await assert.rejects(registry.call('remember', { content: 'x', kind: 'note' }), (error) => {
      assert.equal(error.code, 'MEMORY_NO_PROJECT');
      return true;
    });
    assert.equal(pocketbase.records.length, 0);
  } finally {
    await pocketbase.stop();
  }
});

test('the backend re-authenticates when the cached token is rejected', async () => {
  const pocketbase = await startFakePocketBase();
  try {
    const { registry, memory } = await bootPlugins({ baseUrl: pocketbase.baseUrl, projectId: 'alpha' });
    await registry.call('remember', { content: 'first', kind: 'note' });
    assert.equal(pocketbase.state.logins, 1, 'one login for the first call');

    // The credential stays valid, but the token the client cached is no longer
    // the one the sidecar accepts (a restarted or rotated PocketBase): the
    // first call gets a 401, the client logs in again, and the retry is
    // accepted with the replacement token.
    pocketbase.state.rejectToken = pocketbase.state.activeToken;
    pocketbase.state.tokenIssuer = () => 'token-issued-after-the-restart';
    const recovered = await registry.call('remember', { content: 'second', kind: 'note' });
    assert.ok(recovered.id);
    assert.equal(pocketbase.state.logins, 2, 'the client logged in again after the 401');
    assert.equal(pocketbase.records.length, 2);

    // The recovered client stays usable for later calls without another login.
    const after = await registry.call('recall', { query: 'second' });
    assert.equal(after.count, 1);
    assert.equal(pocketbase.state.logins, 2);
    assert.match(await memory.health(), /collection memories/);
  } finally {
    await pocketbase.stop();
  }
});
