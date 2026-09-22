/**
 * The console: NewPi's Memory and Backup sections, and the one endpoint behind
 * them.
 *
 * # Why this is a plugin and not part of the memory backend
 *
 * `pocketbase-memory` owns the PocketBase conversation and the project scope;
 * `memory-tools` owns the model's three tools. This plugin owns the *human*
 * side: the two sections rendered in the interface, and the operations a person
 * performs there — list, search, read, delete, back up, restore. It reads the
 * memory service it needs and adds nothing to it that the model can reach.
 *
 * # Where the browser's requests land
 *
 * One exact route, `POST /api/newpi.console`, registered through
 * `ctx.connection.fetch` rather than `ctx.webServer`. That is the whole
 * security story and it is worth being explicit about, because the two look
 * interchangeable and are not: a `webServer` route is dispatched before any
 * authentication — the branding plugin's whale is one, on purpose — while a
 * `connection.fetch` route sits behind the same Host/Origin fence and the same
 * signed session cookie as the rest of `/api`. A console that can delete a
 * memory and replace a database must not be reachable by anything that can open
 * a loopback socket.
 *
 * The browser cannot name a project. Every action below reads the scope from
 * the service, which read it once from the project's own `cordis.yml`; the
 * parameter validator refuses any key an action does not declare, so
 * `project_id` is not merely unused on the way in, it is refused.
 *
 * @module newpi-plugin-memory-console
 */

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import { MEMORY_KINDS, MemoryError } from '../pocketbase-memory/core.js';
import { MAX_ARCHIVE_BYTES, MemoryBackups } from './backup.js';
import { PlatformError } from './platform.js';
import { installConsole } from './ui.js';

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'memory-console';

/** The webserver, for the interface injection; the memory service, for the
 * data; and the connection, whose authenticated fetch surface is the only door
 * into this plugin. */
export const inject = ['webServer', 'pocketbaseMemory', 'connection'];

/** The one endpoint the browser calls. Kept as a constant because the injected
 * script and this registration must agree, and because a test asserts the two
 * are the same string. */
export const CONSOLE_ENDPOINT = '/api/newpi.console';

/** Raised for a request that is well formed HTTP but not a usable action. */
export class ConsoleError extends Error {
  /**
   * @param code - stable failure class.
   * @param message - human readable detail.
   * @param status - the HTTP status to answer with.
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ConsoleError';
    this.code = code;
    this.status = status;
  }
}

/** Plugin configuration. Every value is supplied by NewPi's launcher, so a
 * hand-written row still works but has to say where the backups live. */
export const Config = z.object({
  /** Where NewPi keeps the backups it makes. */
  backupDir: z.string(),
  /** Where the sidecar keeps the snapshots it makes (`<pb_data>/backups`). */
  snapshotDir: z.string(),
  /** The sidecar's data directory (`<pb_data>`), watched for the restore swap. */
  dataDir: z.string(),
  /** The NewPi version written into every manifest. */
  newpiVersion: z.string(),
  /** The PocketBase version NewPi embeds, checked against every manifest. */
  pocketbaseVersion: z.string(),
  /** The open project's human name, for display. Empty when none is open. */
  projectName: z.string(),
  /** Log the mounted sections once at load. Defaults to true. */
  announce: z.boolean(),
});

/**
 * Assert that a request's parameters are the ones the action declares, and
 * nothing else.
 *
 * This is the fence the whole feature leans on: there is no code path from a
 * browser-supplied key to a PocketBase filter, because a key the action does
 * not name is refused before the action runs.
 *
 * @param params - the request's parameters.
 * @param allowed - the keys this action declares.
 * @returns the parameters, when every key is declared.
 * @throws {ConsoleError} when a key is undeclared or the shape is wrong.
 */
export function assertParams(params, allowed) {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new ConsoleError('CONSOLE_INVALID_ARGS', 'params must be an object');
  }
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      throw new ConsoleError(
        'CONSOLE_INVALID_ARGS',
        `unknown parameter ${JSON.stringify(key)}; this console cannot set it from the browser`,
      );
    }
  }
  return params;
}

/**
 * Assert that a value is a page size the console accepts.
 *
 * @param value - the candidate.
 * @param fallback - the value used when it is absent.
 * @param maximum - the largest accepted value.
 * @returns the integer to use.
 * @throws {ConsoleError} when the value is present but not an integer in range.
 */
export function assertNumber(value, fallback, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ConsoleError(
      'CONSOLE_INVALID_ARGS',
      `expected an integer between 1 and ${maximum} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * The status of "no project is open".
 *
 * It is a status, not an error: the Memory section must be able to say the
 * honest thing rather than render a backend failure the user cannot act on.
 * The namespace stays empty, so no read or write can ever be attributed to the
 * directory the harness happens to run in.
 *
 * @param projectName - the configured human name; empty when none is open.
 * @returns the empty scope the section renders.
 */
export function emptyMemoryStatus(projectName = '') {
  return {
    project_id: '',
    project_name: typeof projectName === 'string' ? projectName : '',
    no_project: true,
    total: 0,
    kinds: {},
    last_write: null,
  };
}

/**
 * The console service, reachable as `ctx.memoryConsole`.
 *
 * Every method here is one action of the browser API, in the same order as the
 * dispatch table below. None of them takes a project: the scope belongs to the
 * memory service this console was built around.
 */
export class MemoryConsole extends Service {
  /** The memory backend service. */
  memory;
  /** The backup engine. */
  backups;
  /** The versions this build reports, and checks archives against. */
  versions;
  /** Where the backups live. */
  backupDir;
  /** The open project's human name, for display. Empty when none is open. */
  projectName;
  /** Whether a project is open at all; every memory call is scoped to one. */
  noProject;

  /**
   * @param ctx - the owning Cordis context.
   * @param options - the resolved configuration.
   */
  constructor(ctx, options) {
    super(ctx, 'memoryConsole');
    this.memory = options.memory;
    this.backupDir = options.backupDir;
    this.projectName = typeof options.projectName === 'string' ? options.projectName : '';
    // The namespace is the authority: the console never invents one from the
    // name, and with none there is nothing to read or write.
    this.noProject = this.memory.projectId === '';
    this.versions = {
      newpi: options.newpiVersion,
      pocketbase: options.pocketbaseVersion,
    };
    this.backups = new MemoryBackups({
      memory: options.memory,
      directory: options.backupDir,
      snapshots: options.snapshotDir,
      dataDir: options.dataDir,
      versions: this.versions,
    });
  }

  /**
   * Report this project's memory: how much, of what kind, and how recent.
   *
   * With no project open there is no namespace to report on, so the answer is
   * the empty scope rather than a backend error: the section says "no project"
   * instead of dressing a transport failure as one.
   *
   * @returns the scope, the total, the per-kind counts and the newest write.
   */
  async memoryStatus() {
    if (this.noProject) return emptyMemoryStatus(this.projectName);
    const status = await this.memory.stats();
    return { ...status, project_name: this.projectName, no_project: false };
  }

  /**
   * Read one page of this project's memories, without their content.
   *
   * @param params - `{query, kind, page, perPage}`.
   * @returns the rows, the total, and where this page sits in it.
   */
  async memoryPage(params) {
    const { query, kind, page, perPage } = assertParams(params, ['query', 'kind', 'page', 'perPage']);
    if (query !== undefined && (typeof query !== 'string' || query.length > 500)) {
      throw new ConsoleError('CONSOLE_INVALID_ARGS', 'query must be a string of at most 500 characters');
    }
    if (kind !== undefined && kind !== '' && !MEMORY_KINDS.includes(kind)) {
      throw new ConsoleError('CONSOLE_INVALID_ARGS', `kind must be one of ${MEMORY_KINDS.join(', ')}`);
    }
    const size = assertNumber(perPage, 25, 100);
    const at = assertNumber(page, 1, 10_000);
    if (this.noProject) {
      return {
        ...emptyMemoryStatus(this.projectName),
        items: [],
        page: at,
        perPage: size,
      };
    }
    const result = await this.memory.page({ query, kind, page: at, perPage: size });
    return {
      project_id: this.memory.projectId,
      project_name: this.projectName,
      no_project: false,
      items: result.items,
      total: result.total,
      page: at,
      perPage: size,
    };
  }

  /**
   * Read one memory of this project, content included.
   *
   * @param params - `{id}`.
   * @returns the memory.
   * @throws {ConsoleError} when the id names no memory of this project.
   */
  async memoryRead(params) {
    const { id } = assertParams(params, ['id']);
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 100) {
      throw new ConsoleError('CONSOLE_INVALID_ARGS', 'id must be a non-empty string');
    }
    const memory = await this.memory.read(id.trim());
    if (memory === null) {
      throw new ConsoleError(
        'CONSOLE_NOT_FOUND',
        `Aucun souvenir ${id} dans ce projet.`,
        404,
      );
    }
    return { memory };
  }

  /**
   * Delete one memory of this project, once the deletion is confirmed.
   *
   * @param params - `{id, confirm}`.
   * @returns the id and whether a row was deleted.
   * @throws {ConsoleError} when the confirmation is missing.
   */
  async memoryDelete(params) {
    const { id, confirm } = assertParams(params, ['id', 'confirm']);
    if (confirm !== true) {
      throw new ConsoleError(
        'CONSOLE_CONFIRMATION_REQUIRED',
        'La suppression doit être confirmée explicitement.',
      );
    }
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > 100) {
      throw new ConsoleError('CONSOLE_INVALID_ARGS', 'id must be a non-empty string');
    }
    return { id: id.trim(), deleted: await this.memory.forget(id.trim()) };
  }

  /**
   * Report the backups directory and the archives it holds.
   *
   * @returns the status the Backup section renders, plus the project scope.
   */
  async backupStatus() {
    const status = await this.backups.status();
    return { ...status, project_id: this.memory.projectId };
  }

  /**
   * Make one backup, asking the user where to put it.
   *
   * @param params - `{pick}`; `pick: false` writes into the backups directory.
   * @returns the archive's path, size and manifest.
   */
  async backupCreate(params) {
    const { pick } = assertParams(params, ['pick']);
    const report = await this.backups.create({ pick: pick !== false });
    if (report.cancelled) return { cancelled: true };
    return {
      cancelled: false,
      path: report.path,
      name: report.name,
      bytes: report.bytes,
      manifest: report.manifest,
    };
  }

  /**
   * Take delivery of an archive the window read from the user's disk.
   *
   * The chooser is the window's own panel — the operating system's sheet,
   * owned by the application — so the archive arrives as bytes and is written
   * once into a holding directory. Nothing else in the console accepts a file
   * from the browser.
   *
   * @param params - `{name, bytes}` with the bytes base64 encoded.
   * @returns the path the archive was received at, and its size.
   * @throws {ConsoleError} when the name, the size or the encoding is wrong.
   */
  async backupUpload(params) {
    const { name, bytes } = assertParams(params, ['name', 'bytes']);
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 260) {
      throw new ConsoleError('CONSOLE_INVALID_ARGS', 'name must be the chosen file\'s name');
    }
    if (typeof bytes !== 'string' || bytes.length === 0) {
      throw new ConsoleError('CONSOLE_INVALID_ARGS', 'bytes must be a non-empty base64 string');
    }
    if (bytes.length > Math.ceil((MAX_ARCHIVE_BYTES * 4) / 3) + 4) {
      throw new ConsoleError(
        'CONSOLE_ARCHIVE_TOO_LARGE',
        `Cette archive dépasse la taille maximale acceptée (${Math.round(MAX_ARCHIVE_BYTES / (1024 * 1024))} Mio).`,
        413,
      );
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(bytes)) {
      throw new ConsoleError('CONSOLE_INVALID_ARGS', "les octets de l'archive ne sont pas du base64");
    }
    return this.backups.receive({ name: name.trim(), bytes: Buffer.from(bytes, 'base64') });
  }

  /**
   * Verify one archive and describe it, without touching the database.
   *
   * @param params - `{path}`: either a local backup the section listed, or the
   *   path an upload returned.
   * @returns the archive's metadata, its manifest, and the verdict.
   * @throws {ConsoleError} when no path is given.
   */
  async backupInspect(params) {
    const { path } = assertParams(params, ['path']);
    const archive = typeof path === 'string' && path.length > 0 ? path : null;
    if (archive === null) {
      throw new ConsoleError('CONSOLE_INVALID_ARGS', 'backup.inspect needs a path');
    }

    const inspected = await this.backups.inspectArchive(archive);
    const current = await this.memory.stats();
    return {
      cancelled: false,
      archive: { path: inspected.path, name: inspected.name, bytes: inspected.bytes },
      ok: inspected.ok,
      code: inspected.code,
      message: inspected.message,
      warning: inspected.warning,
      manifest: inspected.manifest,
      memories: inspected.memories,
      // Both figures, because the replacement is not scoped to this project:
      // the archive's total is whole-database, and so is what it replaces.
      current: {
        project_id: current.project_id,
        project_total: current.total,
        total: await this.memory.countAll(),
      },
    };
  }

  /**
   * Replace the live memory database with one archive.
   *
   * @param params - `{path, confirm}`.
   * @returns the restore report: the archive, the safety archive, and what was
   * read back out of the restored database.
   * @throws {ConsoleError} when the confirmation is missing.
   */
  async backupRestore(params) {
    const { path, confirm } = assertParams(params, ['path', 'confirm']);
    if (confirm !== true) {
      throw new ConsoleError(
        'CONSOLE_CONFIRMATION_REQUIRED',
        'La restauration doit être confirmée explicitement.',
      );
    }
    if (typeof path !== 'string' || path.trim().length === 0) {
      throw new ConsoleError('CONSOLE_INVALID_ARGS', 'path must be a non-empty string');
    }
    return this.backups.restore({ path: path.trim(), confirm: true });
  }

  /**
   * Show the backups directory in the Finder.
   *
   * @returns the directory that was revealed.
   */
  async backupReveal() {
    return { directory: await this.backups.reveal() };
  }

  /**
   * Run one action by name.
   *
   * @param action - the action the browser asked for.
   * @param params - its parameters.
   * @returns the action's value.
   * @throws {ConsoleError} when the action does not exist.
   */
  async dispatch(action, params) {
    switch (action) {
      case 'memory.status':
        assertParams(params, []);
        return this.memoryStatus();
      case 'memory.page':
        return this.memoryPage(params);
      case 'memory.read':
        return this.memoryRead(params);
      case 'memory.delete':
        return this.memoryDelete(params);
      case 'backup.status':
        assertParams(params, []);
        return this.backupStatus();
      case 'backup.create':
        return this.backupCreate(params);
      case 'backup.upload':
        return this.backupUpload(params);
      case 'backup.inspect':
        return this.backupInspect(params);
      case 'backup.restore':
        return this.backupRestore(params);
      case 'backup.reveal':
        assertParams(params, []);
        return this.backupReveal();
      default:
        throw new ConsoleError('CONSOLE_UNKNOWN_ACTION', `Action inconnue : ${JSON.stringify(action)}`, 404);
    }
  }

  /**
   * Answer one HTTP request.
   *
   * The response shape is always the same — `{ok: true, value}` or
   * `{ok: false, error: {code, message}}` — so the section can render any
   * failure without knowing which layer produced it.
   *
   * @param request - the request, already authenticated by the connection.
   * @returns the response.
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
        {
          ok: false,
          error: { code: 'CONSOLE_BAD_REQUEST', message: 'Corps de requête illisible.' },
        },
        { status: 400 },
      );
    }

    try {
      const value = await this.dispatch(payload.action, payload.params);
      return Response.json({ ok: true, value });
    } catch (error) {
      const code = error?.code ?? (error instanceof PlatformError ? 'CONSOLE_PLATFORM' : 'CONSOLE_FAILED');
      let status = 500;
      if (error instanceof ConsoleError) status = error.status;
      else if (code === 'MEMORY_BUSY') status = 409;
      else if (code === 'CONSOLE_CONFIRMATION_REQUIRED') status = 400;
      else if (error instanceof MemoryError || error instanceof PlatformError) status = 500;

      // The message goes to the user; the detail goes to the log, where an
      // operator can see the transport failure behind a one-line refusal.
      this.ctx.logger?.warn?.(`${name}: ${payload.action} failed (${code}): ${error?.message ?? error}`);
      return Response.json(
        { ok: false, error: { code, message: String(error?.message ?? error) } },
        { status },
      );
    }
  }
}

/**
 * Mount the console: register its endpoint and inject its two sections.
 *
 * @param ctx - the owning Cordis context, carrying `webServer`,
 *   `pocketbaseMemory` and `connection`.
 * @param config - the plugin row's configuration.
 */
export function apply(ctx, config = {}) {
  const console = new MemoryConsole(ctx, {
    memory: ctx.pocketbaseMemory,
    backupDir: config.backupDir ?? '',
    snapshotDir: config.snapshotDir ?? '',
    dataDir: config.dataDir ?? '',
    newpiVersion: config.newpiVersion ?? '0.0.0',
    pocketbaseVersion: config.pocketbaseVersion ?? '0.0.0',
    projectName: config.projectName ?? '',
  });

  ctx.connection.fetch.register({
    path: CONSOLE_ENDPOINT,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => console.handle(request),
  });

  ctx.webServer.tapIndex((html) => installConsole(html));

  if (config.announce !== false) {
    ctx.logger.info(
      `${name}: Memory and Backup mounted for ` +
        (console.noProject
          ? 'aucun projet ouvert'
          : `project=${console.memory.projectId} (${console.projectName})`) +
        (console.backupDir.length > 0 ? ` backups=${console.backupDir}` : ' (no backups directory)'),
    );
  }
}

export { MemoryError };
