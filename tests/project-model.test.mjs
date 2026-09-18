/**
 * The Project Model: the project vocabulary, the two guardrails, the registry,
 * and the seams the service binds.
 *
 * The tests that matter most are the refusals. A project model is only
 * trustworthy if a switch during an operation is refused rather than raced, if
 * a path cannot escape the project root, if a capability that was not granted
 * cannot be used, and if a corrupt registry costs the recent list rather than
 * the launch. So this suite proves each of those, alongside the happy paths:
 * create, open, close, recent, session association, UI state and handoff
 * survival across a restart.
 *
 * The pure rules are exercised on their own (no Cordis, no filesystem), and the
 * service is booted on a real Cordis context with stand-ins for the optional
 * seams — the workspace registry, the live session store, the context & cache
 * manager and the authenticated connection — so what runs is the service the
 * harness would run.
 *
 * @module newpi/tests/project-model
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CAPABILITIES,
  DEFAULT_CAPABILITIES,
  MODIFIABLE_CAPABILITIES,
  OperationGuard,
  ProjectError,
  assertCapability,
  assertModifiableCapability,
  assertProjectId,
  associateSession,
  createProject,
  deriveProjectId,
  disassociateSession,
  handoffFromVersions,
  isInside,
  normalizeCapabilities,
  normalizeProject,
  resolveInside,
  sessionBelongsToProject,
  slugify,
  updateCapability,
  updateUiState,
} from '../plugins/project-model/model.js';
import {
  ProjectStore,
  emptyProjectState,
  forgetProject,
  parseProjectState,
  promoteRecent,
  serializeProjectState,
  setCurrentProject,
  upsertProject,
} from '../plugins/project-model/store.js';

// --------------------------------------------------------------- the harness

/**
 * Resolve a path inside the harness's module tree.
 *
 * The plugin imports `@deepseek-ai/cordis`, which only resolves inside the
 * harness's module tree; the tests run against the same tree so what they boot
 * is what NewPi boots.
 *
 * @param name - the package or file to resolve, relative to the tree root.
 * @returns the absolute path.
 */
function harnessPath(name) {
  const tree =
    process.env.DSH_PROFILE_MODULES ?? join(process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules');
  return join(tree, name);
}

/** Resolve a path inside this repository. */
const ROOT = new URL('../', import.meta.url);

/** Let the pending microtasks and immediates settle. */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Wait until a condition holds, or fail the test.
 *
 * The service's observers are asynchronous by design (an event handler starts a
 * persisted association without blocking the append), so a test that emitted an
 * event has to wait for the effect, not merely for a microtask.
 *
 * @param predicate - the condition to await.
 * @param message - the failure message.
 */
async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

/**
 * A fresh, canonical directory under the system temporary directory.
 *
 * The `realpath` matters on macOS, where the temporary directory is a symlink:
 * the service canonicalizes a project root, so a test comparing against the
 * unresolved spelling would be comparing two names for one directory.
 */
async function directory(prefix) {
  return realpath(await mkdtemp(join(tmpdir(), `newpi-${prefix}-`)));
}

// ============================================================ the vocabulary

test('capabilities default to the documented set and a declared value wins', () => {
  const defaults = normalizeCapabilities(undefined);
  assert.deepEqual(defaults, DEFAULT_CAPABILITIES);
  // `network` is off by default: the safe default adds no reach.
  assert.equal(defaults.network, false);

  const declared = normalizeCapabilities({ network: true, git: false });
  assert.equal(declared.network, true);
  assert.equal(declared.git, false);
  assert.equal(declared.readWorkspace, true, 'an absent capability takes the default');

  // An unknown key is dropped rather than carried into the model.
  assert.deepEqual(Object.keys(normalizeCapabilities({ nonsense: true })).sort(), [...CAPABILITIES].sort());

  // A non boolean is refused rather than coerced.
  assert.throws(
    () => normalizeCapabilities({ network: 'yes' }),
    (error) => error instanceof ProjectError && error.code === 'PROJECT_INVALID_SETTINGS',
  );
});

test('a capability the project did not grant is denied with a 403', () => {
  const project = createProject({
    id: 'twin',
    name: 'Twin',
    rootPath: '/tmp',
    settings: { capabilities: { terminal: false } },
  });
  assert.equal(assertCapability(project, 'readWorkspace'), 'readWorkspace');
  assert.throws(
    () => assertCapability(project, 'terminal'),
    (error) => error instanceof ProjectError && error.code === 'PROJECT_CAPABILITY_DENIED' && error.status === 403,
  );
  assert.throws(
    () => assertCapability(project, 'sudo'),
    (error) => error instanceof ProjectError && error.code === 'PROJECT_UNKNOWN_CAPABILITY',
  );
});

test('a project id is derived from the directory name and stays distinct', () => {
  assert.equal(slugify('My Project!'), 'my-project');
  assert.equal(slugify(''), 'default');
  assert.equal(deriveProjectId('/Users/x/Documents/twin'), 'twin');

  // Two directories that share a base name get distinct ids.
  const first = deriveProjectId('/Users/x/work/twin');
  const second = deriveProjectId('/Users/x/home/twin', { taken: new Set([first]) });
  assert.notEqual(first, second);
  assert.ok(second.startsWith('twin-'), `expected a collision suffix, got ${second}`);
  // And the derivation is stable: the same path always yields the same id.
  assert.equal(deriveProjectId('/Users/x/home/twin', { taken: new Set([first]) }), second);
});

test('a project id must be a readable, filter safe slug', () => {
  assert.equal(assertProjectId(' twin '), 'twin');
  assert.throws(() => assertProjectId(''), (error) => error.code === 'PROJECT_INVALID_ID');
  assert.throws(() => assertProjectId('has space'), (error) => error.code === 'PROJECT_INVALID_ID');
  assert.throws(() => assertProjectId('../escape'), (error) => error.code === 'PROJECT_INVALID_ID');
});

// ============================================================ the fence

test('a path inside the project resolves and a path outside is refused', () => {
  const root = '/Users/x/project';
  assert.equal(resolveInside(root, 'src/index.js'), '/Users/x/project/src/index.js');
  assert.equal(resolveInside(root, '/Users/x/project/README.md'), '/Users/x/project/README.md');
  assert.equal(resolveInside(root, '.'), root);

  // `..` cannot climb out, whether spelled relatively or absolutely.
  assert.throws(
    () => resolveInside(root, '../elsewhere'),
    (error) => error.code === 'PROJECT_OUTSIDE_ROOT' && error.status === 403,
  );
  assert.throws(() => resolveInside(root, '/etc/passwd'), (error) => error.code === 'PROJECT_OUTSIDE_ROOT');
  assert.throws(
    () => resolveInside(root, 'src/../../elsewhere'),
    (error) => error.code === 'PROJECT_OUTSIDE_ROOT',
  );

  // The fence is a path boundary, not a string prefix: a sibling that merely
  // starts with the root's name is outside.
  assert.equal(isInside(root, '/Users/x/project-other'), false);
  assert.equal(isInside(root, root), true);
});

// ============================================================ sessions and state

test('a session is associated once, most recent first', () => {
  let project = createProject({ id: 'twin', name: 'Twin', rootPath: '/tmp' });
  project = associateSession(project, 'session-a');
  project = associateSession(project, 'session-b');
  project = associateSession(project, 'session-a');
  assert.deepEqual([...project.sessions], ['session-a', 'session-b']);

  project = disassociateSession(project, 'session-a');
  assert.deepEqual([...project.sessions], ['session-b']);
  // Removing an absent session is idempotent.
  assert.deepEqual([...disassociateSession(project, 'nope').sessions], ['session-b']);

  assert.throws(() => associateSession(project, ''), (error) => error.code === 'PROJECT_INVALID_SESSION');
});

test('a session belongs to the project whose root contains its cwd', () => {
  const project = createProject({ id: 'twin', name: 'Twin', rootPath: '/Users/x/project' });
  assert.equal(sessionBelongsToProject(project, '/Users/x/project/src'), true);
  assert.equal(sessionBelongsToProject(project, '/Users/x/project'), true);
  assert.equal(sessionBelongsToProject(project, '/Users/x/other'), false);
  assert.equal(sessionBelongsToProject(project, undefined), false);
  assert.equal(sessionBelongsToProject(project, ''), false);
});

test('the UI state keeps the last session, the last tab and recent files', () => {
  let project = createProject({ id: 'twin', name: 'Twin', rootPath: '/tmp' });
  project = updateUiState(project, {
    lastSessionId: 'session-a',
    lastTab: 'newpi-files',
    recentFiles: ['src/a.js', 'src/b.js', 'src/a.js'],
  });
  assert.equal(project.uiState.lastSessionId, 'session-a');
  assert.equal(project.uiState.lastTab, 'newpi-files');
  assert.deepEqual([...project.uiState.recentFiles], ['src/a.js', 'src/b.js']);

  // Recent files are capped, oldest first, and a bad entry is dropped.
  const many = Array.from({ length: 30 }, (_, index) => `file-${index}.js`);
  project = updateUiState(project, { recentFiles: [...many, 42] });
  assert.equal(project.uiState.recentFiles.length, 20);
  assert.equal(project.uiState.recentFiles[0], 'file-0.js');

  // `null` clears a scalar rather than storing the string "null".
  project = updateUiState(project, { lastTab: null });
  assert.equal(project.uiState.lastTab, null);
});

test('a handoff is read from the manager version ledger, never invented', () => {
  const handoff = handoffFromVersions(
    { handoffVersion: 3, handoffLabel: 'handoff_v3', handoff: { digest: 'abc' } },
    'session-a',
    1000,
  );
  assert.deepEqual(handoff, {
    version: 3,
    label: 'handoff_v3',
    digest: 'abc',
    sessionId: 'session-a',
    at: 1000,
  });

  // No manager, or one that observed no compaction, yields nothing.
  assert.equal(handoffFromVersions(null, 'session-a'), null);
  assert.equal(handoffFromVersions({ handoffVersion: undefined }, 'session-a'), null);
});

// ============================================================ the guard

test('an operation in flight refuses a project switch, and force overrides it', async () => {
  const guard = new OperationGuard();
  const operation = guard.begin({ kind: 'editor', label: 'save' });
  assert.equal(guard.size, 1);

  assert.throws(
    () => guard.assertCanSwitch(false),
    (error) => error instanceof ProjectError && error.code === 'PROJECT_BUSY' && error.status === 409,
  );
  // The escape hatch is a typed argument, never a default.
  assert.doesNotThrow(() => guard.assertCanSwitch(true));

  operation.release();
  assert.equal(guard.size, 0);
  assert.doesNotThrow(() => guard.assertCanSwitch(false));
  // Releasing twice is harmless.
  operation.release();
  assert.equal(guard.size, 0);
});

test('a guarded operation releases its slot however the body settles', async () => {
  const guard = new OperationGuard();
  assert.equal(await guard.run({ kind: 'terminal' }, async () => 'done'), 'done');
  assert.equal(guard.size, 0, 'a fulfilled body must release the slot');

  await assert.rejects(
    guard.run({ kind: 'terminal' }, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(guard.size, 0, 'a thrown body must release the slot');
  assert.doesNotThrow(() => guard.assertCanSwitch(false));
});

// ============================================================ the registry

test('the registry survives a round trip and tolerates a corrupt document', () => {
  const state = emptyProjectState();
  upsertProject(state, { id: 'twin', rootPath: '/tmp/twin' });
  upsertProject(state, { id: 'other', rootPath: '/tmp/other' });
  setCurrentProject(state, 'other');
  promoteRecent(state, 'other');

  const text = serializeProjectState(state);
  const { state: reloaded, warning } = parseProjectState(text);
  assert.equal(warning, null);
  assert.equal(reloaded.currentId, 'other');
  assert.deepEqual(reloaded.recent, ['other', 'twin']);
  assert.equal(reloaded.projects.twin.rootPath, '/tmp/twin');

  // Garbage is the empty registry with a warning, never a thrown error.
  const corrupt = parseProjectState('{ not json');
  assert.equal(corrupt.state.currentId, null);
  assert.deepEqual(corrupt.state.recent, []);
  assert.ok(corrupt.warning);

  // A bad record is dropped and reported; the good ones stay. The map key is
  // the id when a record omits it, but a record with no root names nothing.
  const mixed = parseProjectState(
    JSON.stringify({
      version: 1,
      currentId: 'good',
      recent: ['good', 'bad'],
      projects: { good: { id: 'good', rootPath: '/tmp/good' }, bad: { id: 'bad' } },
    }),
  );
  assert.ok(mixed.state.projects.good);
  assert.equal(mixed.state.projects.bad, undefined, 'a project with no root cannot be kept');
  assert.ok(mixed.warning);

  // Forgetting clears the current pointer when it names the forgotten project.
  const forgotten = forgetProject({ ...emptyProjectState(), currentId: 'twin', recent: ['twin'], projects: { twin: { id: 'twin' } } }, 'twin');
  assert.equal(forgotten.currentId, null);
  assert.deepEqual(forgotten.recent, []);
});

test('normalizeProject refuses a project without an id or a root', () => {
  assert.throws(() => normalizeProject({ rootPath: '/tmp' }), (error) => error.code === 'PROJECT_INVALID_ID');
  assert.throws(() => normalizeProject({ id: 'twin' }), (error) => error.code === 'PROJECT_INVALID');
  const project = normalizeProject({ id: 'twin', rootPath: '/tmp/twin' });
  assert.equal(project.name, 'twin', 'the id is the name until one is given');
  assert.equal(project.memoryNamespace, 'twin');
  assert.deepEqual(project.sessions, []);
});

test('the registry file is written once, atomically, and reloads', async () => {
  const home = await directory('state');
  try {
    const store = new ProjectStore({ stateDir: home });
    const state = emptyProjectState();
    upsertProject(state, normalizeProject({ id: 'twin', rootPath: '/tmp/twin' }));
    setCurrentProject(state, 'twin');
    await store.save(state);

    const reloaded = await new ProjectStore({ stateDir: home }).load();
    assert.equal(reloaded.currentId, 'twin');
    assert.equal(reloaded.projects.twin.rootPath, '/tmp/twin');

    // A missing file loads as the empty registry, with no warning.
    const fresh = new ProjectStore({ stateDir: join(home, 'absent') });
    assert.deepEqual((await fresh.load()).recent, []);
    assert.equal(fresh.warning, null);

    // No temporary file is left behind by the atomic commit.
    const entries = await readdir(home);
    assert.deepEqual(entries, ['projects.json']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// ============================================================ the service

/**
 * A stand-in for `ctx.workspaceRegistry`, recording what the service asks of it.
 *
 * It mirrors the real registry's consumer interface: `create` canonicalizes and
 * returns a workspace, `get` looks one up, and `attachSession` records the
 * association.
 */
function fakeWorkspaceRegistry() {
  const workspaces = new Map();
  let sequence = 0;
  return {
    created: [],
    attached: [],
    async create(path, title) {
      if (workspaces.has(path)) return workspaces.get(path);
      const workspace = {
        id: `workspace-${++sequence}`,
        path,
        title: title ?? path,
        sessionIds: [],
        async attachSession(sessionId) {
          if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId);
        },
      };
      workspaces.set(path, workspace);
      this.created.push(workspace);
      return workspace;
    },
    get(id) {
      return [...workspaces.values()].find((workspace) => workspace.id === id);
    },
    async resolveByPath(path) {
      return workspaces.get(path);
    },
  };
}

/** A stand-in for `ctx.sessions`, holding live sessions the test provides. */
function fakeSessions(live = []) {
  return { list: () => [...live], get: (id) => live.find((session) => session.id === id) };
}

/** A stand-in for `ctx.contextCache`, recording the binding it receives. */
function fakeContextCache() {
  return {
    bound: null,
    bindProject(project) {
      this.bound = project;
      return project;
    },
    unbindProject() {
      this.bound = null;
    },
    project() {
      return this.bound;
    },
    versions: () => null,
    cacheStats: () => ({ calls: 0 }),
  };
}

/**
 * A stand-in for `ctx.connection`, capturing the routes a plugin registers.
 */
function fakeConnection() {
  const routes = new Map();
  return {
    routes,
    fetch: {
      register(route) {
        assert.ok(route.path.startsWith('/api/'), 'a NewPi endpoint lives under /api/');
        assert.equal(route.requestBody, 'buffered');
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
  };
}

/**
 * Boot the project model on a real Cordis context.
 *
 * @param options - the launch's facts and the optional seams to provide.
 * @param options.workspace - the launch workspace root.
 * @param options.stateDir - where the registry lives.
 * @param options.projectId - the configured project scope.
 * @param options.sessions - live sessions to expose.
 * @param options.workspaces - whether to provide a workspace registry.
 * @returns the context, the service, and the fake seams.
 */
async function boot(options) {
  const { Context } = await import(pathToFileURL(harnessPath('@deepseek-ai/cordis/lib/index.js')));
  const ctx = new Context();
  const connection = fakeConnection();
  const contextCache = options.contextCache ?? fakeContextCache();
  const workspaces = options.workspaces === false ? null : fakeWorkspaceRegistry();
  ctx.provide('connection', connection);
  ctx.provide('contextCache', contextCache);
  if (workspaces !== null) ctx.provide('workspaceRegistry', workspaces);
  ctx.provide('sessions', fakeSessions(options.sessions ?? []));

  const { apply } = await import(new URL('plugins/project-model/index.js', ROOT));
  apply(ctx, {
    stateDir: options.stateDir,
    workspace: options.workspace,
    projectId: options.projectId,
    name: options.name ?? '',
    memoryNamespace: options.memoryNamespace ?? '',
    appId: options.appId ?? '',
    appBundle: options.appBundle ?? '',
    picker: options.picker,
    relaunch: options.relaunch,
    announce: false,
  });
  const model = ctx.get('projectModel');
  assert.ok(model, 'the plugin must register ctx.projectModel');
  await model.ready();
  return { ctx, model, connection, contextCache, workspaces };
}

test('the launched project is opened, bound to the workspace, and made current', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    const { model, contextCache, workspaces } = await boot({
      workspace,
      stateDir: state,
      projectId: 'twin',
      name: 'Twin',
    });

    const current = model.currentProject;
    assert.ok(current, 'a project must be open after the mount');
    assert.equal(current.id, 'twin');
    assert.equal(current.name, 'Twin');
    assert.equal(current.rootPath, workspace);
    assert.equal(current.memoryNamespace, 'twin');
    assert.equal(current.detached, false, 'the launch workspace is the attached root');

    // The DSH workspace record is created, not replaced.
    assert.equal(workspaces.created.length, 1);
    assert.equal(workspaces.created[0].path, workspace);
    assert.equal(current.workspaceId, workspaces.created[0].id);

    // The context & cache manager is bound to the project.
    assert.deepEqual(contextCache.bound, { id: 'twin', namespace: 'twin' });
    assert.equal(model.context().available, true);
    assert.equal(model.context().projectId, 'twin');

    // Capabilities come from the model, with the safe network default.
    assert.equal(model.capabilities().network, false);
    assert.doesNotThrow(() => model.assertCapability('writeWorkspace'));
    assert.throws(() => model.assertCapability('network'), (error) => error.code === 'PROJECT_CAPABILITY_DENIED');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('create, open and close move one current project, keeping the recents', async () => {
  const first = await directory('alpha');
  const second = await directory('beta');
  const state = await directory('state');
  try {
    const { model } = await boot({ workspace: first, stateDir: state, projectId: 'alpha' });
    assert.equal(model.currentProject.id, 'alpha');

    const created = await model.create({ id: 'beta', name: 'Beta', rootPath: second });
    assert.equal(created.id, 'beta');
    assert.equal(model.currentProject.id, 'alpha', 'creating a project must not open it');
    assert.deepEqual(model.recent().map((project) => project.id).sort(), ['alpha', 'beta']);

    const opened = await model.open(created.id);
    assert.equal(opened.id, 'beta');
    assert.equal(model.currentProject.id, 'beta');
    assert.equal(model.currentProject.detached, true, 'another root is detached from the launch cwd');

    assert.equal(await model.close(), true);
    assert.equal(model.currentProject, null);
    assert.equal(await model.close(), false, 'closing with nothing open is a no-op');

    // The record survives the close: reopening is one call.
    assert.equal((await model.open('beta')).id, 'beta');
    assert.equal(model.recent()[0].id, 'beta', 'the last opened project leads the recents');
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('an operation in flight refuses a switch, and force is the way through', async () => {
  const first = await directory('alpha');
  const second = await directory('beta');
  const state = await directory('state');
  try {
    const { model } = await boot({ workspace: first, stateDir: state, projectId: 'alpha' });
    await model.create({ id: 'beta', rootPath: second, name: 'Beta' });

    const operation = model.beginOperation({ kind: 'editor', label: 'save src/a.js' });
    assert.equal(model.operations().length, 1);
    await assert.rejects(
      model.open('beta'),
      (error) => error instanceof ProjectError && error.code === 'PROJECT_BUSY',
    );
    await assert.rejects(model.close(), (error) => error.code === 'PROJECT_BUSY');
    assert.equal(model.currentProject.id, 'alpha', 'the refused switch must change nothing');

    operation.release();
    assert.equal((await model.open('beta')).id, 'beta');
    assert.equal(model.operations().length, 0);

    // And a guarded body releases its own slot, even while it holds the switch.
    await model.runOperation({ kind: 'terminal' }, async () => {
      await assert.rejects(model.close(), (error) => error.code === 'PROJECT_BUSY');
    });
    assert.equal(model.operations().length, 0);
    assert.equal(await model.close(), true);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('sessions are associated with the project and mirrored to the workspace', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    const live = [
      { id: 'session-here', header: { cwd: workspace } },
      { id: 'session-elsewhere', header: { cwd: '/somewhere/else' } },
    ];
    const { model, ctx, workspaces } = await boot({
      workspace,
      stateDir: state,
      projectId: 'twin',
      sessions: live,
    });

    // The startup adoption took the session whose cwd is inside the project.
    assert.deepEqual(model.sessions(), ['session-here']);
    assert.ok(workspaces.created[0].sessionIds.includes('session-here'));

    // A session created later is adopted through the event seam.
    ctx.emit('session/created', { id: 'session-later', header: { cwd: workspace } });
    await waitFor(
      () => model.sessions().includes('session-later'),
      'a session created inside the project must be adopted',
    );
    assert.deepEqual(model.sessions(), ['session-later', 'session-here']);

    // One created outside the project is not.
    ctx.emit('session/created', { id: 'session-away', header: { cwd: '/elsewhere' } });
    await settle();
    assert.equal(model.sessions().includes('session-away'), false);

    await model.detachSession('session-later');
    assert.deepEqual(model.sessions(), ['session-here']);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('the registry reloads the recents, the UI state and the handoff', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    const first = await boot({ workspace, stateDir: state, projectId: 'twin', name: 'Twin' });
    await first.model.setUiState({
      lastSessionId: 'session-a',
      lastTab: 'newpi-files',
      recentFiles: ['src/a.js', 'src/b.js'],
    });
    await first.model.setHandoff({ version: 2, label: 'handoff_v2', digest: 'abc', sessionId: 'session-a', at: 1234 });
    assert.equal(first.model.handoffState().version, 2);

    // A second boot is what a relaunch is: a fresh service, the same file.
    const second = await boot({ workspace, stateDir: state, projectId: 'twin', name: 'Twin' });
    assert.equal(second.model.currentProject.id, 'twin');
    assert.equal(second.model.uiState().lastSessionId, 'session-a');
    assert.equal(second.model.uiState().lastTab, 'newpi-files');
    assert.deepEqual([...second.model.uiState().recentFiles], ['src/a.js', 'src/b.js']);
    assert.equal(second.model.handoffState().version, 2);
    assert.equal(second.model.recent().length, 1, 'one project is remembered once');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a project moved on disk keeps its scope and updates its root', async () => {
  const original = await directory('twin');
  const state = await directory('state');
  try {
    const first = await boot({ workspace: original, stateDir: state, projectId: 'twin' });
    assert.equal(first.model.currentProject.rootPath, original);
    await first.model.setUiState({ lastTab: 'kept' });

    // The same scope is launched from another directory: the record follows
    // the launch rather than forking into a second project.
    const moved = await directory('twin-moved');
    try {
      const second = await boot({ workspace: moved, stateDir: state, projectId: 'twin' });
      assert.equal(second.model.recent().length, 1);
      assert.equal(second.model.currentProject.rootPath, moved);
      assert.equal(second.model.uiState().lastTab, 'kept', 'the state survives the move');
    } finally {
      await rm(moved, { recursive: true, force: true });
    }
  } finally {
    await rm(original, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a completed compaction records the manager handoff on the project', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    const contextCache = fakeContextCache();
    contextCache.versions = (sessionId) => ({
      sessionId,
      contextVersion: 4,
      contextLabel: 'ctx_v4',
      handoffVersion: 2,
      handoffLabel: 'handoff_v2',
      handoff: { digest: 'digest-2' },
    });
    const { model, ctx } = await boot({
      workspace,
      stateDir: state,
      projectId: 'twin',
      sessions: [{ id: 'session-a', header: { cwd: workspace } }],
      contextCache,
    });
    assert.deepEqual(model.sessions(), ['session-a']);

    // The manager is the only object that knows a compaction committed, so the
    // project stores what it reports rather than deriving a second answer.
    ctx.emit('session/event', { id: 'session-a' }, { type: 'compaction/end' });
    await waitFor(() => model.handoffState()?.version === 2, 'the handoff must reach the project');
    const handoff = model.handoffState();
    assert.equal(handoff.label, 'handoff_v2');
    assert.equal(handoff.digest, 'digest-2');
    assert.equal(handoff.sessionId, 'session-a');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('the endpoint is registered and refuses an undeclared parameter', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    const { model, connection } = await boot({ workspace, stateDir: state, projectId: 'twin' });
    await settle();
    const route = connection.routes.get('/api/newpi.project');
    assert.ok(route, 'the authenticated project endpoint must be registered');

    const call = async (action, params) =>
      route.fetch(new Request('http://127.0.0.1/api/newpi.project', {
        method: 'POST',
        body: JSON.stringify({ action, params }),
      }));

    const current = await (await call('project.current', {})).json();
    assert.equal(current.ok, true);
    assert.equal(current.value.id, 'twin');

    const applied = await (await call('project.uiState.set', { lastTab: 'newpi-files' })).json();
    assert.equal(applied.ok, true);
    assert.equal(applied.value.lastTab, 'newpi-files');

    const refused = await (await call('project.open', { id: 'twin', capabilities: { network: true } })).json();
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, 'PROJECT_INVALID_ARGS');

    const unknown = await (await call('project.teleport', {})).json();
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'PROJECT_UNKNOWN_ACTION');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a deployment without the optional seams still gets a project', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    // No workspace registry is provided; the service must not depend on one.
    const { model } = await boot({ workspace, stateDir: state, projectId: 'solo', workspaces: false });
    assert.equal(model.currentProject.id, 'solo');
    assert.equal(model.currentProject.workspaceId, null);
    assert.equal(model.resolve('src/a.js'), join(workspace, 'src/a.js'));
    assert.throws(() => model.resolve('../escape'), (error) => error.code === 'PROJECT_OUTSIDE_ROOT');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a corrupt registry costs the recents, not the launch', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    await writeFile(join(state, 'projects.json'), '{ this is not json', 'utf8');
    const { model } = await boot({ workspace, stateDir: state, projectId: 'twin' });
    // The launch project was recreated from the launch facts.
    assert.equal(model.currentProject.id, 'twin');
    assert.ok(model.warning, 'the unreadable registry must be reported, not hidden');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('create refuses a directory that does not exist', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    const { model } = await boot({ workspace, stateDir: state, projectId: 'twin' });
    await assert.rejects(
      model.create({ rootPath: join(workspace, 'nope') }),
      (error) => error instanceof ProjectError && error.code === 'PROJECT_NOT_A_DIRECTORY',
    );
    await assert.rejects(
      model.open({ rootPath: join(workspace, 'nope') }),
      (error) => error.code === 'PROJECT_NOT_A_DIRECTORY',
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('forgetting the current project releases it and the manager binding', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    const { model, contextCache } = await boot({ workspace, stateDir: state, projectId: 'twin' });
    const changes = [];
    model.onChange((reason) => changes.push(reason));

    assert.equal(await model.forget('twin'), true);
    assert.equal(model.currentProject, null);
    assert.equal(contextCache.bound, null, 'forgetting must release the context & cache binding');
    assert.deepEqual(model.recent(), []);
    assert.equal(await model.forget('twin'), false, 'forgetting twice is a no-op');
    assert.ok(changes.includes('forgotten'));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('create is idempotent for the same canonical directory', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    const { model } = await boot({ workspace, stateDir: state, projectId: 'twin' });
    const created = await model.create({ rootPath: workspace, name: 'Twin' });
    const again = await model.create({ rootPath: workspace });
    assert.equal(created.id, again.id);
    assert.equal(model.recent().length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

// ================================================= the interface's own door

/**
 * The project endpoint a boot produced, as `{status, body}` calls.
 *
 * @param connection - the fake connection the plugin registered against.
 * @returns a function that posts one action.
 */
function endpoint(connection) {
  const route = connection.routes.get('/api/newpi.project');
  assert.ok(route, 'the authenticated project endpoint must be registered');
  return async (action, params) => {
    const response = await route.fetch(
      new Request('http://127.0.0.1/api/newpi.project', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, params }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
}

test('an operation in flight is visible to the interface and refuses a switch', async () => {
  const first = await directory('alpha');
  const second = await directory('beta');
  const state = await directory('state');
  try {
    const { model, connection } = await boot({ workspace: first, stateDir: state, projectId: 'alpha' });
    await model.create({ id: 'beta', name: 'Beta', rootPath: second });
    await settle();
    const call = endpoint(connection);

    const idle = await call('project.operations', {});
    assert.equal(idle.status, 200);
    assert.deepEqual(idle.body.value, [], 'a quiet project reports no operation');

    const operation = model.beginOperation({ kind: 'workflow', label: 'un test' });
    try {
      const listed = await call('project.operations', {});
      assert.equal(listed.body.value.length, 1);
      assert.equal(listed.body.value[0].kind, 'workflow');

      // The guard is the check: the interface may read the operations, but the
      // model is what refuses, so a page that forgot to look cannot slip past.
      const refused = await call('project.open', { id: 'beta' });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, 'PROJECT_BUSY');
      assert.equal(model.currentProject.id, 'alpha', 'a refusal leaves the project where it was');

      const forget = await call('project.forget', { id: 'beta' });
      assert.equal(forget.status, 409);
      assert.equal(forget.body.error.code, 'PROJECT_BUSY');
    } finally {
      operation.release();
    }

    const after = await call('project.open', { id: 'beta' });
    assert.equal(after.status, 200);
    assert.equal(after.body.value.id, 'beta');
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('removing a project from the recents touches nothing on disk', async () => {
  const workspace = await directory('project');
  const other = await directory('other');
  const state = await directory('state');
  try {
    const { model, connection } = await boot({
      workspace,
      stateDir: state,
      projectId: 'twin',
      sessions: [{ id: 'session-a', header: { cwd: workspace } }],
    });
    const second = await model.create({ id: 'other', name: 'Autre', rootPath: other });
    await model.attachSession('session-b', { projectId: second.id });
    assert.deepEqual(model.sessions(second.id), ['session-b']);
    await settle();
    const call = endpoint(connection);

    const removed = await call('project.forget', { id: second.id });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.value.forgotten, true);

    // Gone from the list of recents, and nowhere else.
    assert.equal(model.get(second.id), undefined);
    assert.deepEqual(
      model.recent().map((project) => project.id),
      ['twin'],
    );
    assert.ok((await stat(other)).isDirectory(), 'the project directory must survive');
    assert.ok((await stat(workspace)).isDirectory(), 'the other project directory must survive');
    assert.deepEqual(model.sessions(), ['session-a'], 'the open project keeps its sessions');
    assert.ok(
      (await readdir(state)).includes('projects.json'),
      'the registry itself must still exist for the remaining project',
    );

    // The open project keeps the memory namespace it was launched with; the
    // removed record's namespace was the only thing that disappeared.
    assert.equal(model.currentProject.memoryNamespace, 'twin');
    assert.equal(await model.forget(second.id), false, 'removing twice is a no-op');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('the folder chooser runs on the host and its answer is normalized by the model', async () => {
  const workspace = await directory('project');
  const chosen = await directory('chosen');
  const state = await directory('state');
  try {
    const panels = [];
    const { model, connection } = await boot({
      workspace,
      stateDir: state,
      projectId: 'twin',
      picker: async (options) => {
        panels.push(options);
        return chosen;
      },
    });
    await settle();
    const call = endpoint(connection);

    const picked = await call('project.chooseFolder', {});
    assert.equal(picked.status, 200);
    assert.equal(picked.body.value.cancelled, false);
    assert.equal(picked.body.value.rootPath, chosen);
    assert.equal(picked.body.value.name, basename(chosen));
    assert.equal(picked.body.value.known, false);
    assert.equal(panels.length, 1, 'the panel is asked exactly once');
    assert.equal(panels[0].directory, workspace, 'the panel opens at the open project');

    // Choosing a folder is not opening it: nothing is created and nothing moves
    // until the person confirms the change.
    assert.equal(model.currentProject.id, 'twin');
    assert.deepEqual(
      model.recent().map((project) => project.id),
      ['twin'],
    );

    // Only the declared keys reach the action.
    const refused = await call('project.chooseFolder', { rootPath: '/etc' });
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.error.code, 'PROJECT_INVALID_ARGS');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(chosen, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a cancelled panel is an answer, and an unusable one is refused', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  const file = join(state, 'not-a-directory.txt');
  try {
    await writeFile(file, 'x', 'utf8');
    const answers = [null, file];
    const { connection } = await boot({
      workspace,
      stateDir: state,
      projectId: 'twin',
      picker: async () => answers.shift(),
    });
    await settle();
    const call = endpoint(connection);

    const cancelled = await call('project.chooseFolder', {});
    assert.equal(cancelled.status, 200);
    assert.deepEqual(cancelled.body.value, { cancelled: true });

    const refused = await call('project.chooseFolder', {});
    assert.equal(refused.body.ok, false);
    assert.equal(refused.body.error.code, 'PROJECT_NOT_A_DIRECTORY');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('the restart is refused without a bundle and asked of the host with one', async () => {
  const workspace = await directory('project');
  const bare = await directory('state-bare');
  const bundled = await directory('state-bundled');
  try {
    const asked = [];
    const relaunch = async (options) => {
      asked.push(options);
      return true;
    };

    // A `pnpm dev` launch is not an application the system can reopen.
    const dev = await boot({ workspace, stateDir: bare, projectId: 'twin', relaunch });
    await settle();
    const devCall = endpoint(dev.connection);
    const unconfirmed = await devCall('project.restart', {});
    assert.equal(unconfirmed.body.ok, false);
    assert.equal(unconfirmed.body.error.code, 'PROJECT_INVALID_ARGS');

    const refused = await devCall('project.restart', { confirm: true });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'PROJECT_RESTART_UNAVAILABLE');
    assert.equal(asked.length, 0, 'nothing may be asked of the host when it cannot answer');

    // A bundled launch asks once, with the identifier and the bundle it knows.
    const app = await boot({
      workspace,
      stateDir: bundled,
      projectId: 'twin',
      appId: 'io.newpi.desktop',
      appBundle: '/Applications/NewPi.app',
      relaunch,
    });
    await settle();
    const restarted = await endpoint(app.connection)('project.restart', { confirm: true });
    assert.equal(restarted.status, 200);
    assert.deepEqual(restarted.body.value, { restarting: true });
    assert.deepEqual(asked, [{ appId: 'io.newpi.desktop', bundle: '/Applications/NewPi.app' }]);
    assert.equal(app.model.canRelaunch(), true);
    assert.equal(dev.model.canRelaunch(), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
    await rm(bundled, { recursive: true, force: true });
  }
});

test('the last known session is dated, so the interface can name it without an id', async () => {
  const workspace = await directory('project');
  const state = await directory('state');
  try {
    const { model } = await boot({ workspace, stateDir: state, projectId: 'twin' });
    assert.equal(model.currentProject.lastSessionAt, null, 'no session is known at launch');

    const before = Date.now();
    const updated = await model.attachSession('session-a');
    assert.ok(updated.lastSessionAt >= before, 'associating a session stamps the moment it was known');
    assert.equal(model.sessions()[0], 'session-a');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

// ================================================ the capability door

test('only the server’s own capability list may be changed', () => {
  assert.deepEqual(MODIFIABLE_CAPABILITIES, ['network']);
  assert.equal(assertModifiableCapability('network'), 'network');

  const project = createProject({ id: 'twin', name: 'Twin', rootPath: '/tmp' });

  // A known capability the server keeps for itself.
  assert.throws(
    () => assertModifiableCapability('git'),
    (error) => error instanceof ProjectError && error.code === 'PROJECT_CAPABILITY_READONLY' && error.status === 403,
  );
  // A name that is not a capability at all is a different refusal.
  assert.throws(
    () => assertModifiableCapability('root'),
    (error) => error.code === 'PROJECT_UNKNOWN_CAPABILITY',
  );
  // And the writer refuses both, without touching the project.
  assert.throws(() => updateCapability(project, 'git', false), (error) => error.code === 'PROJECT_CAPABILITY_READONLY');
  assert.throws(
    () => updateCapability(project, 'network', 'yes'),
    (error) => error.code === 'PROJECT_INVALID_SETTINGS',
  );
  assert.equal(project.settings.capabilities.network, false, 'the original record is untouched');

  const granted = updateCapability(project, 'network', true);
  assert.equal(granted.settings.capabilities.network, true);
  assert.equal(granted.settings.capabilities.git, true, 'the other capabilities are re-applied, not reset');
  assert.equal(project.settings.capabilities.network, false, 'the change is a copy');
});

test('the capability action refuses everything it does not declare, without writing', async () => {
  const workspace = await directory('alpha');
  const state = await directory('state');
  try {
    const { model, connection } = await boot({ workspace, stateDir: state, projectId: 'alpha' });
    await settle();
    const call = endpoint(connection);

    // The default the whole lot is about: the network is refused.
    const current = await call('project.current', {});
    assert.equal(current.body.value.settings.capabilities.network, false);
    assert.deepEqual(model.modifiableCapabilities(), ['network']);
    assert.deepEqual(model.describe().modifiableCapabilities, ['network']);

    const before = await readFile(join(state, 'projects.json'), 'utf8');
    const refusals = [
      [{ name: 'git', allowed: false }, 403, 'PROJECT_CAPABILITY_READONLY'],
      [{ name: 'terminal', allowed: true }, 403, 'PROJECT_CAPABILITY_READONLY'],
      [{ name: 'root', allowed: true }, 400, 'PROJECT_UNKNOWN_CAPABILITY'],
      [{ name: 'network', allowed: 'yes' }, 400, 'PROJECT_INVALID_ARGS'],
      [{ name: 'network' }, 400, 'PROJECT_INVALID_ARGS'],
      // The confirmation is part of the request: absent, false, or of another
      // type, the model refuses before it writes anything.
      [{ name: 'network', allowed: true }, 400, 'PROJECT_INVALID_ARGS'],
      [{ name: 'network', allowed: true, confirm: false }, 400, 'PROJECT_INVALID_ARGS'],
      [{ name: 'network', allowed: true, confirm: 'yes' }, 400, 'PROJECT_INVALID_ARGS'],
      [{ name: 'network', allowed: true, confirm: 1 }, 400, 'PROJECT_INVALID_ARGS'],
      [{ name: 'network', allowed: true, confirm: null }, 400, 'PROJECT_INVALID_ARGS'],
      [{ name: 'network', allowed: true, confirm: true, id: 'beta' }, 400, 'PROJECT_INVALID_ARGS'],
      [{ name: 'network', allowed: true, confirm: true, rootPath: '/etc' }, 400, 'PROJECT_INVALID_ARGS'],
      [{ name: 'network', allowed: true, confirm: true, capabilities: { network: true } }, 400, 'PROJECT_INVALID_ARGS'],
    ];
    for (const [params, status, code] of refusals) {
      const refused = await call('project.capability.set', params);
      assert.equal(refused.status, status, `${JSON.stringify(params)} must be refused`);
      assert.equal(refused.body.error.code, code);
      assert.equal(
        await readFile(join(state, 'projects.json'), 'utf8'),
        before,
        `${JSON.stringify(params)} must leave the registry byte for byte as it was`,
      );
    }
    assert.equal(model.currentProject.settings.capabilities.network, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('granting then removing the network is persisted, and survives a fresh service', async () => {
  const workspace = await directory('alpha');
  const state = await directory('state');
  try {
    const { model, connection } = await boot({ workspace, stateDir: state, projectId: 'alpha' });
    await settle();
    const call = endpoint(connection);

    const granted = await call('project.capability.set', {
      name: 'network',
      allowed: true,
      confirm: true,
    });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.value.settings.capabilities.network, true);
    // The record the interface is handed and the one the model reads agree.
    assert.equal(model.currentProject.settings.capabilities.network, true);
    assert.equal((await call('project.current', {})).body.value.settings.capabilities.network, true);
    // The other four capabilities are exactly the documented defaults.
    assert.deepEqual(model.capabilities(), { ...DEFAULT_CAPABILITIES, network: true });

    // A second service on the same registry reads the grant from disk.
    const reopened = await boot({ workspace, stateDir: state, projectId: 'alpha' });
    assert.equal(reopened.model.currentProject.settings.capabilities.network, true);

    const removed = await endpoint(reopened.connection)('project.capability.set', {
      name: 'network',
      allowed: false,
      confirm: true,
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.value.settings.capabilities.network, false);
    const third = await boot({ workspace, stateDir: state, projectId: 'alpha' });
    assert.equal(third.model.currentProject.settings.capabilities.network, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('a critical operation blocks a capability change and leaves the registry alone', async () => {
  const workspace = await directory('alpha');
  const state = await directory('state');
  try {
    const { model, connection } = await boot({ workspace, stateDir: state, projectId: 'alpha' });
    await settle();
    const call = endpoint(connection);
    const before = await readFile(join(state, 'projects.json'), 'utf8');

    const operation = model.beginOperation({ kind: 'workflow', label: 'un test' });
    try {
      const refused = await call('project.capability.set', {
        name: 'network',
        allowed: true,
        confirm: true,
      });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, 'PROJECT_BUSY');
      assert.equal(
        await readFile(join(state, 'projects.json'), 'utf8'),
        before,
        'the guard must refuse before anything is written',
      );
      assert.equal(model.currentProject.settings.capabilities.network, false);
    } finally {
      operation.release();
    }

    const after = await call('project.capability.set', {
      name: 'network',
      allowed: true,
      confirm: true,
    });
    assert.equal(after.status, 200);
    assert.equal(after.body.value.settings.capabilities.network, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('with no project open the capability action refuses instead of creating one', async () => {
  const workspace = await directory('alpha');
  const state = await directory('state');
  try {
    const { model, connection } = await boot({ workspace, stateDir: state, projectId: 'alpha' });
    await settle();
    const call = endpoint(connection);
    assert.equal(await model.close(), true);
    assert.equal(model.currentProject, null);
    const before = await readFile(join(state, 'projects.json'), 'utf8');

    const refused = await call('project.capability.set', {
      name: 'network',
      allowed: true,
      confirm: true,
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'PROJECT_NONE_OPEN');
    assert.equal(await readFile(join(state, 'projects.json'), 'utf8'), before);
    assert.equal(model.currentProject, null, 'no project may be created by a capability request');
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});

test('starting or opening a project never changes a capability on its own', async () => {
  const first = await directory('alpha');
  const second = await directory('beta');
  const state = await directory('state');
  try {
    // A person may have recorded the network granted for one project only; the
    // model must read that back rather than normalizing it to the default.
    await writeFile(
      join(state, 'projects.json'),
      `${JSON.stringify(
        {
          version: 1,
          currentId: 'alpha',
          recent: ['alpha', 'beta'],
          projects: {
            alpha: { id: 'alpha', name: 'Alpha', rootPath: first, settings: { capabilities: { network: true } } },
            beta: { id: 'beta', name: 'Beta', rootPath: second, settings: { capabilities: { network: false } } },
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const { model } = await boot({ workspace: first, stateDir: state, projectId: 'alpha' });
    assert.equal(model.currentProject.settings.capabilities.network, true);

    await model.open('beta');
    assert.equal(
      model.currentProject.settings.capabilities.network,
      false,
      'opening a project must not grant it anything',
    );
    await model.open('alpha');
    assert.equal(
      model.currentProject.settings.capabilities.network,
      true,
      'and must not revoke what the record carries',
    );

    // The registry is the authority, and it still says exactly what it said.
    const document = JSON.parse(await readFile(join(state, 'projects.json'), 'utf8'));
    assert.equal(document.projects.alpha.settings.capabilities.network, true);
    assert.equal(document.projects.beta.settings.capabilities.network, false);
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  }
});
