/**
 * The Storage section: what is using the disk, and the only cleanups NewPi will
 * perform on its own.
 *
 * # Why this exists
 *
 * A Tauri project's `target/` directory, an npm cache and a set of simulator
 * disks do not announce themselves. They grow a few gigabytes per experiment,
 * nothing ever rotates them, and the first symptom is a disk that is full for
 * no visible reason. The audit that produced this plugin measured exactly that
 * shape of growth — see `docs/storage-audit.md`.
 *
 * # What it will and will not do
 *
 * It **measures** everything in its catalog and reports two figures per target:
 * the allocated size (`st_blocks * 512`, what the filesystem spends) and the
 * logical size (`st_size`, what a sparse file claims). It **removes** only
 * targets the catalog marks `safe`: compiler outputs and caches, all of them
 * reconstructible by the command that produced them.
 *
 * It never removes a session, a PocketBase memory row, an instantané, or a
 * backup. That is not a confirmation prompt — it is a missing code path. Those
 * live behind the Memory section's per-memory confirmation and the Backup
 * section's restore confirmation, or behind the user's own shell.
 *
 * # Where the browser's requests land
 *
 * One exact route, `POST /api/newpi.storage`, registered through
 * `ctx.connection.fetch` and therefore behind the same Host/Origin fence and
 * the same signed session cookie as the rest of `/api`. A `webServer` route is
 * dispatched before authentication, which is fine for the branding plugin's
 * whale and unacceptable for something that deletes directories.
 *
 * The browser can name one thing: a catalog id. It cannot name a path, a root,
 * or a scope. The parameter validator refuses every key an action does not
 * declare, so a request cannot introduce one.
 *
 * @module newpi-plugin-storage-console
 */

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import {
  buildCatalog,
  findEntry,
  isRemovable,
  RETENTION_POLICY,
  ROLES,
} from './catalog.js';
import { CleanupError, previewCleanup, runSafeCleanup } from './cleanup.js';
import { DEFAULT_LIMITS, measureTree } from './scan.js';
import { installStorage } from './ui.js';

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'storage-console';

/** The webserver, for the interface injection; the connection, whose
 * authenticated fetch surface is the only door into this plugin. */
export const inject = ['webServer', 'connection'];

/** The one endpoint the browser calls. A test asserts the injected script and
 * this registration agree, because they are two literals that must not drift. */
export const STORAGE_ENDPOINT = '/api/newpi.storage';

/** How long a measurement stays usable without re-walking the tree. */
export const MEASUREMENT_TTL_MS = 5 * 60 * 1000;

/** The scopes, in the order the view shows them. */
export const SCOPES = ['newpi', 'dsh', 'toolchain', 'other'];

/** Human labels for the two safety classes, used by the shell command. */
export const SAFETY_LABELS = { safe: 'reconstructible', guarded: 'protégé' };

/** Raised for a request that is well formed HTTP but not a usable action. */
export class StorageError extends Error {
  /**
   * @param code - stable failure class.
   * @param message - human readable detail.
   * @param status - the HTTP status to answer with.
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = status;
  }
}

/** Plugin configuration. Every value is a path NewPi already resolved; none of
 * them is a secret, and none of them comes from the browser. */
export const Config = z.object({
  /** The user's home directory, the root most targets hang from. */
  home: z.string(),
  /** The project directory the harness runs in. */
  workspace: z.string(),
  /** NewPi's application state directory. */
  stateDir: z.string(),
  /** The harness home (`$DSH_HOME`). */
  dshHome: z.string(),
  /** The PocketBase data directory. */
  dataDir: z.string(),
  /** The sidecar's own transitory snapshot directory. */
  snapshotDir: z.string(),
  /** Where NewPi writes the user's backups. */
  backupDir: z.string(),
  /** Log the mounted section once at load. Defaults to true. */
  announce: z.boolean(),
});

/**
 * Assert that a request's parameters are the ones the action declares.
 *
 * The same fence the memory console uses, for the same reason: there is no code
 * path from a browser-supplied key to a path on disk, because a key the action
 * does not name is refused before the action runs.
 *
 * @param params - the request's parameters.
 * @param allowed - the keys this action declares.
 * @returns the parameters.
 * @throws {StorageError} when a key is undeclared or the shape is wrong.
 */
export function assertParams(params, allowed) {
  if (params === undefined || params === null) return {};
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new StorageError('STORAGE_INVALID_ARGS', 'params must be an object');
  }
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      throw new StorageError(
        'STORAGE_INVALID_ARGS',
        `unknown parameter ${JSON.stringify(key)}; this section cannot set it from the browser`,
      );
    }
  }
  return params;
}

/**
 * The Storage service, reachable as `ctx.storageConsole`.
 *
 * Measurements are cached per id for {@link MEASUREMENT_TTL_MS}. A scan is I/O
 * proportional to the size of the tree, and the view asks for the same figures
 * repeatedly as it re-renders; walking the npm cache on every repaint would be
 * the bug, not the feature.
 */
export class StorageConsole extends Service {
  /** The roots this launch was configured with. */
  roots;
  /** The catalog, built once from those roots. */
  entries;
  /** `id -> {at, report}`, the measurement cache. */
  measurements = new Map();

  /**
   * @param ctx - the owning Cordis context.
   * @param options - the resolved configuration.
   */
  constructor(ctx, options) {
    super(ctx, 'storageConsole');
    this.roots = {
      home: options.home ?? '',
      workspace: options.workspace ?? '',
      state: options.stateDir ?? '',
      dshHome: options.dshHome ?? '',
    };
    this.entries = buildCatalog({
      home: this.roots.home,
      workspace: this.roots.workspace,
      state: this.roots.state,
      dshHome: this.roots.dshHome,
      data: options.dataDir ?? '',
      snapshots: options.snapshotDir ?? '',
      backups: options.backupDir ?? '',
    });
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * The catalog entry with one id.
   *
   * @param id - the requested id.
   * @returns the entry.
   * @throws {StorageError} when no entry has that id.
   */
  entry(id) {
    const entry = findEntry(this.entries, id);
    if (entry === null) {
      throw new StorageError(
        'STORAGE_UNKNOWN_TARGET',
        `Cible inconnue : ${JSON.stringify(id)}. Le navigateur ne peut nommer qu'un identifiant du catalogue.`,
        404,
      );
    }
    return entry;
  }

  /**
   * Measure one entry, using the cache when it is still fresh.
   *
   * @param entry - the catalog entry.
   * @param options - the measurement.
   * @param options.refresh - ignore a cached figure.
   * @returns the measurement, or `null` when the entry has no path at all.
   */
  async measure(entry, options = {}) {
    if (typeof entry.path !== 'string' || entry.path.length === 0) return null;
    const cached = this.measurements.get(entry.id);
    const now = this.clock();
    if (!options.refresh && cached !== undefined && now - cached.at < MEASUREMENT_TTL_MS) {
      return cached.report;
    }
    const report = await measureTree(entry.path, {
      ...DEFAULT_LIMITS,
      timeoutMs: entry.scanTimeoutMs ?? DEFAULT_LIMITS.timeoutMs,
      clock: this.clock,
    });
    this.measurements.set(entry.id, { at: now, report });
    return report;
  }

  /**
   * The whole picture: the catalog, the policy, and whatever has been measured.
   *
   * Entries that describe a group of other entries (`overlaps`) are reported
   * but left out of the totals, so a parent and its children are never counted
   * twice.
   *
   * @returns the status the view renders.
   */
  status() {
    const entries = this.entries.map((entry) => ({
      ...entry,
      measurement: this.measurements.get(entry.id)?.report ?? null,
      budgetBytes: entry.budgetBytes ?? RETENTION_POLICY[entry.role]?.budgetBytes ?? null,
    }));

    const counted = entries.filter((entry) => !Array.isArray(entry.overlaps));
    const byRole = {};
    for (const role of Object.values(ROLES)) {
      const rows = counted.filter((entry) => entry.role === role && entry.measurement !== null);
      if (rows.length === 0) continue;
      byRole[role] = rows.reduce((sum, row) => sum + row.measurement.allocated, 0);
    }
    const byScope = {};
    for (const scope of SCOPES) {
      const rows = counted.filter(
        (entry) => entry.scope === scope && entry.measurement !== null,
      );
      byScope[scope] = rows.reduce((sum, row) => sum + row.measurement.allocated, 0);
    }

    const stale = counted.filter((entry) => entry.measurement === null).map((entry) => entry.id);
    return {
      roots: this.roots,
      scopes: SCOPES,
      policy: RETENTION_POLICY,
      entries,
      totals: {
        allocated: Object.values(byScope).reduce((sum, value) => sum + value, 0),
        byRole,
        byScope,
        unmeasured: stale,
        // Every entry the view can walk, parents included: a group row is
        // measurable even though its bytes are never added to a total.
        measurable: entries
          .filter((entry) => typeof entry.path === 'string' && entry.path.length > 0)
          .map((entry) => entry.id),
        measuredAt: new Date(this.clock()).toISOString(),
      },
    };
  }

  /**
   * Measure a set of entries, then report the whole picture.
   *
   * @param params - `{ids?, scopes?, refresh?}`. With neither `ids` nor
   *   `scopes`, every entry with a path is measured.
   * @returns the status, with the fresh figures in it.
   * @throws {StorageError} when an id or scope is not one the catalog knows.
   */
  async scan(params) {
    const { ids, scopes, refresh } = assertParams(params, ['ids', 'scopes', 'refresh']);
    let selected;
    if (ids !== undefined) {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw new StorageError('STORAGE_INVALID_ARGS', 'ids must be an array of catalog ids');
      }
      selected = ids.map((id) => this.entry(id));
    } else if (scopes !== undefined) {
      if (!Array.isArray(scopes) || scopes.some((scope) => !SCOPES.includes(scope))) {
        throw new StorageError(
          'STORAGE_INVALID_ARGS',
          `scopes must be a subset of ${SCOPES.join(', ')}`,
        );
      }
      selected = this.entries.filter((entry) => scopes.includes(entry.scope));
    } else {
      selected = this.entries;
    }

    for (const entry of selected) {
      await this.measure(entry, { refresh: refresh === true });
    }
    return this.status();
  }

  /**
   * Describe one target and what removing it would cost.
   *
   * @param params - `{id}`.
   * @returns the preview, guarded targets included: showing the size of
   *   something that will not be deleted is how a user learns where the disk
   *   went.
   */
  async preview(params) {
    const { id } = assertParams(params, ['id']);
    if (typeof id !== 'string' || id.length === 0) {
      throw new StorageError('STORAGE_INVALID_ARGS', 'id must be a non-empty string');
    }
    const entry = this.entry(id);
    const preview = await previewCleanup({ entry, roots: this.roots, limits: DEFAULT_LIMITS });
    if (preview.measurement !== null) {
      this.measurements.set(entry.id, { at: this.clock(), report: preview.measurement });
    }
    return { ...preview, budgetBytes: entry.budgetBytes ?? null };
  }

  /**
   * Remove one safe target.
   *
   * @param params - `{id, confirm, expectBytes}`. `confirm` must be the id
   *   typed back, and `expectBytes` the allocated size the preview showed.
   * @returns the removal report, including the bytes actually freed.
   * @throws {StorageError} when a required parameter is missing.
   */
  async clean(params) {
    const { id, confirm, expectBytes } = assertParams(params, ['id', 'confirm', 'expectBytes']);
    if (typeof id !== 'string' || id.length === 0) {
      throw new StorageError('STORAGE_INVALID_ARGS', 'id must be a non-empty string');
    }
    const entry = this.entry(id);
    const report = await runSafeCleanup({
      entry,
      roots: this.roots,
      confirm,
      expectBytes,
      limits: DEFAULT_LIMITS,
    });
    this.measurements.delete(entry.id);
    return report;
  }

  /**
   * Run one action by name.
   *
   * @param action - the action the browser asked for.
   * @param params - its parameters.
   * @returns the action's value.
   * @throws {StorageError} when the action does not exist.
   */
  async dispatch(action, params) {
    switch (action) {
      case 'storage.status':
        assertParams(params, []);
        return this.status();
      case 'storage.scan':
        return this.scan(params);
      case 'storage.preview':
        return this.preview(params);
      case 'storage.clean':
        return this.clean(params);
      default:
        throw new StorageError(
          'STORAGE_UNKNOWN_ACTION',
          `Action inconnue : ${JSON.stringify(action)}`,
          404,
        );
    }
  }

  /**
   * Answer one HTTP request.
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
        {
          ok: false,
          error: { code: 'STORAGE_BAD_REQUEST', message: 'Corps de requête illisible.' },
        },
        { status: 400 },
      );
    }

    try {
      const value = await this.dispatch(payload.action, payload.params);
      return Response.json({ ok: true, value });
    } catch (error) {
      const code = error?.code ?? 'STORAGE_FAILED';
      const status = error instanceof StorageError || error instanceof CleanupError
        ? error.status
        : 500;
      this.ctx.logger?.warn?.(`${name}: ${payload.action} failed (${code}): ${error?.message ?? error}`);
      return Response.json(
        { ok: false, error: { code, message: String(error?.message ?? error) } },
        { status },
      );
    }
  }
}

/**
 * Mount the section: register its endpoint and inject it.
 *
 * @param ctx - the owning Cordis context.
 * @param config - the plugin row's configuration.
 */
export function apply(ctx, config = {}) {
  const storage = new StorageConsole(ctx, config);

  ctx.connection.fetch.register({
    path: STORAGE_ENDPOINT,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => storage.handle(request),
  });

  ctx.webServer.tapIndex((html) => installStorage(html));

  if (config.announce !== false) {
    const removable = storage.entries.filter((entry) => isRemovable(entry)).length;
    ctx.logger.info(
      `${name}: Storage mounted — ${storage.entries.length} cibles, ${removable} nettoyables, ` +
        `espace=${storage.roots.workspace || '(inconnu)'}`,
    );
  }
}

export { CleanupError, RETENTION_POLICY };
