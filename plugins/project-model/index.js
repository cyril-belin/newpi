/**
 * The Project Model service: the one object that names the current project, and
 * the seams every later feature reads it through.
 *
 * # What it is
 *
 * A NewPi plugin — a Cordis overlay, not a second shell. It reuses the
 * abstractions the harness already has and adds the project facts DSH has no
 * place for:
 *
 * - **the current project** (`ctx.projectModel.currentProject`), unique by
 *   construction: one `currentId` in the registry, and every reader asks the
 *   service rather than tracking its own;
 * - **the registry** (`store.js`): the recent projects, and each project's
 *   settings, sessions, memory namespace, handoff state and UI state, in one
 *   small JSON document NewPi already has a state directory for;
 * - **the two guardrails** (`model.js`): an operation guard that refuses a
 *   project change while something is in flight, and a handful of capability
 *   booleans that a future editor or terminal consults.
 *
 * # What it deliberately does not do
 *
 * It does **not** invent a workspace. DSH's `ctx.workspaceRegistry` remains the
 * durable record of what a directory is; a project is that workspace plus its
 * own metadata, and {@link ProjectModelService#_ensureWorkspace} creates the
 * workspace record rather than replacing it. It also does not run a second
 * memory store: `memoryNamespace` is the same `project_id` the memory backend
 * was configured with, so a project names one namespace and the backend stores
 * under it.
 *
 * # The seams it uses
 *
 * | Seam | What it yields |
 * | ---- | -------------- |
 * | `ctx.workspaceRegistry` (optional) | the durable workspace a project is built on |
 * | `ctx.sessions` (optional) | the live sessions whose `cwd` belongs to the project |
 * | `ctx.contextCache` (optional) | the project binding, and the handoff a compaction committed |
 * | `ctx.connection` (optional) | the authenticated endpoint the interface reads the model through |
 *
 * Every seam is optional on purpose: a deployment without a workspace registry
 * still gets a project, and the service never makes the boot depend on a
 * feature it merely observes.
 *
 * # Scope of a project change
 *
 * The harness is launched with one working directory, so a project opened at
 * runtime is the project the *model* works in; the process itself keeps the
 * directory it was started in. A project whose `rootPath` is not the launch
 * workspace is reported as `detached`, which is the honest word for it. A
 * relaunch is what changes the harness's own directory, and multi-root is
 * deliberately out of scope for V1.
 *
 * @module newpi-plugin-project-model
 */

import { realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

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
  markOpened,
  resolveInside,
  sessionBelongsToProject,
  updateCapability,
  updateGitState,
  updateHandoffState,
  updateProject,
  updateUiState,
} from './model.js';
import { ProjectGit } from './git.js';
import {
  chooseFolder as platformChooseFolder,
  requestRelaunch,
} from './platform.js';
import {
  ProjectStore,
  forgetProject,
  promoteRecent,
  setCurrentProject,
  upsertProject,
} from './store.js';

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'project-model';

/**
 * The service needs no service to mount.
 *
 * This is the same choice the context & cache manager documents: a deployment
 * without a workspace registry or a session store still has a project, and
 * "the feature is absent" must stay distinguishable from "NewPi failed to
 * launch". Every optional seam is reached with `ctx.get` or bound through
 * `ctx.inject`, so none of them is a boot dependency.
 */
export const inject = [];

/** The one endpoint the interface calls. A test asserts the two agree. */
export const PROJECT_ENDPOINT = '/api/newpi.project';

/**
 * The plugin's configuration: the facts NewPi resolved before the harness
 * started, and nothing the browser can name.
 */
export const Config = z.object({
  /** NewPi's application state directory. */
  stateDir: z.string(),
  /** The workspace root the harness was launched in. */
  workspace: z.string(),
  /** The project scope NewPi resolved from the workspace, used to bind the id. */
  projectId: z.string(),
  /** The display name NewPi resolved, normally the workspace's directory name. */
  name: z.string(),
  /** The memory namespace; defaults to the project id when NewPi names none. */
  memoryNamespace: z.string(),
  /** An explicit registry path, overriding `<stateDir>/projects.json`. */
  registryFile: z.string(),
  /** NewPi's bundle identifier, used to ask the host for a clean relaunch. */
  appId: z.string(),
  /** NewPi's own `.app` directory, empty when it is not running from one. */
  appBundle: z.string(),
  /** Log the mounted project once at load. Defaults to true. */
  announce: z.boolean(),
});

/**
 * Assert that a request's parameters are the ones the action declares.
 *
 * The same fence the memory and storage consoles use, for the same reason:
 * there is no code path from a browser-supplied key to a project fact, because
 * a key the action does not name is refused before the action runs.
 *
 * @param params - the request's parameters.
 * @param allowed - the keys this action declares.
 * @returns the parameters.
 * @throws {ProjectError} when a key is undeclared or the shape is wrong.
 */
export function assertParams(params, allowed) {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new ProjectError('PROJECT_INVALID_ARGS', 'params must be an object');
  }
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      throw new ProjectError(
        'PROJECT_INVALID_ARGS',
        `unknown parameter ${JSON.stringify(key)}; this section cannot set it from the browser`,
      );
    }
  }
  return params;
}

/**
 * Assert that a project may reach the network, for a Git action that leaves the
 * machine.
 *
 * `git` alone covers the local work (detecting the repository, reading the
 * status, showing a diff, committing). Touching the configured remote is a
 * second grant, and the refusal gets its own code so the interface can explain
 * "the project's network must be allowed" instead of a generic capability
 * error.
 *
 * @param project - the project to read.
 * @returns the capability name.
 * @throws {ProjectError} `GIT_NETWORK_DENIED` (403) when network is not granted.
 */
export function assertNetworkCapability(project) {
  if (project?.settings?.capabilities?.network === true) return 'network';
  throw new ProjectError(
    'GIT_NETWORK_DENIED',
    "Le réseau de ce projet n'est pas autorisé : l'envoi et la récupération demandent la capacité « Réseau ».",
    403,
  );
}

/**
 * The Project Model service, reachable as `ctx.projectModel`.
 *
 * The underscore-prefixed members are the same documentation device the model
 * router uses: Cordis resolves a service through a tracing shadow, and
 * JavaScript private members are not reachable through it. Nothing outside this
 * file may use them.
 */
export class ProjectModelService extends Service {
  /** The registry, once loaded. */
  registry = null;
  /** The last load warning, if any. */
  warning = null;
  /** The guard that keeps a project from moving under an operation. */
  guard = new OperationGuard();
  /** The change listeners an interface may register. */
  listeners = new Set();
  /** The endpoint route's disposer, when one was registered. */
  _endpointDisposer = null;
  /** The launcher-resolved workspace root. */
  _workspace;
  /** The project id NewPi resolved for this launch. */
  _configuredId;
  /** The display name NewPi resolved. */
  _configuredName;
  /** The memory namespace NewPi resolved. */
  _configuredNamespace;
  /** NewPi's bundle identifier, or `''`. */
  _appId;
  /** NewPi's `*.app` directory, or `null` when it is not a bundle. */
  _appBundle;
  /** The native folder chooser; injectable so a test never opens a panel. */
  _picker;
  /** The relaunch request; injectable so a test never quits anything. */
  _relaunch;
  /** The Git seam; injectable so a test can prove the argv without a repository. */
  _git;
  /** The promise that settles once the project is open. */
  _ready = null;

  /**
   * @param ctx - the owning Cordis context.
   * @param options - the resolved configuration.
   */
  constructor(ctx, options = {}) {
    super(ctx, 'projectModel');
    this._workspace = resolvePath(options.workspace ?? '');
    this._configuredId = typeof options.projectId === 'string' ? options.projectId.trim() : '';
    this._configuredName = typeof options.name === 'string' ? options.name.trim() : '';
    this._configuredNamespace =
      typeof options.memoryNamespace === 'string' ? options.memoryNamespace.trim() : '';
    this._appId = typeof options.appId === 'string' ? options.appId.trim() : '';
    this._appBundle =
      typeof options.appBundle === 'string' && options.appBundle !== '' ? options.appBundle : null;
    this._picker = typeof options.picker === 'function' ? options.picker : platformChooseFolder;
    this._relaunch = typeof options.relaunch === 'function' ? options.relaunch : requestRelaunch;
    this._git = new ProjectGit({ run: typeof options.gitRun === 'function' ? options.gitRun : undefined });
    this.store = new ProjectStore({
      stateDir: options.stateDir,
      file: typeof options.registryFile === 'string' && options.registryFile !== '' ? options.registryFile : undefined,
    });
  }

  /** Settle once the initial project is open. */
  ready() {
    return this._ready ?? Promise.resolve();
  }

  // ------------------------------------------------------------- the model

  /**
   * The current project, or `null` when none is open.
   *
   * A derived, frozen snapshot: the persisted record plus whether the project
   * is `detached` from the harness's own working directory.
   *
   * @returns the snapshot, or `null`.
   */
  get currentProject() {
    const project = this._current();
    return project === null ? null : this._snapshot(project);
  }

  /**
   * Look one project up by id.
   *
   * @param id - the project id.
   * @returns the snapshot, or `undefined`.
   */
  get(id) {
    const project = this.registry?.projects?.[id];
    return project === undefined ? undefined : this._snapshot(project);
  }

  /**
   * The recent projects, most recently opened first.
   *
   * @param limit - how many to return.
   * @returns the snapshots.
   */
  recent(limit = 20) {
    const state = this.registry;
    if (state === null) return [];
    const count = Number.isInteger(limit) && limit >= 0 ? limit : state.recent.length;
    return state.recent
      .slice(0, count)
      .map((id) => state.projects[id])
      .filter((project) => project !== undefined)
      .map((project) => this._snapshot(project));
  }

  /** Alias for {@link ProjectModelService#recent}, in the plural. */
  projects(limit) {
    return this.recent(limit);
  }

  /**
   * Create a project for an existing directory. Idempotent for the same
   * canonical path: the existing record is returned without a second row.
   *
   * @param input - the project's identity.
   * @param input.rootPath - an existing directory.
   * @param input.name - an optional display name.
   * @param input.settings - optional settings; capabilities are validated.
   * @param input.memoryNamespace - an optional namespace; defaults to the id.
   * @returns the created (or existing) project.
   * @throws {ProjectError} when the directory does not exist or is not one.
   */
  async create(input = {}) {
    await this._ensureRegistry();
    const rootPath = await this._canonicalDirectory(input.rootPath);
    const existing = this._byRoot(rootPath);
    if (existing !== null) return this._snapshot(existing);

    const taken = new Set(Object.keys(this.registry.projects));
    const id =
      input.id !== undefined && input.id !== null
        ? assertProjectId(input.id)
        : deriveProjectId(rootPath, { taken });
    if (this.registry.projects[id] !== undefined) {
      throw new ProjectError('PROJECT_DUPLICATE_ID', `project ${JSON.stringify(id)} already exists`, 409);
    }

    const project = createProject({
      id,
      name: input.name !== undefined ? input.name : id,
      rootPath,
      settings: input.settings,
      memoryNamespace: input.memoryNamespace,
    });
    upsertProject(this.registry, project);
    await this._commit();
    this._emit('created', project);
    return this._snapshot(project);
  }

  /**
   * Open a project: create it when the target names an unknown directory, make
   * it current, bind the workspace and the Context & Cache Manager, and adopt
   * the live sessions that belong to it.
   *
   * @param target - a project id, `{id}`, `{rootPath}`, or `{name, rootPath}`.
   * @param options - the open.
   * @param options.force - replace the current project even while an operation
   *   is in flight. Never a default.
   * @returns the current project's snapshot.
   * @throws {ProjectError} when an operation is in flight, or the id is unknown.
   */
  async open(target, options = {}) {
    await this._ensureRegistry();
    this.guard.assertCanSwitch(options.force === true);

    const project = await this._resolveTarget(target);
    promoteRecent(this.registry, project.id);
    setCurrentProject(this.registry, project.id);
    const opened = markOpened(project);
    upsertProject(this.registry, opened);

    await this._bind(opened, options);
    await this._commit();
    this._emit('opened', opened);
    return this._snapshot(opened);
  }

  /**
   * Close the current project, or one named by id.
   *
   * Closing keeps the record in the registry: the project stays recent, with
   * its sessions and UI state, so reopening it is one call.
   *
   * @param options - the close.
   * @param options.id - the project to close; the current one when omitted.
   * @param options.force - close even while an operation is in flight.
   * @returns whether a project was closed.
   * @throws {ProjectError} when an operation is in flight.
   */
  async close(options = {}) {
    await this._ensureRegistry();
    this.guard.assertCanSwitch(options.force === true);
    const project =
      options.id !== undefined && options.id !== null
        ? this.registry.projects[options.id]
        : this._current();
    if (project === undefined || project === null) return false;
    if (this.registry.currentId === project.id) {
      setCurrentProject(this.registry, null);
      this._unbindContextCache();
    }
    await this._commit();
    this._emit('closed', project);
    return true;
  }

  /**
   * Forget a project record. The directory and the session logs are untouched.
   *
   * @param id - the project to forget.
   * @returns whether a record was removed.
   * @throws {ProjectError} while an operation is in flight.
   */
  async forget(id) {
    await this._ensureRegistry();
    this.guard.assertCanSwitch(false);
    if (this.registry.projects[id] === undefined) return false;
    const wasCurrent = this.registry.currentId === id;
    forgetProject(this.registry, id);
    if (wasCurrent) this._unbindContextCache();
    await this._commit();
    this._emit('forgotten', id);
    return true;
  }

  // -------------------------------------------------------------- the host

  /**
   * Whether NewPi can relaunch itself on the host.
   *
   * A launch that is not inside an `.app` bundle — `pnpm dev`, a bare binary —
   * has nothing for the system to open again, so the interface offers a manual
   * restart there instead of pretending a button will work.
   *
   * @returns whether a clean relaunch can be requested.
   */
  canRelaunch() {
    return this._appId !== '' && this._appBundle !== null;
  }

  /**
   * Ask the host for a directory, through the native folder panel.
   *
   * The panel runs on the host, in `osascript`; the page never names a path and
   * never receives a filesystem capability. The chosen directory is
   * canonicalized here, by the same rule every other root goes through, so the
   * interface can show a target it knows the model accepts.
   *
   * @returns `{cancelled: true}`, or the canonical root with its readable name.
   * @throws {ProjectError} when the chosen path is not a usable directory.
   */
  async pickFolder() {
    await this._ensureRegistry();
    const current = this._current();
    const directory = current?.rootPath ?? (this._workspace !== '' ? this._workspace : undefined);
    const picked = await this._picker({
      prompt: 'Choisissez un dossier de projet',
      directory,
    });
    if (picked === null || picked === undefined) return { cancelled: true };
    const rootPath = await this._canonicalDirectory(picked);
    const known = this._byRoot(rootPath);
    return {
      cancelled: false,
      rootPath,
      name: known !== null ? known.name : basename(rootPath),
      known: known !== null,
    };
  }

  /**
   * Ask NewPi to quit and start again, so the harness's own working directory
   * becomes the project that was just chosen.
   *
   * The request is handed to a detached host helper and answers immediately:
   * the runtime this call runs in is about to be stopped, and a response that
   * waited for the restart could never be written.
   *
   * @returns `{restarting: true}`.
   * @throws {ProjectError} when NewPi is not running from a bundle.
   */
  async restart() {
    // A relaunch is a project change by another name, so it waits for an
    // in-flight operation exactly as `open` and `close` do.
    this.guard.assertCanSwitch(false);
    if (!this.canRelaunch()) {
      throw new ProjectError(
        'PROJECT_RESTART_UNAVAILABLE',
        "NewPi n'est pas lancé depuis une application : quittez NewPi puis rouvrez le, le dernier projet choisi sera repris.",
        409,
      );
    }
    await this._relaunch({ appId: this._appId, bundle: this._appBundle });
    return { restarting: true };
  }

  // ---------------------------------------------------------- the sessions

  /**
   * Associate one DSH session with a project.
   *
   * The project's own list is authoritative, and the DSH workspace registry is
   * told too — best effort, because a session whose header names another
   * directory is the workspace registry's to refuse, and its refusal must not
   * fail the association.
   *
   * @param sessionId - the session to associate.
   * @param options - the association.
   * @param options.projectId - the project; the current one when omitted.
   * @returns the updated project, or `null` when no project applies.
   * @throws {ProjectError} when the session id is empty.
   */
  async attachSession(sessionId, options = {}) {
    await this._ensureRegistry();
    const project = this._projectFor(options.projectId);
    if (project === null) return null;
    const updated = associateSession(project, sessionId);
    upsertProject(this.registry, updated);
    await this._commit();
    await this._mirrorSession(updated, sessionId);
    this._emit('session', updated);
    return this._snapshot(updated);
  }

  /**
   * Remove one session from a project. Idempotent.
   *
   * @param sessionId - the session to remove.
   * @param options - the removal.
   * @param options.projectId - the project; the current one when omitted.
   * @returns the updated project, or `null` when no project applies.
   */
  async detachSession(sessionId, options = {}) {
    await this._ensureRegistry();
    const project = this._projectFor(options.projectId);
    if (project === null) return null;
    const updated = disassociateSession(project, sessionId);
    upsertProject(this.registry, updated);
    await this._commit();
    this._emit('session', updated);
    return this._snapshot(updated);
  }

  /**
   * The sessions associated with the current project.
   *
   * @param projectId - the project; the current one when omitted.
   * @returns the session ids, most recent first.
   */
  sessions(projectId) {
    const project = this._projectFor(projectId);
    return project === null ? [] : [...project.sessions];
  }

  /**
   * Adopt every live session whose header's `cwd` is inside a project.
   *
   * @param project - the project to adopt into.
   * @returns the number of sessions adopted.
   */
  async adoptLiveSessions(project) {
    const sessions = this._sessions();
    if (sessions === undefined) return 0;
    const adopted = [];
    let updated = project;
    for (const session of sessions.list()) {
      const id = session?.id;
      if (typeof id !== 'string' || updated.sessions.includes(id)) continue;
      if (!sessionBelongsToProject(updated, session.header?.cwd)) continue;
      updated = associateSession(updated, id);
      adopted.push(id);
    }
    if (adopted.length > 0) {
      upsertProject(this.registry, updated);
      await this._commit();
      // Mirror to the DSH workspace registry too: it validates a session
      // against its own canonical path, and the project is the one that decided
      // the session belongs here.
      for (const id of adopted) await this._mirrorSession(updated, id);
    }
    return adopted.length;
  }

  // ------------------------------------------------------------- the state

  /**
   * The current project's UI state.
   *
   * @param projectId - the project; the current one when omitted.
   * @returns the UI state, or `null`.
   */
  uiState(projectId) {
    const project = this._projectFor(projectId);
    return project === null ? null : project.uiState;
  }

  /**
   * Merge a patch into the current project's UI state.
   *
   * @param patch - `{lastSessionId?, lastTab?, recentFiles?}`.
   * @param options - the update.
   * @param options.projectId - the project; the current one when omitted.
   * @returns the updated UI state, or `null`.
   */
  async setUiState(patch = {}, options = {}) {
    await this._ensureRegistry();
    const project = this._projectFor(options.projectId);
    if (project === null) return null;
    const updated = updateUiState(project, patch);
    upsertProject(this.registry, updated);
    await this._commit();
    this._emit('ui', updated);
    return updated.uiState;
  }

  /**
   * The current project's handoff state.
   *
   * @param projectId - the project; the current one when omitted.
   * @returns the handoff record, or `null`.
   */
  handoffState(projectId) {
    const project = this._projectFor(projectId);
    return project === null ? null : project.handoffState;
  }

  /**
   * Replace the current project's handoff state.
   *
   * @param handoff - the handoff facts, or `null`.
   * @param options - the update.
   * @param options.projectId - the project; the current one when omitted.
   * @returns the updated handoff, or `null`.
   */
  async setHandoff(handoff, options = {}) {
    await this._ensureRegistry();
    const project = this._projectFor(options.projectId);
    if (project === null) return null;
    const updated = updateHandoffState(project, handoff);
    upsertProject(this.registry, updated);
    await this._commit();
    this._emit('handoff', updated);
    return updated.handoffState;
  }

  // ---------------------------------------------------------- the repository

  /**
   * Run one Git action against the current project, under the operation guard.
   *
   * The gate is the same one every project action passes: a project must be
   * open, it must grant the `git` capability, and the whole action holds the
   * guard so a change of project, a relaunch or a removal is refused while it
   * runs. A **remote** action additionally requires `network`: reading the
   * working copy is local, but `fetch`, `push` and the fast-forward update
   * leave the machine, and the capability that names that reach is the one that
   * has to be granted. Git is only ever run against `project.rootPath` — the
   * fence that proves it is the repository root lives in the Git seam itself.
   *
   * @param label - a short, human-readable label for the operation guard.
   * @param body - the action, given the Git seam and the current project.
   * @param options - the action's reach.
   * @param options.remote - whether the action talks to the configured remote.
   * @returns whatever the body returns.
   * @throws {ProjectError} when no project is open, or a required capability is
   *   not granted.
   */
  async _runGit(label, body, options = {}) {
    await this._ensureRegistry();
    const project = this._current();
    if (project === null) {
      throw new ProjectError('PROJECT_NONE_OPEN', 'no project is open', 409);
    }
    assertCapability(project, 'git');
    if (options.remote === true) assertNetworkCapability(project);
    return this.runOperation({ kind: 'git', label }, () => body(this._git, project));
  }

  /** The last synchronisation NewPi recorded, merged into a Git snapshot. */
  _withGitSync(status, project) {
    return Object.freeze({
      ...status,
      lastSync: project.gitState ?? null,
      // Whether the remote half of the zone is allowed for this project. The
      // page renders the two remote buttons from this single fact rather than
      // deducing it from a capability it must not re-derive.
      networkAllowed: project.settings.capabilities.network === true,
    });
  }

  /** Persist the synchronisation NewPi just performed. */
  async _recordGitSync(kind) {
    const project = this._current();
    if (project === null) return null;
    const updated = updateGitState(project, { at: Date.now(), kind });
    upsertProject(this.registry, updated);
    await this._commit();
    this._emit('git', updated);
    return updated;
  }

  /**
   * The state of the open project's repository.
   *
   * @returns the frozen snapshot; `repo: false` when there is none.
   */
  async gitStatus() {
    return this._runGit('lecture de l\'état Git', async (git, project) =>
      this._withGitSync(await git.status(project.rootPath), project),
    );
  }

  /**
   * The diff of one selected file.
   *
   * @param path - the file, inside the project root.
   * @param area - `work` for the working tree, `index` for the staged version.
   * @returns the frozen diff.
   */
  async gitDiff(path, area) {
    return this._runGit('lecture d\'un diff Git', (git, project) =>
      git.diff(project.rootPath, { path, area }),
    );
  }

  /**
   * Create a local commit from the files the user selected.
   *
   * @param input - the commit.
   * @param input.message - the commit message.
   * @param input.paths - the selected files.
   * @returns `{ok, commit, status}`.
   */
  async gitCommit(input = {}) {
    return this._runGit('commit Git', async (git, project) => {
      const result = await git.commit(project.rootPath, input);
      return { ...result, status: this._withGitSync(result.status, project) };
    });
  }

  /**
   * Ask the configured remote what it has.
   *
   * @returns `{ok, fetched, remote, status}`.
   */
  async gitFetch() {
    return this._runGit(
      'récupération Git',
      async (git, project) => {
        const result = await git.fetch(project.rootPath);
        const updated = await this._recordGitSync('fetch');
        return { ...result, status: this._withGitSync(result.status, updated ?? project) };
      },
      { remote: true },
    );
  }

  /**
   * Push the local commits of the current branch.
   *
   * @returns `{ok, pushed, remote, branch, status}`.
   */
  async gitPush() {
    return this._runGit(
      'envoi Git',
      async (git, project) => {
        const result = await git.push(project.rootPath);
        const updated = await this._recordGitSync('push');
        return { ...result, status: this._withGitSync(result.status, updated ?? project) };
      },
      { remote: true },
    );
  }

  /**
   * Update the local branch from its upstream, by fast-forward only.
   *
   * @returns `{ok, updated, alreadyUpToDate, status}`.
   */
  async gitPull() {
    return this._runGit(
      'mise à jour Git',
      async (git, project) => {
        const result = await git.pull(project.rootPath);
        const updated = result.updated ? await this._recordGitSync('pull') : null;
        return { ...result, status: this._withGitSync(result.status, updated ?? project) };
      },
      { remote: true },
    );
  }

  // -------------------------------------------------------- the guardrails

  /**
   * The current project's capability set.
   *
   * @param projectId - the project; the current one when omitted.
   * @returns the frozen capabilities.
   */
  capabilities(projectId) {
    const project = this._projectFor(projectId);
    return project === null ? Object.freeze({ ...DEFAULT_CAPABILITIES }) : project.settings.capabilities;
  }

  /**
   * The capabilities this build lets an interface change.
   *
   * The list is a fact about the server, not about the caller: an interface
   * renders one control per name here, and the same list is what
   * {@link ProjectModelService#setCapability} enforces. V1 answers `['network']`.
   *
   * @returns a frozen list of capability names.
   */
  modifiableCapabilities() {
    return Object.freeze([...MODIFIABLE_CAPABILITIES]);
  }

  /**
   * Grant or revoke one capability on the project that is currently open.
   *
   * The target is never named by the caller: it is always the current project,
   * so no path, no id and no other project's state can be reached from an
   * interface. The capability is checked against the server's own
   * {@link MODIFIABLE_CAPABILITIES} before anything else, the new state must be
   * a boolean, and the confirmation must be exactly `true`: the model refuses a
   * grant that was not explicitly confirmed, so the page cannot write one by
   * forgetting to ask. The operation guard then refuses the change while
   * something is running, so a capability can never move under work that is
   * already in flight.
   *
   * The write is the point of the call and the only write: a refusal throws
   * before {@link updateCapability}, so a rejected request leaves the registry
   * byte for byte as it was.
   *
   * @param name - the capability to change.
   * @param allowed - its new state.
   * @param confirm - the caller's explicit confirmation; must be `true`.
   * @returns the updated current project's snapshot.
   * @throws {ProjectError} when no project is open (409), the capability is not
   *   modifiable (403), the value is not a boolean (400), the confirmation is
   *   missing or not `true` (400), or an operation is in flight (409).
   */
  async setCapability(name, allowed, confirm) {
    await this._ensureRegistry();
    const project = this._current();
    if (project === null) {
      throw new ProjectError('PROJECT_NONE_OPEN', "aucun projet n'est ouvert", 409);
    }
    // Read-only capability, bad value, missing confirmation and busy project
    // are four different refusals; each is raised before the record below is
    // touched.
    assertModifiableCapability(name);
    if (typeof allowed !== 'boolean') {
      throw new ProjectError('PROJECT_INVALID_ARGS', 'allowed doit être un booléen');
    }
    if (confirm !== true) {
      throw new ProjectError(
        'PROJECT_INVALID_ARGS',
        'changer une capacité exige une confirmation explicite (confirm: true)',
      );
    }
    this.guard.assertCanSwitch(false);

    const updated = updateCapability(project, name, allowed);
    upsertProject(this.registry, updated);
    await this._commit();
    this._emit('capability', updated);
    return this._snapshot(updated);
  }

  /**
   * Assert that the current project grants one capability.
   *
   * @param capability - one of `readWorkspace`, `writeWorkspace`, `terminal`, `git`, `network`.
   * @param projectId - the project; the current one when omitted.
   * @returns the capability name.
   * @throws {ProjectError} when the project does not grant it.
   */
  assertCapability(capability, projectId) {
    const project = this._projectFor(projectId);
    if (project === null) {
      throw new ProjectError('PROJECT_NONE_OPEN', 'no project is open', 409);
    }
    return assertCapability(project, capability);
  }

  /**
   * Run one body while asserting a capability first.
   *
   * This is the shape a future editor or terminal uses: the check and the work
   * are one call, so the gate cannot be forgotten between them.
   *
   * @param capability - the capability required.
   * @param body - the work to run once the capability is granted.
   * @param projectId - the project; the current one when omitted.
   * @returns whatever the body returns.
   */
  async withCapability(capability, body, projectId) {
    this.assertCapability(capability, projectId);
    return body();
  }

  /**
   * Resolve a path the caller names against the current project's root.
   *
   * @param target - an absolute path inside the root, or a path relative to it.
   * @param projectId - the project; the current one when omitted.
   * @returns the absolute path.
   * @throws {ProjectError} when there is no project, or the path escapes it.
   */
  resolve(target, projectId) {
    const project = this._projectFor(projectId);
    if (project === null) {
      throw new ProjectError('PROJECT_NONE_OPEN', 'no project is open', 409);
    }
    return resolveInside(project.rootPath, target);
  }

  /**
   * Register an in-flight operation against the current project.
   *
   * The returned handle must be released. While it is held, opening or closing
   * a project is refused, which is what stops a long write from landing in the
   * project the user just switched to.
   *
   * @param options - the operation's identity.
   * @param options.kind - `editor`, `terminal`, `workflow`, ...
   * @param options.exclusive - whether the operation is exclusive.
   * @param options.label - a diagnostic label.
   * @returns the operation handle.
   */
  beginOperation(options = {}) {
    const project = this._current();
    return this.guard.begin({
      kind: typeof options.kind === 'string' && options.kind !== '' ? options.kind : 'operation',
      exclusive: options.exclusive !== false,
      label: options.label ?? null,
      projectId: project?.id ?? null,
    });
  }

  /**
   * Run one operation under the guard, releasing it however the body settles.
   *
   * @param options - the operation's identity.
   * @param body - the work to run.
   * @returns whatever the body returns.
   */
  async runOperation(options, body) {
    return this.guard.run(
      {
        kind: typeof options?.kind === 'string' && options.kind !== '' ? options.kind : 'operation',
        exclusive: options?.exclusive !== false,
        label: options?.label ?? null,
        projectId: this._current()?.id ?? null,
      },
      body,
    );
  }

  /** The in-flight operations, as plain summaries. */
  operations() {
    return this.guard.list();
  }

  // ------------------------------------------------------------- the seams

  /**
   * What the Context & Cache Manager reports for the current project.
   *
   * @returns a frozen summary; `available: false` when no manager is mounted.
   */
  context() {
    const project = this._current();
    const cache = this._contextCache();
    if (cache === undefined || project === null) {
      return Object.freeze({
        available: false,
        reason: project === null ? 'no project is open' : 'no context & cache manager is mounted',
        projectId: project?.id ?? null,
      });
    }
    const sessionId = typeof project.uiState.lastSessionId === 'string' ? project.uiState.lastSessionId : undefined;
    return Object.freeze({
      available: true,
      projectId: project.id,
      namespace: project.memoryNamespace,
      binding: cache.project?.() ?? null,
      versions: sessionId === undefined ? null : cache.versions?.(sessionId) ?? null,
      stats: cache.cacheStats?.({ projectId: project.id }) ?? null,
      handoff: project.handoffState,
    });
  }

  /**
   * A snapshot of the whole model for an interface.
   *
   * @returns the frozen description.
   */
  describe() {
    return Object.freeze({
      current: this.currentProject,
      recent: Object.freeze(this.recent()),
      operations: Object.freeze(this.operations()),
      capabilities: Object.freeze([...CAPABILITIES]),
      modifiableCapabilities: this.modifiableCapabilities(),
      workspace: this._workspace,
      relaunch: this.canRelaunch(),
      warning: this.warning,
    });
  }

  /**
   * Subscribe to project changes.
   *
   * @param listener - called with `(reason, payload)`.
   * @returns a disposer that unregisters the listener.
   */
  onChange(listener) {
    if (typeof listener !== 'function') {
      throw new ProjectError('PROJECT_INVALID_LISTENER', 'a change listener must be a function');
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Load the registry, open the launched project, and subscribe to the seams.
   *
   * @returns this service.
   */
  async start() {
    await this._ensureRegistry();
    const project = await this._ensureLaunchProject();
    // No project is a real state, not a failure: the launcher said so by
    // carrying an empty scope, and the model stays empty until the interface
    // opens one. Binding or committing here would invent the very record the
    // empty scope exists to prevent.
    if (project !== null) {
      await this._bind(project, { allowMissing: true });
      await this._commit();
    }
    this._subscribe();
    this._emit('ready', project);
    return this;
  }

  // ------------------------------------------------------------- internals

  /** Load the registry once. */
  async _ensureRegistry() {
    if (this.registry !== null) return this.registry;
    this.registry = await this.store.load();
    if (this.store.warning !== null) {
      this.warning = this.store.warning;
      this._warn(this.store.warning);
    }
    return this.registry;
  }

  /**
   * The project the current launch names, created when the registry has none.
   *
   * The launch's workspace is authoritative: a stored project carrying the
   * configured id but another root is the same *scope* on a moved directory,
   * so its root is updated rather than a second project created.
   */
  async _ensureLaunchProject() {
    // An empty launcher scope is NewPi's explicit "no project" state. Falling
    // back to `process.cwd()` here used to recreate a personal-folder project
    // after the Rust host had deliberately left the scope empty.
    if (
      this._configuredId === '' &&
      this._configuredName === '' &&
      this._configuredNamespace === ''
    ) {
      return null
    }
    const rootPath = await this._canonicalRoot(this._workspace !== '' ? this._workspace : process.cwd());
    const id = this._configuredId !== '' ? this._configuredId : deriveProjectId(rootPath);
    const existing = this.registry.projects[id];
    if (existing !== undefined) {
      const moved = existing.rootPath !== rootPath;
      const project = moved ? updateProject(existing, { rootPath }) : existing;
      const named = this._configuredName !== '' && existing.name !== this._configuredName
        ? updateProject(project, { name: this._configuredName })
        : project;
      const namespaced =
        this._configuredNamespace !== '' && named.memoryNamespace !== this._configuredNamespace
          ? updateProject(named, { memoryNamespace: this._configuredNamespace })
          : named;
      upsertProject(this.registry, namespaced);
      promoteRecent(this.registry, id);
      setCurrentProject(this.registry, id);
      return namespaced;
    }

    const project = createProject({
      id,
      name: this._configuredName !== '' ? this._configuredName : id,
      rootPath,
      memoryNamespace: this._configuredNamespace !== '' ? this._configuredNamespace : id,
    });
    upsertProject(this.registry, project);
    promoteRecent(this.registry, id);
    setCurrentProject(this.registry, id);
    return project;
  }

  /**
   * Bind every optional seam to a project that just became current, then adopt
   * its live sessions.
   */
  async _bind(project, options = {}) {
    await this._ensureWorkspace(project, options);
    this._bindContextCache(project);
    await this.adoptLiveSessions(this.registry.projects[project.id] ?? project);
  }

  /** The project a call names, defaulting to the current one. */
  _projectFor(projectId) {
    const state = this.registry;
    if (state === null) return null;
    if (projectId !== undefined && projectId !== null) return state.projects[projectId] ?? null;
    return this._current();
  }

  /** The current project record, or `null`. */
  _current() {
    const state = this.registry;
    if (state === null || state.currentId === null) return null;
    return state.projects[state.currentId] ?? null;
  }

  /** The persisted project with the fields derived from this launch. */
  _snapshot(project) {
    return Object.freeze({
      ...project,
      detached: project.rootPath !== this._workspace,
    });
  }

  /** The known project rooted exactly at `rootPath`, if any. */
  _byRoot(rootPath) {
    for (const project of Object.values(this.registry.projects)) {
      if (project.rootPath === rootPath) return project;
    }
    return null;
  }

  /** Resolve an `open` target into a project record, creating it when needed. */
  async _resolveTarget(target) {
    if (typeof target === 'string') return this._requireProject(target);
    if (target !== null && typeof target === 'object' && typeof target.id === 'string') {
      return this._requireProject(target.id);
    }
    const rootPath = target?.rootPath;
    if (typeof rootPath !== 'string' || rootPath === '') {
      throw new ProjectError('PROJECT_INVALID_TARGET', 'open needs a project id or a rootPath');
    }
    const canonical = await this._canonicalDirectory(rootPath);
    const existing = this._byRoot(canonical);
    if (existing !== null) return existing;
    const taken = new Set(Object.keys(this.registry.projects));
    const project = createProject({
      id: deriveProjectId(canonical, { taken }),
      name: target.name !== undefined ? target.name : deriveProjectId(canonical),
      rootPath: canonical,
    });
    upsertProject(this.registry, project);
    return project;
  }

  /** One known project by id, or a 404. */
  _requireProject(id) {
    const project = this.registry.projects[id];
    if (project === undefined) {
      throw new ProjectError('PROJECT_UNKNOWN', `unknown project ${JSON.stringify(id)}`, 404);
    }
    return project;
  }

  /** Canonicalize a directory that must exist. */
  async _canonicalDirectory(candidate) {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new ProjectError('PROJECT_INVALID_PATH', 'a project needs an existing directory');
    }
    let canonical;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      throw new ProjectError(
        'PROJECT_NOT_A_DIRECTORY',
        `${JSON.stringify(candidate)} is not an existing directory (${error?.code ?? error})`,
        404,
      );
    }
    const info = await stat(canonical);
    if (!info.isDirectory()) {
      throw new ProjectError('PROJECT_NOT_A_DIRECTORY', `${JSON.stringify(canonical)} is not a directory`, 404);
    }
    return canonical;
  }

  /**
   * The canonical spelling of the launch workspace, best effort.
   *
   * The launch workspace comes from an environment variable or the home
   * directory and is not necessarily the `realpath` spelling the workspace
   * registry would return; canonicalizing here is what keeps one directory from
   * becoming two projects. A workspace that does not exist yet is still a
   * project: the resolved spelling is the honest answer when there is no link
   * to follow.
   */
  async _canonicalRoot(candidate) {
    const resolved = resolve(candidate);
    try {
      const canonical = await realpath(resolved);
      const info = await stat(canonical);
      return info.isDirectory() ? canonical : resolved;
    } catch {
      return resolved;
    }
  }

  /** Create or find the DSH workspace record a project is built on. */
  async _ensureWorkspace(project, options = {}) {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined || typeof registry.create !== 'function') return null;
    try {
      if (typeof project.workspaceId === 'string' && project.workspaceId !== '') {
        const known = registry.get?.(project.workspaceId);
        if (known !== undefined) {
          await this._mirrorWorkspaceSessions(known, project);
          return known;
        }
      }
      const workspace = await registry.create(project.rootPath, project.name);
      const updated = updateProject(project, { workspaceId: String(workspace.id) });
      upsertProject(this.registry, updated);
      await this._mirrorWorkspaceSessions(workspace, updated);
      return workspace;
    } catch (error) {
      if (options.allowMissing !== true) {
        this._warn(`could not register the workspace: ${this._scrub(error)}`);
      }
      return null;
    }
  }

  /** Add every session the project holds to its DSH workspace record. */
  async _mirrorWorkspaceSessions(workspace, project) {
    if (typeof workspace?.attachSession !== 'function') return;
    for (const sessionId of project.sessions) {
      try {
        await workspace.attachSession(sessionId);
      } catch {
        // The workspace validates the session's header against its own path;
        // a refusal is its answer and is not this project's to override.
      }
    }
  }

  /** Tell the DSH workspace registry about one association, best effort. */
  async _mirrorSession(project, sessionId) {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) return;
    try {
      const workspace =
        typeof project.workspaceId === 'string' && project.workspaceId !== ''
          ? registry.get?.(project.workspaceId)
          : await registry.resolveByPath?.(project.rootPath);
      await workspace?.attachSession?.(sessionId);
    } catch (error) {
      this._warn(`the workspace registry did not accept the session: ${this._scrub(error)}`);
    }
  }

  /** Bind the Context & Cache Manager to a project. */
  _bindContextCache(project) {
    const cache = this._contextCache();
    if (cache === undefined || typeof cache.bindProject !== 'function') return;
    try {
      cache.bindProject({ id: project.id, namespace: project.memoryNamespace });
    } catch (error) {
      this._warn(`could not bind the context & cache manager: ${this._scrub(error)}`);
    }
  }

  /** Release the Context & Cache Manager's project binding. */
  _unbindContextCache() {
    const cache = this._contextCache();
    if (cache === undefined || typeof cache.unbindProject !== 'function') return;
    try {
      cache.unbindProject();
    } catch (error) {
      this._warn(`could not release the context & cache manager: ${this._scrub(error)}`);
    }
  }

  /** The context & cache manager, when one is mounted. */
  _contextCache() {
    return this.ctx.get('contextCache');
  }

  /** The live session store, when one is mounted. */
  _sessions() {
    return this.ctx.get('sessions');
  }

  /** Persist the registry. */
  _commit() {
    return this.store.save(this.registry);
  }

  /** Notify the change listeners, containing their failures. */
  _emit(reason, payload) {
    for (const listener of this.listeners) {
      try {
        listener(reason, payload, this.currentProject);
      } catch (error) {
        this._warn(`a change listener failed: ${this._scrub(error)}`);
      }
    }
  }

  /**
   * Subscribe to the seams the project observes.
   *
   * Every subscription is observational: it records an association or a
   * handoff, and never changes what the harness does.
   */
  _subscribe() {
    this.ctx.on('session/created', (session) => {
      try {
        const project = this._current();
        if (project === null) return;
        if (!sessionBelongsToProject(project, session?.header?.cwd)) return;
        void this.attachSession(session.id).catch((error) => {
          this._warn(`could not associate a new session: ${this._scrub(error)}`);
        });
      } catch (error) {
        this._warn(`could not observe a session: ${this._scrub(error)}`);
      }
    });

    this.ctx.on('session/event', (session, event) => {
      try {
        if (event?.type !== 'compaction/end') return;
        const project = this._current();
        if (project === null || !project.sessions.includes(session?.id)) return;
        const versions = this._contextCache()?.versions?.(session.id) ?? null;
        const handoff = handoffFromVersions(versions, session.id);
        if (handoff === null) return;
        void this.setHandoff(handoff).catch((error) => {
          this._warn(`could not record a handoff: ${this._scrub(error)}`);
        });
      } catch (error) {
        this._warn(`could not observe a compaction: ${this._scrub(error)}`);
      }
    });
  }

  /**
   * Answer one HTTP request, from the authenticated `/api/newpi.project` route.
   *
   * @param request - the request, already authenticated by the connection.
   * @returns the response, always `{ok, value}` or `{ok, error}`.
   */
  async handle(request) {
    let payload = null;
    try {
      payload = await request.json();
    } catch {
      payload = null;
    }
    if (payload === null || typeof payload !== 'object' || typeof payload.action !== 'string') {
      return Response.json(
        { ok: false, error: { code: 'PROJECT_BAD_REQUEST', message: 'Corps de requête illisible.' } },
        { status: 400 },
      );
    }
    try {
      const value = await this.dispatch(payload.action, payload.params);
      return Response.json({ ok: true, value });
    } catch (error) {
      const code = error?.code ?? 'PROJECT_FAILED';
      const status = error instanceof ProjectError ? error.status : 500;
      this._warn(`${payload.action} failed (${code}): ${error?.message ?? error}`);
      return Response.json(
        { ok: false, error: { code, message: String(error?.message ?? error) } },
        { status },
      );
    }
  }

  /**
   * Run one endpoint action by name.
   *
   * The browser can read the model, open a known project by id, create one for
   * an existing directory, close it, forget a registry record, read the
   * in-flight operations, ask the host for a directory, ask NewPi to restart,
   * set the small UI state, read or act on the open project's repository
   * (status, diff, local commit, fetch, push, fast-forward update), and change
   * **one** capability of the open project: `network`. It cannot set any other
   * capability, a memory namespace, a handoff, or another project's state:
   * those keys are not declared, so the parameter fence refuses them before any
   * action runs, and the capability action names no project at all. No Git
   * action declares a force, a refspec or a remote: the arguments are a message
   * and a file list, and nothing else.
   *
   * @param action - the action the browser asked for.
   * @param params - its parameters.
   * @returns the action's value.
   * @throws {ProjectError} when the action does not exist.
   */
  async dispatch(action, params) {
    switch (action) {
      case 'project.current':
        assertParams(params, []);
        return this.currentProject;
      case 'project.list':
        assertParams(params, []);
        return this.recent();
      case 'project.open': {
        const { id } = assertParams(params, ['id']);
        if (typeof id !== 'string') throw new ProjectError('PROJECT_INVALID_ARGS', 'id must be a string');
        return this.open(id);
      }
      case 'project.create': {
        const { name, rootPath } = assertParams(params, ['name', 'rootPath']);
        if (typeof rootPath !== 'string') {
          throw new ProjectError('PROJECT_INVALID_ARGS', 'rootPath must be a string');
        }
        return this.create({ name, rootPath });
      }
      case 'project.close':
        assertParams(params, []);
        return { closed: await this.close() };
      case 'project.forget': {
        const { id } = assertParams(params, ['id']);
        if (typeof id !== 'string') {
          throw new ProjectError('PROJECT_INVALID_ARGS', 'id must be a string');
        }
        return { forgotten: await this.forget(id) };
      }
      case 'project.operations':
        assertParams(params, []);
        return this.operations();
      case 'project.sessions':
        assertParams(params, []);
        return this.sessions();
      case 'project.capabilities':
        assertParams(params, []);
        return this.capabilities();
      case 'project.capability.set': {
        // No id, no rootPath, no projectId: the action is about the project
        // that is open, and `allowed` is a boolean rather than a patch, so
        // nothing but one on/off switch can travel through it. The capability
        // name is validated against the server's own list inside the service,
        // and so is the confirmation: `confirm: true` is required, not merely
        // sent by the page, so a grant can never happen without an explicit
        // decision.
        const { name, allowed, confirm } = assertParams(params, ['name', 'allowed', 'confirm']);
        if (typeof name !== 'string') {
          throw new ProjectError('PROJECT_INVALID_ARGS', 'name must be a string');
        }
        if (typeof allowed !== 'boolean') {
          throw new ProjectError('PROJECT_INVALID_ARGS', 'allowed must be a boolean');
        }
        return this.setCapability(name, allowed, confirm);
      }
      case 'project.uiState':
        assertParams(params, []);
        return this.uiState();
      case 'project.uiState.set': {
        const patch = assertParams(params, ['lastSessionId', 'lastTab', 'recentFiles']);
        return this.setUiState(patch);
      }
      case 'project.chooseFolder':
        assertParams(params, []);
        return this.pickFolder();
      case 'project.git.status':
        assertParams(params, []);
        return this.gitStatus();
      case 'project.git.diff': {
        const { path, area } = assertParams(params, ['path', 'area']);
        if (typeof path !== 'string' || path === '') {
          throw new ProjectError('PROJECT_INVALID_ARGS', 'path must be a non-empty string');
        }
        if (area !== undefined && area !== 'work' && area !== 'index') {
          throw new ProjectError('PROJECT_INVALID_ARGS', "area must be 'work' or 'index'");
        }
        return this.gitDiff(path, area);
      }
      case 'project.git.commit': {
        const { message, paths } = assertParams(params, ['message', 'paths']);
        if (!Array.isArray(paths) || paths.some((entry) => typeof entry !== 'string')) {
          throw new ProjectError('PROJECT_INVALID_ARGS', 'paths must be an array of strings');
        }
        return this.gitCommit({ message, paths });
      }
      case 'project.git.fetch':
        assertParams(params, []);
        return this.gitFetch();
      case 'project.git.push':
        assertParams(params, []);
        return this.gitPush();
      case 'project.git.pull':
        assertParams(params, []);
        return this.gitPull();
      case 'project.restart': {
        const { confirm } = assertParams(params, ['confirm']);
        if (confirm !== true) {
          throw new ProjectError('PROJECT_INVALID_ARGS', 'restarting NewPi requires confirm: true');
        }
        return this.restart();
      }
      default:
        throw new ProjectError('PROJECT_UNKNOWN_ACTION', `Action inconnue : ${JSON.stringify(action)}`, 404);
    }
  }

  /** Scrub one diagnostic before it is logged. */
  _scrub(error) {
    return String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300);
  }

  /** Log a project warning, if the context has a logger. */
  _warn(message) {
    this.ctx.logger?.warn?.(`${name}: ${message}`);
  }
}

/** Resolve a possibly empty path, keeping `''` as `''`. */
function resolvePath(value) {
  if (typeof value !== 'string' || value === '') return '';
  return resolve(value);
}

/**
 * Mount the project model: register the service, then wire the endpoint the
 * interface uses once the authenticated connection is available.
 *
 * The endpoint is registered through `ctx.inject`, never declared in `inject`:
 * a deployment without a connection still gets the service, and the two are
 * independent on purpose.
 *
 * @param ctx - the owning Cordis context.
 * @param config - the plugin row's configuration, every field optional.
 */
export function apply(ctx, config = {}) {
  const model = new ProjectModelService(ctx, config);
  model._ready = model.start().catch((error) => {
    model._warn(`could not open the launched project: ${model._scrub(error)}`);
  });

  const wireEndpoint = (scoped) => {
    if (model._endpointDisposer !== null) return;
    const connection = scoped.get?.('connection') ?? scoped.connection;
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return;
    model._endpointDisposer = connection.fetch.register({
      path: PROJECT_ENDPOINT,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => model.handle(request),
    });
  };

  // Wire immediately when the connection is already mounted, and through
  // `ctx.inject` for the order in which it is not: the endpoint is never a
  // declared dependency, so a deployment with no connection still gets the
  // service.
  if (ctx.get('connection') !== undefined) wireEndpoint(ctx);
  ctx.inject(['connection'], wireEndpoint);

  if (config.announce !== false) {
    void model.ready().then(() => {
      const current = model.currentProject;
      ctx.logger?.info?.(
        `${name}: projet=${current?.id ?? '(aucun)'} racine=${current?.rootPath ?? '(inconnue)'} ` +
          `récents=${model.recent().length}${current?.detached ? ' (détaché)' : ''}`,
      );
    });
  }
}

export { CAPABILITIES, DEFAULT_CAPABILITIES, MODIFIABLE_CAPABILITIES, ProjectError, OperationGuard };
export { PlatformError } from './platform.js';
export { REGISTRY_FILENAME } from './store.js';
