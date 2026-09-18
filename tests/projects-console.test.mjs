/**
 * The Projects section: the injected client, and the thin service behind it.
 *
 * Three things matter here and are proven below rather than assumed:
 *
 * 1. **The section is the same shape as Memory and Storage** — one style and
 *    one script spliced into the head, one row in the sidebar's footer seat,
 *    one overlay panel — and it reaches the Project Model through the route the
 *    model already registers, not through one of its own.
 * 2. **Nothing internal reaches the screen.** The fixtures carry a project id,
 *    a session id, a memory namespace and a workspace id; none of them may
 *    appear anywhere in the rendered text.
 * 3. **A change is read before it is made.** The guard is consulted first, a
 *    refusal is shown as a refusal, and a removal never claims to delete.
 *
 * The shipped client is run for real against a fake DOM, exactly as the storage
 * console's is, so what runs is the code the page receives.
 *
 * @module newpi/tests/projects-console
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PROJECT_ENDPOINT } from '../plugins/project-model/index.js';
import { PROJECTS_ENDPOINT } from '../plugins/projects-console/index.js';
import {
  CAPABILITY_LABELS,
  CAPABILITY_ORDER,
  PROJECTS_ATTRIBUTE,
  installProjects,
  projectsScript,
  projectsStyle,
} from '../plugins/projects-console/ui.js';

// --------------------------------------------------------------- the harness

/** Resolve a path inside the harness's own module tree. */
function harnessPath(name) {
  const tree =
    process.env.DSH_PROFILE_MODULES ??
    `${process.env.HOME ?? ''}/.local/lib/node_modules/@deepseek-ai/dsh/node_modules`;
  return `${tree}/${name}`;
}

/**
 * The smallest DOM the section uses.
 *
 * `textContent` clears the children when it is set, as a real DOM does: the
 * client erases a view before it renders the next one, and a fake that kept the
 * old children would make every later assertion read a page that is no longer
 * there.
 *
 * @param options - the fake.
 * @param options.slots - the `data-slot` seats the document exposes.
 * @param options.fetch - the endpoint implementation.
 * @returns the document, the fetch spy and a flush helper.
 */
function fakeDocument({ slots = [], fetch: fetchImpl }) {
  function element(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: {},
      listeners: {},
      className: '',
      hidden: false,
      disabled: false,
      value: '',
      type: '',
      _text: '',
      classList: { add() {}, remove() {} },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return this.attributes[name] === undefined ? null : this.attributes[name];
      },
      removeChild(child) {
        const at = this.children.indexOf(child);
        if (at !== -1) this.children.splice(at, 1);
        return child;
      },
      addEventListener(name, handler) {
        this.listeners[name] = this.listeners[name] ?? [];
        this.listeners[name].push(handler);
      },
      click() {
        // A real browser never dispatches a click on a disabled control; the
        // fake must not either, or a test would prove a button that cannot work.
        if (this.disabled) return;
        for (const handler of this.listeners.click ?? []) handler({ target: this });
      },
      focus() {},
      querySelector(selector) {
        const slot = /\[data-slot="([^"]+)"\]/.exec(selector)?.[1];
        if (slot !== undefined) {
          if (this.attributes['data-slot'] === slot) return this;
          for (const child of this.children) {
            const found = child.querySelector(selector);
            if (found) return found;
          }
          return null;
        }
        const marker = /\[(data-newpi-projects-nav)[^\]]*\]/.exec(selector)?.[1];
        if (marker !== undefined) {
          if (this.attributes[marker] !== undefined) return this;
          for (const child of this.children) {
            const found = child.querySelector(selector);
            if (found) return found;
          }
        }
        return null;
      },
      /** Every descendant, depth first. */
      all() {
        return this.children.flatMap((child) => [child, ...child.all()]);
      },
    };
    Object.defineProperty(node, 'textContent', {
      get() {
        return node._text;
      },
      set(value) {
        node._text = String(value);
        node.children.length = 0;
      },
    });
    return node;
  }

  const body = element('body');
  for (const name of slots) {
    const seat = element('div');
    seat.setAttribute('data-slot', name);
    body.appendChild(seat);
  }
  const document = {
    documentElement: element('html'),
    body,
    createElement: element,
    createElementNS: (_namespace, tag) => element(tag),
    createTextNode: (text) => {
      const node = element('#text');
      node.textContent = String(text);
      return node;
    },
    querySelector: (selector) => body.querySelector(selector),
  };

  const calls = [];
  const fetchSpy = async (url, init) => {
    const payload = JSON.parse(init.body);
    calls.push({ url, ...payload });
    return { ok: true, status: 200, json: async () => fetchImpl(payload) };
  };
  fetchSpy.calls = calls;

  return {
    document,
    fetch: fetchSpy,
    async flush() {
      for (let round = 0; round < 16; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

/** Every string the fake DOM would show, the node itself included. */
function visibleText(root) {
  return [root, ...root.all()]
    .map((node) => node._text)
    .filter((text) => text !== '')
    .join('\n');
}

/** The button whose label is exactly `text`. */
function buttonWith(root, text) {
  return root
    .all()
    .find((node) => node.tagName === 'BUTTON' && node._text === text);
}

// --------------------------------------------------------------- the fixtures

const NOW = Date.UTC(2026, 8, 18, 14, 2);

/** The open project. Every identifier here must stay off the screen. */
const CURRENT = {
  id: 'twin-internal-id',
  name: 'Twin',
  rootPath: '/Users/demo/twin',
  detached: false,
  lastOpenedAt: NOW,
  lastSessionAt: NOW - 60_000,
  sessions: ['session-internal-id'],
  memoryNamespace: 'namespace-secret',
  workspaceId: 'workspace-internal-id',
  handoffState: { digest: 'digest-secret' },
  settings: {
    capabilities: {
      readWorkspace: true,
      writeWorkspace: true,
      terminal: true,
      git: false,
      network: false,
    },
  },
};

/** A recent project, on another root, with one session known. */
const OTHER = {
  id: 'other-internal-id',
  name: 'Autre projet',
  rootPath: '/Users/demo/autre',
  detached: true,
  lastOpenedAt: NOW - 86_400_000,
  lastSessionAt: null,
  sessions: [],
  memoryNamespace: 'other-namespace',
  settings: {
    capabilities: {
      readWorkspace: true,
      writeWorkspace: false,
      terminal: false,
      git: true,
      network: false,
    },
  },
};

const FACTS = {
  ready: true,
  endpoint: PROJECTS_ENDPOINT,
  launchRoot: '/Users/demo/twin',
  relaunch: true,
  // The one capability this build lets an interface change, straight from the
  // model; a test below proves an empty list renders no control at all.
  editableCapabilities: ['network'],
};

/**
 * Run the shipped client against a fake browser.
 *
 * @param options - the run.
 * @param options.respond - the endpoint's answers, by action.
 * @param options.slots - the seats the document exposes.
 * @returns the fake document, the spy, and the panel once it is built.
 */
async function runClient(options = {}) {
  const answers = options.respond ?? {};
  const fake = fakeDocument({
    slots: options.slots ?? ['sidebar.footer.action', 'sidebar.panellist'],
    fetch: (payload) => {
      const answer = answers[payload.action];
      if (typeof answer === 'function') return answer(payload);
      if (answer !== undefined) return { ok: true, value: answer };
      // A test that does not care about Git gets the calm "no repository"
      // answer, so the existing section tests are not coupled to the new zone.
      if (payload.action === 'project.git.status') return { ok: true, value: { repo: false, usable: false } };
      return { ok: false, error: { code: 'PROJECT_UNKNOWN_ACTION', message: 'Action inconnue.' } };
    },
  });

  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
    MutationObserver: globalThis.MutationObserver,
    ResizeObserver: globalThis.ResizeObserver,
  };
  globalThis.document = fake.document;
  globalThis.window = { addEventListener() {}, console };
  globalThis.fetch = fake.fetch;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
  };
  // The globals stay installed until the caller is done: the client is
  // asynchronous, and restoring them now would break its queued work.
  fake.restore = () => {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.fetch = previous.fetch;
    globalThis.MutationObserver = previous.MutationObserver;
    globalThis.ResizeObserver = previous.ResizeObserver;
  };

  try {
    new Function(projectsScript(options.facts ?? FACTS))();
  } catch (error) {
    fake.restore();
    throw error;
  }
  // The client installs its row synchronously when the seat exists.
  const footer = fake.document.querySelector('[data-slot="sidebar.footer.action"]');
  const row = footer.querySelector('[data-newpi-projects-nav]');
  return Object.assign(fake, { footer, row });
}

/** The overlay panel the client built, if any. */
function panelOf(fake) {
  return fake.document.body.children.find((node) => node.className === 'npr-root');
}

// ============================================================== the injection

test('the section is one style and one script spliced into the head', () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  const injected = installProjects(html, FACTS);
  assert.ok(injected.includes(`<style ${PROJECTS_ATTRIBUTE}>`));
  assert.ok(injected.includes(`<script ${PROJECTS_ATTRIBUTE}>`));
  assert.ok(injected.includes('"/Users/demo/twin"'), 'the host facts travel with the page');
  assert.ok(
    injected.indexOf(`<style ${PROJECTS_ATTRIBUTE}>`) < injected.indexOf('<title>'),
    'the section is spliced at the top of the head',
  );
  assert.equal(installProjects('<body></body>', FACTS).startsWith('<style'), true);
});

test('the shipped script is valid and carries no unresolved placeholder', () => {
  const script = projectsScript(FACTS);
  assert.doesNotThrow(() => new Function(script));
  for (const placeholder of [
    'FACTS_JSON',
    'SEAT_NAMES',
    'RAIL_PIXELS',
    'CAPABILITY_LABELS_JSON',
    'CAPABILITY_ORDER_JSON',
  ]) {
    assert.ok(!script.includes(placeholder), `${placeholder} was left unsubstituted`);
  }
  assert.ok(script.includes(PROJECTS_ENDPOINT));
  // The client never touches innerHTML: every value is written as text.
  assert.ok(!script.includes('innerHTML'));
});

test('the stylesheet is scoped to the section and spells every capability', () => {
  const css = projectsStyle();
  assert.ok(css.includes(`[${PROJECTS_ATTRIBUTE}]{`), 'the tokens hang off the marker attribute');
  assert.ok(css.includes('--dsw-alias-'), 'the panel follows the interface theme');
  for (const name of CAPABILITY_ORDER) {
    assert.ok(CAPABILITY_LABELS[name], `${name} needs a word a person reads`);
  }
  assert.deepEqual(Object.keys(CAPABILITY_LABELS).sort(), [...CAPABILITY_ORDER].sort());
});

test('the section calls the Project Model route and owns no route of its own', () => {
  assert.equal(PROJECTS_ENDPOINT, PROJECT_ENDPOINT);
});

// ================================================================= the service

/**
 * Mount the Projects plugin on a real Cordis context, with the webserver and
 * the Project Model faked.
 *
 * @param model - the Project Model the section reads.
 * @returns the service and the injections it made.
 */
async function bootProjects(model) {
  const { Context } = await import(harnessPath('@deepseek-ai/cordis/lib/index.js'));
  const ctx = new Context();
  const tapped = [];
  ctx.provide('webServer', {
    tapIndex(transform) {
      tapped.push(transform);
      return () => {};
    },
  });
  ctx.provide('projectModel', model);
  const { apply } = await import('../plugins/projects-console/index.js');
  apply(ctx, { announce: false });
  return { ctx, projects: ctx.get('projectsConsole'), tapped };
}

test('the service reads the two facts the page cannot compute', async () => {
  const { projects, tapped } = await bootProjects({
    currentProject: { name: 'Twin', rootPath: '/Users/demo/twin' },
    describe: () => ({ workspace: '/Users/demo/twin' }),
    canRelaunch: () => true,
  });
  assert.ok(projects, 'the plugin must register ctx.projectsConsole');
  const facts = projects.facts();
  assert.equal(facts.ready, true);
  assert.equal(facts.endpoint, PROJECTS_ENDPOINT);
  assert.equal(facts.launchRoot, '/Users/demo/twin');
  assert.equal(facts.relaunch, true);

  assert.equal(tapped.length, 1, 'the section is injected once');
  const html = tapped[0]('<html><head></head></html>');
  assert.ok(html.includes(`<script ${PROJECTS_ATTRIBUTE}>`));
  assert.ok(html.includes('"/Users/demo/twin"'));
});

test('a deployment where the model cannot answer says so instead of guessing', async () => {
  const broken = await bootProjects({
    describe: () => {
      throw new Error('non');
    },
    canRelaunch: () => {
      throw new Error('non');
    },
  });
  const facts = broken.projects.facts();
  assert.equal(facts.ready, true);
  assert.equal(facts.launchRoot, null);
  assert.equal(facts.relaunch, false);
});

// ================================================================= the client

test('the row lands in the footer seat and the panel reads the open project', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT, OTHER],
      'project.operations': [],
    },
  });
  try {
    assert.ok(fake.row, 'the Projects row must land in the footer seat');
    assert.equal(
      fake.document.querySelector('[data-slot="sidebar.panellist"]').children.length,
      0,
      'nothing may be injected into the panel list',
    );

    fake.row.click();
    await fake.flush();

    const panel = panelOf(fake);
    assert.ok(panel, 'opening the row must build the panel');
    assert.equal(panel.hidden, false);
    const shown = visibleText(panel);

    assert.ok(shown.includes('Twin'), 'the open project is named');
    assert.ok(shown.includes('/Users/demo/twin'), 'the open project folder is shown');
    assert.ok(shown.includes('Autre projet'), 'the recent project is listed');
    assert.ok(shown.includes('Dernière ouverture'), 'the last opening is dated');
    assert.ok(shown.includes('Dernière session connue'), 'the last known session is readable');
    assert.ok(shown.includes('aucune'), 'a project with no session says so');

    // The five capabilities, in words, each with its state.
    for (const name of CAPABILITY_ORDER) {
      assert.ok(shown.includes(CAPABILITY_LABELS[name]), `${name} must be readable`);
    }
    assert.ok(shown.includes('Git'));
    assert.ok(shown.includes('Réseau'));
    assert.ok(shown.includes('autorisé'));
    assert.ok(shown.includes('refusé'));

    // The two ends of the change a person can ask for.
    assert.ok(buttonWith(panel, 'Ouvrir un dossier de projet…'));
    assert.ok(buttonWith(panel, 'Changer de projet…'));
    assert.ok(buttonWith(panel, 'Retirer de la liste'));
  } finally {
    fake.restore();
  }
});

test('no internal identifier reaches the screen', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT, OTHER],
      'project.operations': [],
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const shown = visibleText(panelOf(fake));

    for (const secret of [
      CURRENT.id,
      OTHER.id,
      CURRENT.memoryNamespace,
      CURRENT.workspaceId,
      CURRENT.sessions[0],
      CURRENT.handoffState.digest,
      'memoryNamespace',
      'workspaceId',
      'handoff',
      'detached',
    ]) {
      assert.ok(!shown.includes(secret), `${secret} must never be shown`);
    }
    // And no raw document, either.
    assert.ok(!shown.includes('{'));
  } finally {
    fake.restore();
  }
});

test('a change names both projects, reads the guard first, and restarts', async () => {
  const opened = { ...OTHER, detached: true };
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT, OTHER],
      'project.operations': [],
      'project.open': opened,
      'project.restart': { restarting: true },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const panel = panelOf(fake);

    buttonWith(panel, 'Changer de projet…').click();
    await fake.flush();

    // The guard is consulted before the switch is even offered.
    assert.ok(
      fake.fetch.calls.some((call) => call.action === 'project.operations'),
      'the in-flight operations must be read first',
    );
    const confirmation = visibleText(panel);
    assert.ok(confirmation.includes('Projet actuel'));
    assert.ok(confirmation.includes('Projet cible'));
    assert.ok(confirmation.includes('Twin'));
    assert.ok(confirmation.includes('Autre projet'));
    assert.ok(confirmation.includes('redémarrage'), 'the restart is stated up front');

    buttonWith(panel, 'Changer de projet').click();
    await fake.flush();

    const openCall = fake.fetch.calls.find((call) => call.action === 'project.open');
    assert.ok(openCall, 'confirming must open the target');
    assert.deepEqual(openCall.params, { id: OTHER.id });

    const after = panelOf(fake);
    const shown = visibleText(after);
    assert.ok(shown.includes('Projet changé'));
    assert.ok(shown.includes('dernier projet'), 'the choice is recorded as the last project');
    assert.ok(buttonWith(after, 'Redémarrer NewPi'), 'a bundled launch offers the restart');
  } finally {
    fake.restore();
  }
});

test('an operation in flight blocks the change, and the refusal is readable', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT, OTHER],
      'project.operations': [{ kind: 'workflow', exclusive: true, active: true }],
      'project.open': () => ({ ok: false, error: { code: 'PROJECT_BUSY', message: 'occupé' } }),
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const panel = panelOf(fake);

    buttonWith(panel, 'Changer de projet…').click();
    await fake.flush();

    const shown = visibleText(panel);
    assert.ok(shown.includes('opération critique'), 'the reason is stated');
    assert.ok(shown.includes('workflow'), 'the kind of work in flight is named');
    assert.equal(buttonWith(panel, 'Changer de projet'), undefined, 'no switch is offered');
    assert.ok(buttonWith(panel, 'Vérifier à nouveau'));
    assert.ok(
      !fake.fetch.calls.some((call) => call.action === 'project.open'),
      'nothing may be opened while the guard refuses',
    );
  } finally {
    fake.restore();
  }
});

test('a model refusal after confirmation is shown as a refusal, not a failure', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT, OTHER],
      'project.operations': [],
      'project.open': () => ({ ok: false, error: { code: 'PROJECT_BUSY', message: 'occupé' } }),
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const panel = panelOf(fake);
    buttonWith(panel, 'Changer de projet…').click();
    await fake.flush();
    buttonWith(panel, 'Changer de projet').click();
    await fake.flush();

    const shown = visibleText(panel);
    assert.ok(shown.includes("Le projet n'a pas été changé"));
    assert.ok(shown.includes('opération est en cours'));
  } finally {
    fake.restore();
  }
});

test('removing a project asks first, then forgets, and never claims to delete', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT, OTHER],
      'project.operations': [],
      'project.forget': { forgotten: true },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const panel = panelOf(fake);
    assert.equal(
      fake.fetch.calls.filter((call) => call.action === 'project.forget').length,
      0,
      'nothing is removed before the confirmation',
    );

    buttonWith(panel, 'Retirer de la liste').click();
    await fake.flush();
    const confirmation = visibleText(panel);
    assert.ok(confirmation.includes('ne sont pas touchés'));
    assert.ok(confirmation.includes('/Users/demo/autre'));

    buttonWith(panel, 'Retirer de la liste').click();
    await fake.flush();
    const forget = fake.fetch.calls.find((call) => call.action === 'project.forget');
    assert.ok(forget, 'confirming must forget the record');
    assert.deepEqual(forget.params, { id: OTHER.id });

    // The panel never promises a deletion, and the footer says what a removal
    // does not touch.
    const footer = panel.all().find((node) => node.className === 'npr-foot');
    assert.ok(footer, 'the panel keeps its footer note');
    assert.ok(visibleText(footer).includes('ne supprime ni son dossier'));
  } finally {
    fake.restore();
  }
});

test('the open project cannot be removed from its own list', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const panel = panelOf(fake);
    assert.equal(buttonWith(panel, 'Retirer de la liste'), undefined);
    assert.ok(visibleText(panel).includes('Vous travaillez déjà dans ce projet.'));
  } finally {
    fake.restore();
  }
});

test('the folder button asks the host, and a cancelled panel is an answer', async () => {
  const cancelled = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT, OTHER],
      'project.operations': [],
      'project.chooseFolder': { cancelled: true },
    },
  });
  try {
    cancelled.row.click();
    await cancelled.flush();
    const panel = panelOf(cancelled);
    buttonWith(panel, 'Ouvrir un dossier de projet…').click();
    await cancelled.flush();

    assert.ok(
      cancelled.fetch.calls.some((call) => call.action === 'project.chooseFolder'),
      'the panel is asked on the host',
    );
    assert.ok(visibleText(panel).includes('Aucun dossier choisi'));
    assert.ok(
      !cancelled.fetch.calls.some((call) => call.action === 'project.create'),
      'a cancelled panel must create nothing',
    );
  } finally {
    cancelled.restore();
  }
});

test('a chosen folder is confirmed, created and opened', async () => {
  const chosen = {
    id: null,
    name: 'Nouveau',
    rootPath: '/Users/demo/nouveau',
    known: false,
  };
  const created = { ...chosen, id: 'nouveau-internal-id' };
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT, OTHER],
      'project.operations': [],
      'project.chooseFolder': chosen,
      'project.create': created,
      'project.open': { ...created, detached: true },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const panel = panelOf(fake);
    buttonWith(panel, 'Ouvrir un dossier de projet…').click();
    await fake.flush();

    const confirmation = visibleText(panel);
    assert.ok(confirmation.includes('/Users/demo/nouveau'), 'the target folder is named');
    assert.ok(confirmation.includes('ne fait pas encore partie'), 'a new folder is announced');
    assert.ok(
      !fake.fetch.calls.some((call) => call.action === 'project.create'),
      'nothing is created before the confirmation',
    );

    buttonWith(panel, 'Changer de projet').click();
    await fake.flush();
    const create = fake.fetch.calls.find((call) => call.action === 'project.create');
    assert.ok(create, 'confirming a new folder must create it');
    assert.equal(create.params.rootPath, '/Users/demo/nouveau');
    assert.equal(create.params.name, 'Nouveau');
    assert.ok(fake.fetch.calls.some((call) => call.action === 'project.open'));
    assert.ok(visibleText(panel).includes('Projet changé'));
  } finally {
    fake.restore();
  }
});

test('with no project open, the panel says so and offers the folder', async () => {
  const fake = await runClient({
    respond: {
      'project.current': null,
      'project.list': [],
      'project.operations': [],
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const panel = panelOf(fake);
    const shown = visibleText(panel);
    assert.ok(shown.includes("Aucun projet n'est ouvert."));
    assert.ok(shown.includes('Aucun projet récent.'));
    assert.ok(buttonWith(panel, 'Ouvrir un dossier de projet…'));
    assert.ok(panel.children.length > 0);
  } finally {
    fake.restore();
  }
});

test('an unreadable project list is reported instead of rendering an empty panel', async () => {
  const fake = await runClient({
    respond: {
      'project.current': () => ({ ok: false, error: { code: 'PROJECT_FAILED', message: 'modèle absent' } }),
      'project.list': [],
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const shown = visibleText(panelOf(fake));
    assert.ok(shown.includes('illisibles'));
    assert.ok(shown.includes('modèle absent'));
  } finally {
    fake.restore();
  }
});

// ================================================================ the Git zone

/** One descendant by exact class name. */
function classNode(root, name) {
  return root.all().find((node) => node.className === name) ?? null;
}

/** Every checkbox of the commit screen. */
function checkboxes(root) {
  return root.all().filter((node) => node.tagName === 'INPUT');
}

/** The open project card, which owns the Git zone. */
function openCard(panel) {
  return classNode(panel, 'npr-card');
}

const GIT_REMOTE = { name: 'origin', url: 'git@github.com:demo/twin.git' };

/** A repository with two changed files, two local commits and a divergence. */
const GIT_DIVERGED = {
  repo: true,
  usable: true,
  blocked: null,
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  remote: GIT_REMOTE,
  ahead: 2,
  behind: 1,
  fastForward: false,
  diverged: true,
  clean: false,
  dirty: true,
  conflicted: false,
  inProgress: null,
  files: [
    {
      path: 'src/a.js',
      kind: 'modified',
      staged: false,
      unstaged: true,
      added: 3,
      removed: 1,
      binary: false,
      originalPath: null,
    },
    {
      path: 'notes.txt',
      kind: 'untracked',
      staged: false,
      unstaged: false,
      added: null,
      removed: null,
      binary: false,
      originalPath: null,
    },
  ],
  counts: { files: 2, staged: 0, unstaged: 1, untracked: 1, conflicted: 0 },
  lastCommit: { shortId: 'abc1234', subject: 'initial', author: 'Ada', at: NOW },
  lastSync: { at: NOW, kind: 'fetch' },
  networkAllowed: true,
};

/** The same repository, clean and up to date. */
const GIT_CLEAN = {
  ...GIT_DIVERGED,
  ahead: 0,
  behind: 0,
  fastForward: false,
  diverged: false,
  clean: true,
  dirty: false,
  files: [],
  counts: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  lastSync: null,
};

/** Two commits waiting, no divergence. */
const GIT_AHEAD = { ...GIT_CLEAN, ahead: 2, behind: 0 };

/** Two commits on the remote, safe to fast-forward. */
const GIT_BEHIND = { ...GIT_CLEAN, behind: 2, fastForward: true };

test('the Git zone is inside the open project card and spells the state', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT, OTHER],
      'project.operations': [],
      'project.git.status': GIT_DIVERGED,
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const panel = panelOf(fake);
    const gitBox = classNode(panel, 'npr-git');
    assert.ok(gitBox, 'the Git zone must exist in the open project view');
    assert.ok(openCard(panel).all().includes(gitBox), 'the zone belongs to the open project card');

    const shown = visibleText(gitBox);
    assert.ok(shown.includes('Historique Git'));
    assert.ok(shown.includes('main'), 'the branch is named');
    assert.ok(shown.includes('origin'), 'the remote is named');
    assert.ok(shown.includes('Dernière synchronisation'));
    assert.ok(shown.includes('vérification'), 'the last sync is spelled in words');
    assert.ok(shown.includes('src/a.js'));
    assert.ok(shown.includes('modifié'));
    assert.ok(shown.includes('+3'));
    assert.ok(shown.includes('−1'));
    assert.ok(shown.includes('notes.txt'));
    assert.ok(shown.includes('nouveau'));
    assert.ok(buttonWith(gitBox, 'Enregistrer une étape'));
    assert.ok(buttonWith(gitBox, 'Envoyer sur GitHub'));
    assert.ok(buttonWith(gitBox, 'Récupérer les nouveautés'));
    assert.ok(buttonWith(gitBox, 'Voir le diff'));

    // A divergence is explained, and the write buttons stay out of reach.
    assert.match(shown, /divergé/);
    assert.equal(buttonWith(gitBox, 'Envoyer sur GitHub').disabled, true);
    assert.equal(buttonWith(gitBox, 'Enregistrer une étape').disabled, false);

    // No internal identifier of the model leaks through the new zone.
    for (const forbidden of ['memoryNamespace', 'workspaceId', 'handoff', '/api/newpi']) {
      assert.ok(!shown.includes(forbidden), `"${forbidden}" must not be on the page`);
    }
  } finally {
    fake.restore();
  }
});

test('a file diff opens on demand and closes again', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': GIT_DIVERGED,
      'project.git.diff': {
        path: 'src/a.js',
        area: 'work',
        text: '@@ -1 +1 @@\n-ancien\n+nouveau\n',
        truncated: false,
        binary: false,
      },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    const button = buttonWith(gitBox, 'Voir le diff');
    button.click();
    await fake.flush();
    const pre = classNode(gitBox, 'npr-diff');
    assert.ok(pre, 'the diff must be rendered');
    assert.match(pre.textContent, /\+nouveau/);

    const requested = fake.fetch.calls.find((call) => call.action === 'project.git.diff');
    assert.equal(requested.params.path, 'src/a.js');
    assert.equal(requested.params.area, 'work');

    button.click();
    await fake.flush();
    assert.equal(classNode(gitBox, 'npr-diff'), null, 'clicking again closes the diff');
  } finally {
    fake.restore();
  }
});

test('Enregistrer une étape commits only the selected files with the message', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': GIT_DIVERGED,
      'project.git.commit': {
        ok: true,
        commit: { shortId: 'def5678', subject: 'étape choisie', author: 'Ada', at: NOW },
        status: GIT_CLEAN,
      },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    buttonWith(gitBox, 'Enregistrer une étape').click();
    await fake.flush();

    const boxes = checkboxes(gitBox);
    assert.equal(boxes.length, 2, 'every changed file is offered');
    boxes[1].checked = false;
    const message = gitBox.all().find((node) => node.tagName === 'TEXTAREA');
    message.value = 'étape choisie';

    buttonWith(gitBox, 'Créer le commit local').click();
    await fake.flush();

    const commit = fake.fetch.calls.find((call) => call.action === 'project.git.commit');
    assert.ok(commit, 'the commit must reach the Project Model');
    assert.deepEqual(commit.params.paths, ['src/a.js']);
    assert.equal(commit.params.message, 'étape choisie');
    const shown = visibleText(gitBox);
    assert.match(shown, /Étape enregistrée/);
    assert.match(shown, /def5678/);
    assert.match(shown, /pas encore sur le distant/);
  } finally {
    fake.restore();
  }
});

test('an empty message or an empty selection never reaches the endpoint', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': GIT_DIVERGED,
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    buttonWith(gitBox, 'Enregistrer une étape').click();
    await fake.flush();

    const message = gitBox.all().find((node) => node.tagName === 'TEXTAREA');
    message.value = '   ';
    buttonWith(gitBox, 'Créer le commit local').click();
    await fake.flush();
    assert.match(visibleText(gitBox), /Écrivez un message/);

    message.value = 'un message';
    for (const box of checkboxes(gitBox)) box.checked = false;
    buttonWith(gitBox, 'Créer le commit local').click();
    await fake.flush();
    assert.match(visibleText(gitBox), /Choisissez au moins un fichier/);

    assert.equal(
      fake.fetch.calls.some((call) => call.action === 'project.git.commit'),
      false,
      'an invalid form must not create a commit',
    );
  } finally {
    fake.restore();
  }
});

test('Envoyer sur GitHub confirms first, then pushes, and is off when nothing waits', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': GIT_AHEAD,
      'project.git.push': {
        ok: true,
        pushed: true,
        remote: GIT_REMOTE,
        branch: 'main',
        status: GIT_CLEAN,
      },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    buttonWith(gitBox, 'Envoyer sur GitHub').click();
    await fake.flush();
    const confirmation = visibleText(gitBox);
    assert.match(confirmation, /2 commit\(s\) local\(aux\)/);
    assert.match(confirmation, /origin/);
    assert.match(confirmation, /forcé/);

    buttonWith(gitBox, 'Envoyer').click();
    await fake.flush();
    assert.ok(fake.fetch.calls.some((call) => call.action === 'project.git.push'));
    assert.match(visibleText(gitBox), /Envoi effectué/);
  } finally {
    fake.restore();
  }
});

test('the push button is disabled when the branch has nothing to send', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': { ...GIT_CLEAN, upstream: 'origin/main' },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    const push = buttonWith(gitBox, 'Envoyer sur GitHub');
    assert.equal(push.disabled, true);
    push.click();
    await fake.flush();
    assert.equal(
      fake.fetch.calls.some((call) => call.action === 'project.git.push'),
      false,
      'a disabled button must not push',
    );
  } finally {
    fake.restore();
  }
});

test('Récupérer les nouveautés offers an update only when it is a fast-forward', async () => {
  const pullStatus = { ...GIT_CLEAN, upstream: 'origin/main' };
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': pullStatus,
      'project.git.fetch': { ok: true, fetched: true, remote: GIT_REMOTE, status: GIT_BEHIND },
      'project.git.pull': { ok: true, updated: true, alreadyUpToDate: false, status: pullStatus },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    let gitBox = classNode(panelOf(fake), 'npr-git');
    buttonWith(gitBox, 'Récupérer les nouveautés').click();
    await fake.flush();
    assert.match(visibleText(gitBox), /avance rapide/);
    const update = buttonWith(gitBox, 'Mettre à jour (avance rapide)');
    assert.ok(update, 'a fast-forward update must be offered');

    update.click();
    await fake.flush();
    assert.ok(fake.fetch.calls.some((call) => call.action === 'project.git.pull'));
    assert.match(visibleText(gitBox), /Mise à jour effectuée/);
  } finally {
    fake.restore();
  }
});

test('a divergence after a fetch offers no update at all', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': GIT_CLEAN,
      'project.git.fetch': { ok: true, fetched: true, remote: GIT_REMOTE, status: GIT_DIVERGED },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    buttonWith(gitBox, 'Récupérer les nouveautés').click();
    await fake.flush();
    const shown = visibleText(gitBox);
    assert.match(shown, /ne fusionne pas/);
    assert.ok(!buttonWith(gitBox, 'Mettre à jour (avance rapide)'), 'no update may be offered on a divergence');
    assert.equal(
      fake.fetch.calls.some((call) => call.action === 'project.git.pull'),
      false,
      'no pull may run on a divergence',
    );
  } finally {
    fake.restore();
  }
});

test('a conflict or an unfinished operation disables the write actions and explains', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': { ...GIT_DIVERGED, conflicted: true, inProgress: 'merge' },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    const shown = visibleText(gitBox);
    assert.match(shown, /fusion est en cours/);
    assert.match(shown, /conflit/);
    for (const label of ['Enregistrer une étape', 'Envoyer sur GitHub', 'Récupérer les nouveautés']) {
      assert.equal(buttonWith(gitBox, label).disabled, true, `${label} must be off`);
    }
    // Clicking them anyway must not reach the endpoint.
    for (const label of ['Enregistrer une étape', 'Envoyer sur GitHub', 'Récupérer les nouveautés']) {
      buttonWith(gitBox, label).click();
    }
    await fake.flush();
    assert.equal(
      fake.fetch.calls.some((call) => /^project\.git\.(commit|push|fetch|pull)$/.test(call.action)),
      false,
      'no mutating Git action may run on a conflicted repository',
    );
  } finally {
    fake.restore();
  }
});

test('a missing GitHub credential is shown as a refusal, not a crash', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': GIT_AHEAD,
      'project.git.push': () => ({
        ok: false,
        error: {
          code: 'GIT_AUTH_REQUIRED',
          message: "Git n'a pas pu s'authentifier auprès du dépôt distant.",
        },
      }),
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    buttonWith(gitBox, 'Envoyer sur GitHub').click();
    await fake.flush();
    buttonWith(gitBox, 'Envoyer').click();
    await fake.flush();
    const shown = visibleText(gitBox);
    assert.match(shown, /authentifier/);
    assert.ok(buttonWith(gitBox, 'Enregistrer une étape'), 'the zone is still usable');
  } finally {
    fake.restore();
  }
});

test('a project without a repository gets an explanation and no Git action', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': { repo: false, usable: false, reason: 'not-a-repository' },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    const shown = visibleText(gitBox);
    assert.match(shown, /Historique Git/);
    assert.match(shown, /Aucun dépôt Git détecté/);
    for (const label of ['Enregistrer une étape', 'Envoyer sur GitHub', 'Récupérer les nouveautés']) {
      assert.equal(buttonWith(gitBox, label), undefined, `${label} must not be offered`);
    }
  } finally {
    fake.restore();
  }
});

test('the Git zone calls only the Project Model route', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': GIT_DIVERGED,
      'project.git.diff': { path: 'src/a.js', area: 'work', text: 'x', truncated: false, binary: false },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    buttonWith(gitBox, 'Voir le diff').click();
    await fake.flush();
    for (const call of fake.fetch.calls) {
      assert.equal(call.url, PROJECTS_ENDPOINT, 'the section owns no route of its own');
    }
    assert.ok(fake.fetch.calls.some((call) => call.action === 'project.git.status'));
    assert.ok(fake.fetch.calls.some((call) => call.action === 'project.git.diff'));
  } finally {
    fake.restore();
  }
});

test('a project that refuses Git says so without naming an internal id', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': () => ({
        ok: false,
        error: {
          code: 'PROJECT_CAPABILITY_DENIED',
          message: 'the project "twin-internal-id" does not grant git',
        },
      }),
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    const shown = visibleText(gitBox);
    assert.match(shown, /Git est refusé/);
    assert.ok(!shown.includes('twin-internal-id'), 'the project id must not reach the screen');
  } finally {
    fake.restore();
  }
});

test('with the project network refused, local work stays and the remote buttons are off', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': {
        ...GIT_DIVERGED,
        ahead: 2,
        behind: 0,
        diverged: false,
        fastForward: false,
        networkAllowed: false,
      },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const gitBox = classNode(panelOf(fake), 'npr-git');
    const shown = visibleText(gitBox);
    assert.match(shown, /réseau de ce projet doit être autorisé/, 'the zone says what to allow');
    assert.equal(
      buttonWith(gitBox, 'Enregistrer une étape').disabled,
      false,
      'the local half must stay available',
    );
    assert.equal(buttonWith(gitBox, 'Envoyer sur GitHub').disabled, true);
    assert.equal(buttonWith(gitBox, 'Récupérer les nouveautés').disabled, true);

    // Clicking a disabled control does nothing, so no remote action runs.
    buttonWith(gitBox, 'Envoyer sur GitHub').click();
    buttonWith(gitBox, 'Récupérer les nouveautés').click();
    await fake.flush();
    assert.equal(
      fake.fetch.calls.some((call) => /^project\.git\.(push|fetch|pull)$/.test(call.action)),
      false,
      'no remote action may run without the network capability',
    );
  } finally {
    fake.restore();
  }
});

// ============================================ the project's authorizations zone

test('the authorizations zone shows the state and offers only the editable capability', async () => {
  const fake = await runClient({
    respond: { 'project.current': CURRENT, 'project.list': [CURRENT], 'project.operations': [] },
  });
  try {
    fake.row.click();
    await fake.flush();
    const card = openCard(panelOf(fake));
    const zone = classNode(card, 'npr-auths');
    assert.ok(zone, 'the authorizations zone must be inside the open project card');

    const shown = visibleText(zone);
    assert.ok(shown.includes('Autorisations du projet'));
    for (const name of CAPABILITY_ORDER) {
      assert.ok(shown.includes(CAPABILITY_LABELS[name]), `${name} must be readable`);
    }
    assert.ok(shown.includes('Réseau'), 'the capability the lot is about is named');
    assert.ok(shown.includes('refusé'), 'the default state is shown as refused');
    assert.ok(shown.includes('services externes'), 'the explanation says what a grant opens');
    assert.ok(shown.includes('GitHub'), 'the explanation names the concrete use');
    assert.ok(shown.includes('travail Git local reste disponible'));

    // Exactly one control: the capability the server opened. The other four
    // stay consult only.
    assert.ok(buttonWith(zone, 'Autoriser le réseau…'), 'the refused state offers the grant');
    assert.equal(
      zone.all().filter((node) => node.tagName === 'BUTTON').length,
      1,
      'only the editable capability may carry a control',
    );
  } finally {
    fake.restore();
  }
});

test('the page renders no capability control when the server opens none', async () => {
  const fake = await runClient({
    facts: { ...FACTS, editableCapabilities: [] },
    respond: { 'project.current': CURRENT, 'project.list': [CURRENT], 'project.operations': [] },
  });
  try {
    fake.row.click();
    await fake.flush();
    const zone = classNode(openCard(panelOf(fake)), 'npr-auths');
    assert.ok(zone, 'the capabilities are still shown');
    assert.equal(visibleText(zone).includes('Autoriser'), false);
    assert.equal(
      zone.all().filter((node) => node.tagName === 'BUTTON').length,
      0,
      'a capability the server did not open must not be offered',
    );
  } finally {
    fake.restore();
  }
});

test('cancelling the network confirmation changes nothing', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.git.status': { ...GIT_DIVERGED, diverged: false, behind: 0, networkAllowed: false },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const zone = classNode(openCard(panelOf(fake)), 'npr-auths');
    buttonWith(zone, 'Autoriser le réseau…').click();
    await fake.flush();

    const confirmation = visibleText(panelOf(fake));
    assert.ok(confirmation.includes('Twin'), 'the confirmation names the project');
    assert.ok(confirmation.includes('/Users/demo/twin'), 'and its folder');
    assert.ok(confirmation.includes('GitHub'), 'and the concrete consequence');
    assert.ok(confirmation.includes("n'est pas interrompue"), 'and the in-flight promise');

    buttonWith(panelOf(fake), 'Annuler').click();
    await fake.flush();
    assert.equal(
      fake.fetch.calls.some((call) => call.action === 'project.capability.set'),
      false,
      'cancelling must not ask the model for anything',
    );
    const back = classNode(openCard(panelOf(fake)), 'npr-auths');
    assert.ok(buttonWith(back, 'Autoriser le réseau…'), 'the state is unchanged');

    // Closing the confirmation instead of cancelling it is the same answer:
    // the panel goes away and the model is never called.
    buttonWith(back, 'Autoriser le réseau…').click();
    await fake.flush();
    buttonWith(panelOf(fake), 'Fermer').click();
    await fake.flush();
    assert.equal(
      fake.fetch.calls.some((call) => call.action === 'project.capability.set'),
      false,
      'closing the confirmation must not ask the model for anything either',
    );
  } finally {
    fake.restore();
  }
});

test('allowing the network persists it and the Git zone reloads immediately', async () => {
  let network = false;
  const withNetwork = (project) => ({
    ...project,
    settings: { ...project.settings, capabilities: { ...project.settings.capabilities, network } },
  });
  const fake = await runClient({
    respond: {
      'project.current': () => ({ ok: true, value: withNetwork(CURRENT) }),
      'project.list': () => ({ ok: true, value: [withNetwork(CURRENT)] }),
      'project.operations': [],
      'project.git.status': () => ({
        ok: true,
        value: { ...GIT_DIVERGED, diverged: false, behind: 0, networkAllowed: network },
      }),
      'project.capability.set': (payload) => {
        assert.deepEqual(payload.params, { name: 'network', allowed: true, confirm: true });
        network = true;
        return { ok: true, value: withNetwork(CURRENT) };
      },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const before = classNode(openCard(panelOf(fake)), 'npr-git');
    assert.equal(buttonWith(before, 'Envoyer sur GitHub').disabled, true, 'off while refused');
    assert.equal(buttonWith(before, 'Récupérer les nouveautés').disabled, true);

    buttonWith(classNode(openCard(panelOf(fake)), 'npr-auths'), 'Autoriser le réseau…').click();
    await fake.flush();
    buttonWith(panelOf(fake), 'Autoriser le réseau').click();
    await fake.flush();

    assert.equal(network, true, 'the model must have been asked, and only through the action');
    const card = openCard(panelOf(fake));
    const zone = classNode(card, 'npr-auths');
    assert.ok(visibleText(zone).includes('autorisé'), 'the zone shows the new state');
    assert.ok(buttonWith(zone, "Retirer l'autorisation"), 'and now offers the removal');
    assert.equal(buttonWith(zone, 'Autoriser le réseau…'), undefined);

    const gitBox = classNode(card, 'npr-git');
    assert.equal(
      buttonWith(gitBox, 'Envoyer sur GitHub').disabled,
      false,
      'the remote buttons follow the capability',
    );
    assert.equal(buttonWith(gitBox, 'Récupérer les nouveautés').disabled, false);
    assert.ok(
      fake.fetch.calls.filter((call) => call.action === 'project.git.status').length >= 2,
      'the Git zone must be re-read after the change',
    );
    assert.ok(
      visibleText(panelOf(fake)).includes('Réseau autorisé'),
      'the change is reported back to the person',
    );
  } finally {
    fake.restore();
  }
});

test('removing the authorization persists it and turns the remote buttons off again', async () => {
  let network = true;
  const withNetwork = (project) => ({
    ...project,
    settings: { ...project.settings, capabilities: { ...project.settings.capabilities, network } },
  });
  const fake = await runClient({
    respond: {
      'project.current': () => ({ ok: true, value: withNetwork(CURRENT) }),
      'project.list': () => ({ ok: true, value: [withNetwork(CURRENT)] }),
      'project.operations': [],
      'project.git.status': () => ({
        ok: true,
        value: { ...GIT_DIVERGED, diverged: false, behind: 0, networkAllowed: network },
      }),
      'project.capability.set': (payload) => {
        assert.deepEqual(payload.params, { name: 'network', allowed: false, confirm: true });
        network = false;
        return { ok: true, value: withNetwork(CURRENT) };
      },
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    const card = openCard(panelOf(fake));
    assert.ok(buttonWith(classNode(card, 'npr-auths'), "Retirer l'autorisation"));
    assert.equal(buttonWith(classNode(card, 'npr-git'), 'Envoyer sur GitHub').disabled, false);

    buttonWith(classNode(card, 'npr-auths'), "Retirer l'autorisation").click();
    await fake.flush();
    const confirmation = visibleText(panelOf(fake));
    assert.ok(confirmation.includes('seront refusés à partir de maintenant'));
    buttonWith(panelOf(fake), "Retirer l'autorisation").click();
    await fake.flush();

    assert.equal(network, false);
    const after = openCard(panelOf(fake));
    assert.ok(visibleText(classNode(after, 'npr-auths')).includes('refusé'));
    assert.equal(buttonWith(classNode(after, 'npr-git'), 'Envoyer sur GitHub').disabled, true);
    assert.equal(buttonWith(classNode(after, 'npr-git'), 'Récupérer les nouveautés').disabled, true);
  } finally {
    fake.restore();
  }
});

test('a capability change refused by the guard is shown as a refusal, not a failure', async () => {
  const fake = await runClient({
    respond: {
      'project.current': CURRENT,
      'project.list': [CURRENT],
      'project.operations': [],
      'project.capability.set': () => ({
        ok: false,
        error: { code: 'PROJECT_BUSY', message: 'occupé' },
      }),
    },
  });
  try {
    fake.row.click();
    await fake.flush();
    buttonWith(classNode(openCard(panelOf(fake)), 'npr-auths'), 'Autoriser le réseau…').click();
    await fake.flush();
    buttonWith(panelOf(fake), 'Autoriser le réseau').click();
    await fake.flush();

    const shown = visibleText(panelOf(fake));
    assert.ok(shown.includes("n'a pas été changée"), 'the refusal is stated');
    assert.ok(shown.includes('opération est en cours'), 'and explained');
    assert.ok(shown.includes("Rien n'a été modifié"));
  } finally {
    fake.restore();
  }
});
