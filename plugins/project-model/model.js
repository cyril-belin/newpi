/**
 * The Project Model: what a project is, what it may do, and which operation may
 * change it.
 *
 * This module is deliberately free of I/O and of Cordis. Everything here is a
 * total function over plain values, so the rules the workspace, the sessions,
 * the memory namespace and the Context & Cache Manager are keyed by can be
 * read and tested without starting a harness, a sidecar, or a file.
 *
 * # Why a project exists at all
 *
 * The harness already owns a workspace: `ctx.workspaceRegistry` keeps one
 * durable record per existing directory, and DSH sessions are attached to it by
 * their canonical `cwd`. NewPi does **not** add a second notion of workspace —
 * a project *is* that workspace, enriched with the things the harness has no
 * place for:
 *
 * - a display `name` and a stable `id` (the id is also the memory scope);
 * - `settings`, chiefly the capability set;
 * - the associated sessions, so the project names its own history;
 * - `memoryNamespace` and `handoffState`, so memory and compaction continuity
 *   belong to the project rather than to whatever session happens to be open;
 * - a small `uiState`, so the interface reopens where the user left it.
 *
 * # The two guardrails
 *
 * 1. {@link OperationGuard}: while an operation is in flight (an editor save, a
 *    terminal command, a workflow), opening or closing a project is refused.
 *    The failure mode this prevents is the silent one: a long write that lands
 *    in the project the user just switched to.
 * 2. {@link DEFAULT_CAPABILITIES} and {@link assertCapability}: a project
 *    declares whether reading, writing, running a terminal, using git and
 *    reaching the network are allowed. This is a handful of booleans, not an
 *    RBAC system, and it is the seam a future editor or terminal consults
 *    before acting.
 *
 * @module newpi-plugin-project-model/model
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The persisted shape's version. A future format bumps it and migrates here. */
export const PROJECT_VERSION = 1;

/** The capability names a project declares. Named, never ordered. */
export const CAPABILITIES = Object.freeze([
  'readWorkspace',
  'writeWorkspace',
  'terminal',
  'git',
  'network',
]);

/**
 * What a project may do when its settings say nothing.
 *
 * The three filesystem and process capabilities are on because NewPi is a
 * local coding tool and a project that could not read its own directory would
 * be useless. `network` is off because the safe default for a project is the
 * one that adds no reach.
 */
export const DEFAULT_CAPABILITIES = Object.freeze({
  readWorkspace: true,
  writeWorkspace: true,
  terminal: true,
  git: true,
  network: false,
});

/** How many recent projects are retained. */
export const MAX_RECENT_PROJECTS = 20;

/** How many sessions one project associates. */
export const MAX_PROJECT_SESSIONS = 200;

/** How many recent files the UI state remembers. */
export const MAX_RECENT_FILES = 20;

/** A file that is written or read without going through a directory. */
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Error raised by the project model. The `code` is the stable discriminant
 * callers switch on; `message` is diagnostic prose. `status` is the HTTP status
 * the endpoint answers with when the same rule is violated from the browser.
 */
export class ProjectError extends Error {
  /**
   * @param code - stable failure class.
   * @param message - human readable detail.
   * @param status - the HTTP status to answer with.
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    this.status = status;
  }
}

// --------------------------------------------------------------- capabilities

/**
 * Assert that a name is one of {@link CAPABILITIES}.
 *
 * @param value - candidate capability.
 * @returns the name, narrowed.
 * @throws {ProjectError} when the name is not a known capability.
 */
export function assertCapabilityName(value) {
  if (typeof value !== 'string' || !CAPABILITIES.includes(value)) {
    throw new ProjectError(
      'PROJECT_UNKNOWN_CAPABILITY',
      `capability must be one of ${CAPABILITIES.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * Reduce a settings object to the exact capability shape.
 *
 * Unknown keys are dropped and a non boolean value is refused rather than
 * coerced, so a project can never silently run with a capability the user did
 * not grant. An absent field takes {@link DEFAULT_CAPABILITIES}.
 *
 * @param value - the settings' `capabilities`, if any.
 * @returns a frozen `{readWorkspace, writeWorkspace, terminal, git, network}`.
 * @throws {ProjectError} when a declared capability is not a boolean.
 */
export function normalizeCapabilities(value) {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new ProjectError('PROJECT_INVALID_SETTINGS', 'capabilities must be an object');
  }
  const source = value ?? {};
  const capabilities = {};
  for (const name of CAPABILITIES) {
    const declared = source[name];
    if (declared === undefined) {
      capabilities[name] = DEFAULT_CAPABILITIES[name];
      continue;
    }
    if (typeof declared !== 'boolean') {
      throw new ProjectError(
        'PROJECT_INVALID_SETTINGS',
        `capability ${name} must be a boolean (got ${JSON.stringify(declared)})`,
      );
    }
    capabilities[name] = declared;
  }
  return Object.freeze(capabilities);
}

/**
 * Assert that a project may use one capability.
 *
 * @param project - the project to read.
 * @param name - the capability to check.
 * @returns the capability name.
 * @throws {ProjectError} when the project does not grant it.
 */
export function assertCapability(project, name) {
  assertCapabilityName(name);
  const granted = project?.settings?.capabilities?.[name];
  if (granted !== true) {
    throw new ProjectError(
      'PROJECT_CAPABILITY_DENIED',
      `the project ${JSON.stringify(project?.id ?? null)} does not grant ${name}`,
      403,
    );
  }
  return name;
}

/**
 * The capabilities a project change may be asked for from the interface.
 *
 * The list is the **server's**, never the caller's. A request may name a
 * capability, but a name outside this list is refused before anything is read
 * or written, so the browser proposes and the model decides. V1 opens exactly
 * one: `network`, the grant a remote Git action needs and the only one a person
 * can reason about without risking their own work. The four filesystem and
 * process capabilities stay server-owned on purpose.
 */
export const MODIFIABLE_CAPABILITIES = Object.freeze(['network']);

/**
 * Assert that a capability may be changed by an interface.
 *
 * The name must be a known capability first, so "an unknown capability" and "a
 * known capability that is not yours to change" stay two different, readable
 * refusals.
 *
 * @param value - the capability the caller asked for.
 * @returns the name, narrowed.
 * @throws {ProjectError} `PROJECT_UNKNOWN_CAPABILITY` (400) for an unknown name,
 *   `PROJECT_CAPABILITY_READONLY` (403) for a known but server-owned one.
 */
export function assertModifiableCapability(value) {
  assertCapabilityName(value);
  if (!MODIFIABLE_CAPABILITIES.includes(value)) {
    throw new ProjectError(
      'PROJECT_CAPABILITY_READONLY',
      `la capacité ${JSON.stringify(value)} n'est pas modifiable depuis l'interface : ` +
        `seule ${MODIFIABLE_CAPABILITIES.join(', ')} peut l'être dans cette version`,
      403,
    );
  }
  return value;
}

/**
 * Return a project with one capability changed, everything else re-applied.
 *
 * This is the only function in the model that grants or revokes a capability.
 * It is deliberately narrow: the capability must be one the server allows to
 * change, and the new state must be a boolean, so nothing can coerce a value
 * through. Nothing else calls it, which is what keeps a grant from happening
 * silently at startup, on a project open, or while recovering from an error.
 *
 * @param project - the project to update.
 * @param name - the capability to change.
 * @param allowed - its new state.
 * @param options - the clock.
 * @returns the frozen updated project.
 * @throws {ProjectError} when the capability is not modifiable or the value is
 *   not a boolean.
 */
export function updateCapability(project, name, allowed, options = {}) {
  assertModifiableCapability(name);
  if (typeof allowed !== 'boolean') {
    throw new ProjectError(
      'PROJECT_INVALID_SETTINGS',
      `la capacité ${JSON.stringify(name)} doit être un booléen (reçu ${JSON.stringify(allowed)})`,
    );
  }
  const capabilities = { ...project.settings.capabilities, [name]: allowed };
  return updateProject(project, { settings: { ...project.settings, capabilities } }, options);
}

// ------------------------------------------------------------------ paths

/**
 * Reduce a name to the characters a project id and a PocketBase filter literal
 * can both carry.
 *
 * This is the same reduction `memory.rs` applies to a workspace directory name,
 * kept in step on purpose: the id `x/Documents/twin` derives here has to equal
 * the scope the memory backend was configured with, or the project would name
 * one namespace and store under another.
 *
 * @param value - the raw name.
 * @returns the slug, or `default` when nothing survives.
 */
export function slugify(value) {
  const base = typeof value === 'string' ? value : '';
  let slug = '';
  let lastWasSeparator = false;
  for (const character of base) {
    if (/[A-Za-z0-9]/.test(character)) {
      slug += character.toLowerCase();
      lastWasSeparator = false;
    } else if (!lastWasSeparator && slug !== '') {
      slug += '-';
      lastWasSeparator = true;
    }
  }
  while (slug.endsWith('-')) slug = slug.slice(0, -1);
  return slug === '' ? 'default' : slug;
}

/**
 * Assert that a value is a usable project id.
 *
 * @param value - candidate id.
 * @returns the trimmed id.
 * @throws {ProjectError} when the id is empty or malformed.
 */
export function assertProjectId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectError('PROJECT_INVALID_ID', 'a project id must be a non-empty string');
  }
  const id = value.trim();
  if (!PROJECT_ID_RE.test(id)) {
    throw new ProjectError(
      'PROJECT_INVALID_ID',
      `a project id must match ${PROJECT_ID_RE} (got ${JSON.stringify(id)})`,
    );
  }
  return id;
}

/**
 * Derive a project id from a root path, avoiding the ids already in use.
 *
 * A collision appends a short, stable suffix drawn from the full path, so two
 * projects whose directories share a base name stay distinct without the user
 * choosing anything.
 *
 * @param rootPath - the project's directory.
 * @param options - the derivation.
 * @param options.taken - ids already assigned to other projects.
 * @returns the id.
 */
export function deriveProjectId(rootPath, options = {}) {
  const taken = options.taken instanceof Set ? options.taken : new Set(options.taken ?? []);
  const base = slugify(String(rootPath ?? '').split(sep).filter(Boolean).pop() ?? '');
  if (!taken.has(base)) return base;
  let salt = 0;
  for (const character of String(rootPath ?? '')) {
    salt = (salt * 31 + character.charCodeAt(0)) % 100000;
  }
  let candidate = `${base}-${salt.toString(36)}`;
  let attempt = salt;
  while (taken.has(candidate)) {
    attempt += 1;
    candidate = `${base}-${attempt.toString(36)}`;
  }
  return candidate;
}

/**
 * Whether a path is the root itself or lives below it.
 *
 * The comparison is on the normalized absolute spelling, so `..` and a
 * trailing separator cannot smuggle a path outside the fence.
 *
 * @param root - the fence.
 * @param candidate - the path to test.
 * @returns whether the path is inside the fence.
 */
export function isInside(root, candidate) {
  if (typeof root !== 'string' || root === '' || typeof candidate !== 'string') return false;
  const base = resolve(root);
  const target = resolve(candidate);
  if (base === target) return true;
  const rel = relative(base, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/**
 * Resolve a path the caller names relative to the project root, inside its
 * fence. This is the one path function every consumer (storage, terminal, a
 * future editor) should go through: an absolute path that escapes the root is
 * refused rather than clamped.
 *
 * @param root - the project root.
 * @param target - an absolute path inside the root, or a path relative to it.
 * @returns the absolute path.
 * @throws {ProjectError} when the root is missing or the target escapes it.
 */
export function resolveInside(root, target) {
  if (typeof root !== 'string' || root === '') {
    throw new ProjectError('PROJECT_NO_ROOT', 'the project has no root path');
  }
  if (typeof target !== 'string' || target === '') {
    throw new ProjectError('PROJECT_INVALID_PATH', 'a path must be a non-empty string');
  }
  const base = resolve(root);
  const resolved = resolve(base, target);
  if (!isInside(base, resolved)) {
    throw new ProjectError(
      'PROJECT_OUTSIDE_ROOT',
      `${JSON.stringify(target)} resolves outside ${JSON.stringify(base)}`,
      403,
    );
  }
  return resolved;
}

// ------------------------------------------------------------------ project

/**
 * Normalize one persisted or supplied project into the model's shape.
 *
 * Total and tolerant: a persisted document is data an older build may have
 * written, so an unknown field is dropped and a missing scalar takes the
 * documented default rather than failing the load. What is *not* tolerated is a
 * missing id or root: a project without either names nothing.
 *
 * @param raw - the candidate project.
 * @param options - normalization.
 * @param options.now - the clock, in epoch milliseconds.
 * @returns the frozen project.
 * @throws {ProjectError} when the id or the root path is missing.
 */
export function normalizeProject(raw, options = {}) {
  const now = Number.isInteger(options.now) ? options.now : Date.now();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ProjectError('PROJECT_INVALID', 'a project must be an object');
  }
  const id = assertProjectId(raw.id);
  if (typeof raw.rootPath !== 'string' || raw.rootPath.trim() === '') {
    throw new ProjectError('PROJECT_INVALID', `project ${id} has no rootPath`);
  }
  const rootPath = resolve(raw.rootPath);
  const settings = raw.settings !== undefined && raw.settings !== null && typeof raw.settings === 'object'
    ? raw.settings
    : {};
  return Object.freeze({
    id,
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
    rootPath,
    createdAt: Number.isInteger(raw.createdAt) && raw.createdAt > 0 ? raw.createdAt : now,
    lastOpenedAt: Number.isInteger(raw.lastOpenedAt) && raw.lastOpenedAt > 0 ? raw.lastOpenedAt : null,
    // When a session last became known to the project: the one readable fact an
    // interface can show about "the last known session" without printing a
    // session identifier, which is not the interface's to display.
    lastSessionAt: Number.isInteger(raw.lastSessionAt) && raw.lastSessionAt > 0 ? raw.lastSessionAt : null,
    settings: Object.freeze({
      ...settings,
      capabilities: normalizeCapabilities(settings.capabilities),
    }),
    sessions: normalizeSessions(raw.sessions),
    memoryNamespace:
      typeof raw.memoryNamespace === 'string' && raw.memoryNamespace.trim() !== ''
        ? raw.memoryNamespace.trim()
        : id,
    handoffState: normalizeHandoff(raw.handoffState),
    uiState: normalizeUiState(raw.uiState),
    // The last Git synchronisation NewPi itself performed. It is deliberately
    // not derived from `.git/FETCH_HEAD`: that file moves for reasons NewPi did
    // not observe, and "the last sync NewPi knows about" is the honest claim.
    gitState: normalizeGitState(raw.gitState),
    workspaceId: typeof raw.workspaceId === 'string' && raw.workspaceId !== '' ? raw.workspaceId : null,
  });
}

/**
 * Build a new project record.
 *
 * @param input - the project's identity.
 * @param input.id - the stable id, already derived by the caller.
 * @param input.name - the display name.
 * @param input.rootPath - the project directory.
 * @param input.now - the clock, in epoch milliseconds.
 * @param input.settings - optional settings.
 * @param input.memoryNamespace - optional memory namespace; defaults to the id.
 * @param input.workspaceId - the DSH workspace record's id, when one exists.
 * @returns the frozen project.
 */
export function createProject({ id, name, rootPath, now = Date.now(), settings, memoryNamespace, workspaceId = null }) {
  return normalizeProject(
    { id, name, rootPath, createdAt: now, lastOpenedAt: null, settings, memoryNamespace, workspaceId },
    { now },
  );
}

/**
 * A shallow copy of a project with one patch applied and the model re-applied.
 *
 * @param project - the project to update.
 * @param patch - the fields to replace.
 * @param options - the clock.
 * @returns the frozen updated project.
 */
export function updateProject(project, patch, options = {}) {
  return normalizeProject({ ...project, ...patch }, options);
}

/** Deduplicate and cap a session list, preserving order (most recent first). */
function normalizeSessions(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  const seen = new Set();
  const sessions = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    sessions.push(entry);
    if (sessions.length >= MAX_PROJECT_SESSIONS) break;
  }
  return Object.freeze(sessions);
}

/** Reduce a handoff record to the fields the project keeps. */
function normalizeHandoff(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.freeze({
    version: Number.isInteger(value.version) ? value.version : 0,
    label: typeof value.label === 'string' ? value.label : null,
    digest: typeof value.digest === 'string' ? value.digest : null,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    at: Number.isInteger(value.at) ? value.at : null,
  });
}

/**
 * Reduce the last Git synchronisation to the two facts worth persisting.
 *
 * `null` means "NewPi has never synchronised this project"; it is not the same
 * as "there is no remote", which the Git status answers on its own.
 *
 * @param value - the persisted record, if any.
 * @returns a frozen `{at, kind}`, or `null`.
 */
function normalizeGitState(value) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return null;
  const at = Number.isInteger(value.at) && value.at > 0 ? value.at : null;
  const kind = value.kind === 'fetch' || value.kind === 'push' || value.kind === 'pull' ? value.kind : null;
  if (at === null || kind === null) return null;
  return Object.freeze({ at, kind });
}

/** Reduce the UI state to the small, known shape. */
function normalizeUiState(value) {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const files = [];
  const seen = new Set();
  for (const entry of Array.isArray(source.recentFiles) ? source.recentFiles : []) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue;
    seen.add(entry);
    files.push(entry);
    if (files.length >= MAX_RECENT_FILES) break;
  }
  return Object.freeze({
    lastSessionId: typeof source.lastSessionId === 'string' && source.lastSessionId !== '' ? source.lastSessionId : null,
    lastTab: typeof source.lastTab === 'string' && source.lastTab !== '' ? source.lastTab : null,
    recentFiles: Object.freeze(files),
  });
}

/**
 * Associate one session with a project, most recent first and without
 * duplicates.
 *
 * @param project - the project.
 * @param sessionId - the session to associate.
 * @param options - the clock.
 * @returns the updated project.
 * @throws {ProjectError} when the session id is empty.
 */
export function associateSession(project, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new ProjectError('PROJECT_INVALID_SESSION', 'a session id must be a non-empty string');
  }
  const id = sessionId.trim();
  const now = Number.isInteger(options.now) ? options.now : Date.now();
  const sessions = [id, ...project.sessions.filter((entry) => entry !== id)];
  return updateProject(project, { sessions, lastSessionAt: now }, { now });
}

/**
 * Remove one session from a project. Idempotent.
 *
 * @param project - the project.
 * @param sessionId - the session to remove.
 * @param options - the clock.
 * @returns the updated project.
 */
export function disassociateSession(project, sessionId, options = {}) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  return updateProject(
    project,
    { sessions: project.sessions.filter((entry) => entry !== id) },
    options,
  );
}

/**
 * Whether a session header's `cwd` places it inside a project.
 *
 * This is the same rule DSH's workspace registry applies (a session belongs to
 * the workspace whose canonical path equals its header's `cwd`), reused rather
 * than re-invented: a session with no `cwd` belongs to no project.
 *
 * @param project - the project.
 * @param cwd - the session header's working directory.
 * @returns whether the session belongs to the project.
 */
export function sessionBelongsToProject(project, cwd) {
  return typeof cwd === 'string' && cwd !== '' && isInside(project.rootPath, cwd);
}

/**
 * Merge a patch into a project's UI state.
 *
 * `recentFiles` may be given as a full list (normalized and capped) and
 * `lastSessionId`/`lastTab` as `null` to clear them.
 *
 * @param project - the project.
 * @param patch - `{lastSessionId?, lastTab?, recentFiles?}`.
 * @param options - the clock.
 * @returns the updated project.
 */
export function updateUiState(project, patch = {}, options = {}) {
  const current = project.uiState;
  const next = {
    lastSessionId: patch.lastSessionId === undefined ? current.lastSessionId : patch.lastSessionId,
    lastTab: patch.lastTab === undefined ? current.lastTab : patch.lastTab,
    recentFiles: patch.recentFiles === undefined ? current.recentFiles : patch.recentFiles,
  };
  return updateProject(project, { uiState: next }, options);
}

/**
 * Record the last Git synchronisation NewPi performed on a project.
 *
 * @param project - the project.
 * @param gitState - `{at, kind}`, or `null` to forget it.
 * @param options - the clock.
 * @returns the updated project.
 */
export function updateGitState(project, gitState, options = {}) {
  return updateProject(project, { gitState }, options);
}

/**
 * Record a completed handoff (a compaction boundary) on the project.
 *
 * @param project - the project.
 * @param handoff - the handoff facts, or `null` to forget them.
 * @param options - the clock.
 * @returns the updated project.
 */
export function updateHandoffState(project, handoff, options = {}) {
  return updateProject(project, { handoffState: handoff }, options);
}

/**
 * Stamp a project as opened now.
 *
 * @param project - the project.
 * @param now - the clock, in epoch milliseconds.
 * @returns the updated project.
 */
export function markOpened(project, now = Date.now()) {
  return updateProject(project, { lastOpenedAt: now }, { now });
}

// -------------------------------------------------------------- the guard

/**
 * One in-flight project operation.
 *
 * A plain class rather than a Cordis service: it is a value the editor, the
 * terminal and the project service hold, and holding it must outlive whichever
 * object started it.
 */
export class ProjectOperation {
  /** Whether the operation still holds its slot. */
  active = true;
  /** The operation's opaque label, for diagnostics. */
  label;

  /**
   * @param options - the operation's identity.
   * @param options.id - a monotonic id.
   * @param options.kind - `editor`, `terminal`, `workflow`, `memory`, ...
   * @param options.exclusive - whether a project switch must wait for it.
   * @param options.label - a diagnostic label.
   * @param options.projectId - the project the operation runs against.
   * @param options.startedAt - the clock, in epoch milliseconds.
   * @param options.onRelease - called with this operation when it releases.
   */
  constructor({ id, kind, exclusive = true, label = null, projectId = null, startedAt = Date.now(), onRelease }) {
    this.id = id;
    this.kind = kind;
    this.exclusive = exclusive;
    this.label = label;
    this.projectId = projectId;
    this.startedAt = startedAt;
    this._onRelease = onRelease;
  }

  /** Release the slot. Repeating it is a no-op. */
  release() {
    if (!this.active) return;
    this.active = false;
    this._onRelease?.(this);
  }

  /** A plain summary for an interface. */
  toJSON() {
    return Object.freeze({
      id: this.id,
      kind: this.kind,
      exclusive: this.exclusive,
      label: this.label,
      projectId: this.projectId,
      startedAt: this.startedAt,
      active: this.active,
    });
  }
}

/**
 * The guard that keeps a project from being changed out from under an
 * operation in flight.
 *
 * The rule is deliberately strict: any registered operation blocks a switch,
 * not only an exclusive one. A cheap read is short, and the alternative — a
 * switch that lands while a write is half done — is the exact failure this
 * exists to prevent. `force` is the documented escape hatch, and it is a
 * parameter a caller has to type, never a default.
 */
export class OperationGuard {
  /** The operations currently registered. */
  active = new Set();

  /** Rebuild a guard from a list, for a service remount. */
  constructor(operations = []) {
    for (const operation of operations) this.active.add(operation);
  }

  /** How many operations are registered. */
  get size() {
    return this.active.size;
  }

  /**
   * Register one operation.
   *
   * @param options - the operation's identity; `id` is filled when omitted.
   * @returns the registered operation.
   */
  begin(options = {}) {
    const operation = new ProjectOperation({
      reason: undefined,
      ...options,
      id: options.id ?? `op-${this.active.size + 1}-${Date.now().toString(36)}`,
      onRelease: (released) => this.active.delete(released),
    });
    this.active.add(operation);
    return operation;
  }

  /**
   * Run one operation and release it when the body settles, however it settles.
   *
   * @param options - the operation's identity.
   * @param body - the operation to run.
   * @returns whatever the body returns.
   */
  async run(options, body) {
    const operation = this.begin(options);
    try {
      return await body(operation);
    } finally {
      operation.release();
    }
  }

  /**
   * Refuse a project change while an operation is in flight.
   *
   * @param force - replace the project anyway.
   * @throws {ProjectError} when an operation is registered and `force` is false.
   */
  assertCanSwitch(force = false) {
    if (force === true || this.active.size === 0) return;
    const operations = [...this.active].map((operation) => operation.kind).join(', ');
    throw new ProjectError(
      'PROJECT_BUSY',
      `${this.active.size} operation(s) in flight (${operations}); ` +
        'the project was not changed so a running step cannot land in another one',
      409,
    );
  }

  /** The registered operations, as plain summaries. */
  list() {
    return [...this.active].map((operation) => operation.toJSON());
  }
}

/**
 * The project's handoff record, read from the Context & Cache Manager's own
 * version ledger.
 *
 * The manager is the only object that knows when a compaction committed and
 * which handoff version is in force, so the project stores what the manager
 * reports rather than deriving a second answer.
 *
 * @param versions - a `versions(sessionId)` result, or `null`.
 * @param sessionId - the session the compaction ran on.
 * @param at - the clock, in epoch milliseconds.
 * @returns the handoff facts, or `null` when the manager reported none.
 */
export function handoffFromVersions(versions, sessionId, at = Date.now()) {
  if (versions === null || versions === undefined || versions.handoffVersion === undefined) return null;
  return Object.freeze({
    version: Number.isInteger(versions.handoffVersion) ? versions.handoffVersion : 0,
    label: typeof versions.handoffLabel === 'string' ? versions.handoffLabel : null,
    digest: versions.handoff?.digest ?? null,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    at,
  });
}

/** A path inside a project, joined for a consumer that already checked. */
export function joinInside(project, ...parts) {
  return join(project.rootPath, ...parts);
}
