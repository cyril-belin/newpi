/**
 * The Project Model's registry: one small JSON document under NewPi's state
 * directory.
 *
 * # Why a file
 *
 * A project registry is a few hundred bytes of metadata: an ordered list of
 * recent projects, which one is current, and each project's own state. PocketBase
 * would be a database for a document, and the launcher patch is regenerated
 * every launch and is not NewPi's to read back. One JSON file beside them is the
 * smallest thing that survives a restart and that a user can read.
 *
 * # Why the write is a temporary file
 *
 * The harness watches profile files, and a reader must never observe a half
 * written document. Every commit therefore writes `<file>.tmp` and renames it
 * over the target, the same discipline `patch.rs` uses for the launcher patch.
 *
 * # Why loading never throws
 *
 * A corrupt registry must cost the user their recent list, not their
 * application. {@link parseProjectState} is total: anything it does not
 * understand is dropped and reported as a warning, and an unreadable file loads
 * as the empty registry.
 *
 * @module newpi-plugin-project-model/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PROJECT_VERSION, normalizeProject } from './model.js';

/** The registry's file name, below the state directory NewPi resolved. */
export const REGISTRY_FILENAME = 'projects.json';

/**
 * The empty registry.
 *
 * @returns a fresh `{version, currentId, recent, projects}`.
 */
export function emptyProjectState() {
  return { version: PROJECT_VERSION, currentId: null, recent: [], projects: {} };
}

/**
 * Parse a registry document, tolerating anything.
 *
 * @param text - the file's contents.
 * @returns `{state, warning}`; the state is always a usable registry.
 */
export function parseProjectState(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { state: emptyProjectState(), warning: null };
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return {
      state: emptyProjectState(),
      warning: `the registry is not valid JSON (${error?.message ?? error}); starting empty`,
    };
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return { state: emptyProjectState(), warning: 'the registry is not an object; starting empty' };
  }

  const state = emptyProjectState();
  let dropped = 0;
  const projects = document.projects !== null && typeof document.projects === 'object' && !Array.isArray(document.projects)
    ? document.projects
    : {};
  for (const [key, raw] of Object.entries(projects)) {
    try {
      const project = normalizeProject({ ...raw, id: raw?.id ?? key });
      state.projects[project.id] = project;
    } catch {
      dropped += 1;
    }
  }

  for (const id of Array.isArray(document.recent) ? document.recent : []) {
    if (typeof id === 'string' && state.projects[id] !== undefined && !state.recent.includes(id)) {
      state.recent.push(id);
    }
  }
  // A project the document holds but the recent list forgot is still known: it
  // is appended rather than silently orphaned.
  for (const id of Object.keys(state.projects)) {
    if (!state.recent.includes(id)) state.recent.push(id);
  }

  state.currentId =
    typeof document.currentId === 'string' && state.projects[document.currentId] !== undefined
      ? document.currentId
      : null;

  const warning = dropped > 0 ? `${dropped} unusable project record(s) were dropped` : null;
  return { state, warning };
}

/**
 * Serialize a registry document, in a stable, readable form.
 *
 * @param state - the registry.
 * @returns the JSON text, newline terminated.
 */
export function serializeProjectState(state) {
  const document = {
    version: PROJECT_VERSION,
    currentId: state.currentId ?? null,
    recent: [...(state.recent ?? [])],
    projects: {},
  };
  for (const id of state.recent ?? []) {
    if (state.projects?.[id] !== undefined) document.projects[id] = state.projects[id];
  }
  for (const [id, project] of Object.entries(state.projects ?? {})) {
    if (document.projects[id] === undefined) document.projects[id] = project;
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Replace a project's record, preserving its position in the recent order.
 *
 * @param state - the registry.
 * @param project - the project to store.
 * @returns the same state, mutated.
 */
export function upsertProject(state, project) {
  state.projects[project.id] = project;
  if (!state.recent.includes(project.id)) state.recent.push(project.id);
  return state;
}

/**
 * Forget a project record entirely. Idempotent.
 *
 * @param state - the registry.
 * @param id - the project to remove.
 * @returns the same state, mutated.
 */
export function forgetProject(state, id) {
  delete state.projects[id];
  state.recent = state.recent.filter((entry) => entry !== id);
  if (state.currentId === id) state.currentId = null;
  return state;
}

/**
 * Make one project the current one, or clear the current project with `null`.
 *
 * @param state - the registry.
 * @param id - the project, or `null`.
 * @returns the same state, mutated.
 * @throws {Error} when the id names no known project.
 */
export function setCurrentProject(state, id) {
  if (id === null) {
    state.currentId = null;
    return state;
  }
  if (state.projects[id] === undefined) {
    throw new Error(`unknown project ${JSON.stringify(id)}`);
  }
  state.currentId = id;
  return state;
}

/**
 * Move one project to the front of the recent order.
 *
 * @param state - the registry.
 * @param id - the project to promote.
 * @returns the same state, mutated.
 */
export function promoteRecent(state, id) {
  state.recent = [id, ...state.recent.filter((entry) => entry !== id)];
  return state;
}

/**
 * The file backed registry.
 *
 * Reads and writes are the store's only job; the ordering rules live in the
 * pure functions above, so a test can exercise them without a filesystem.
 */
export class ProjectStore {
  /** The absolute path of the registry document. */
  file;
  /** The last state loaded, or `null` before the first load. */
  state = null;
  /** The warning the last load produced, if any. */
  warning = null;
  /** Serializes load-modify-save cycles so two writers cannot lose a field. */
  _tail = Promise.resolve();

  /**
   * @param options - the store's location.
   * @param options.stateDir - NewPi's state directory.
   * @param options.file - an explicit registry path, overriding `stateDir`.
   */
  constructor({ stateDir, file }) {
    this.file = file ?? join(stateDir ?? '.', REGISTRY_FILENAME);
  }

  /**
   * Read the registry. A missing or unreadable file is the empty registry.
   *
   * @returns the loaded state.
   */
  async load() {
    let text = null;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.warning = `the registry could not be read (${error?.message ?? error}); starting empty`;
        this.state = emptyProjectState();
        return this.state;
      }
    }
    const { state, warning } = parseProjectState(text);
    this.warning = warning;
    this.state = state;
    return state;
  }

  /**
   * Write a whole registry document, atomically and after any pending write.
   *
   * @param state - the registry to commit.
   * @returns whatever the write returns.
   */
  save(state) {
    this.state = state;
    const commit = this._tail.then(
      () => this._write(state),
      () => this._write(state),
    );
    // Keep the chain alive whether the commit resolves or rejects, so one
    // failed write does not reject every later one.
    this._tail = commit.then(
      () => undefined,
      () => undefined,
    );
    return commit;
  }

  /** One atomic write: a sibling temporary file, then a rename. */
  async _write(state) {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, serializeProjectState(state), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.file);
  }

  /**
   * Apply one change to the loaded registry and commit it.
   *
   * @param change - a function that mutates and/or returns the state.
   * @returns the committed state.
   */
  async update(change) {
    const state = this.state ?? (await this.load());
    const result = (await change(state)) ?? state;
    await this.save(result);
    return result;
  }
}
