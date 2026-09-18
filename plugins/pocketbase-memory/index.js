/**
 * Cordis backend service for NewPi's durable project memory.
 *
 * This plugin owns the PocketBase conversation: it resolves the loopback
 * sidecar's coordinates once at load, holds one connection, and exposes the
 * three memory operations as `ctx.pocketbaseMemory`. It registers no tools —
 * `newpi-plugin-memory-tools` is the model-facing half, and it reaches this
 * service through `inject`, so the two can be replaced independently.
 *
 * The plugin never fails the boot. NewPi launches this process to show a
 * window; a memory sidecar that is not running must cost the user a working
 * `recall`, not a Herness that refuses to start. A failed connection is
 * therefore held as a sticky error and reported by the first tool call, with
 * the real transport message attached.
 *
 * @module newpi-plugin-pocketbase-memory
 */

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import {
  MEMORY_KINDS,
  MemoryError,
  assertContent,
  assertKind,
  assertLimit,
  assertProjectId,
  optionalKind,
  toIsoTimestamp,
  toMemory,
  toMemorySummary,
} from './core.js';
import { PocketBaseMemories } from './client.js';
import {
  ENV_IDENTITY,
  ENV_PASSWORD,
  ENV_PROJECT_ID,
  resolveBaseUrl,
  setting,
} from './environment.js';

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'pocketbase-memory';

/**
 * No service dependency beyond the context itself: this plugin is the root of
 * the memory feature, and `memory-tools` is what depends on it.
 */
export const inject = [];

/** Plugin configuration, all optional so a hand-written row stays short and
 * the environment remains the single source of connection truth. */
export const Config = z.object({
  /** Loopback base URL, e.g. `http://127.0.0.1:8090`. Overrides `DSH_MEMORY_URL`. */
  url: z.string(),
  /** Superuser identity. Overrides `DSH_MEMORY_IDENTITY`. */
  identity: z.string(),
  /** Superuser password. Overrides `DSH_MEMORY_PASSWORD`. */
  password: z.string(),
  /** Project scope. Overrides `DSH_MEMORY_PROJECT_ID`. */
  projectId: z.string(),
  /** Log the connection summary once at load. Defaults to true. */
  announce: z.boolean(),
});

/**
 * The memory backend service, reachable as `ctx.pocketbaseMemory`.
 *
 * Every method validates its inputs, then delegates to the PocketBase client,
 * and every record crossing back out is projected through
 * {@link toMemory}. Nothing else in the harness sees a raw PocketBase row.
 */
export class PocketBaseMemory extends Service {
  /** The configured project scope. Supplied by NewPi from the project's own
   * `cordis.yml`; never accepted as a tool argument. */
  projectId;
  /** Connection summary for diagnostics. */
  target;
  /**
   * The transport, or `null` when the connection could not be established.
   *
   * Plain properties, never `#private` fields: Cordis returns a `Proxy` around
   * every service instance, and a private field access through that proxy
   * throws "Receiver must be an instance of class". Anything a method touches
   * has to be reachable through the proxy.
   */
  _client = null;
  /** Why the transport is missing, kept so the first tool call can say it. */
  _failure = null;
  /**
   * The write barrier, or `null` while writes are allowed.
   *
   * Set by {@link exclusive} for the duration of a maintenance operation — a
   * restore replaces the whole database, and a `remember` that lands in the
   * middle of it would either be lost or write into a database that is being
   * swapped underneath it. While it is set, {@link remember} waits instead of
   * writing; reads are never blocked, because a console that cannot list
   * memories cannot report what the restore did.
   */
  _barrier = null;

  /**
   * @param ctx - the owning Cordis context.
   * @param options - resolved connection settings.
   */
  constructor(ctx, options) {
    super(ctx, 'pocketbaseMemory');
    this.projectId = options.projectId;
    this.target = options.baseUrl;

    if (options.projectId === '') {
      this._failure = new MemoryError(
        'MEMORY_NO_PROJECT',
        'no memory project_id was configured for this workspace',
      );
      return;
    }

    try {
      this._client = new PocketBaseMemories({
        baseUrl: options.baseUrl,
        identity: options.identity,
        password: options.password,
      });
    } catch (error) {
      this._failure = new MemoryError('MEMORY_UNREACHABLE', String(error?.message ?? error), {
        cause: error,
      });
    }
  }

  /** The transport, or a throw naming why memory is unavailable. */
  _requireClient() {
    if (this._client !== null) return this._client;
    const reason = this._failure?.message ?? 'the memory backend is not configured';
    const code = this._failure?.code ?? 'MEMORY_UNAVAILABLE';
    throw new MemoryError(code, `memory is unavailable: ${reason}`, {
      cause: this._failure ?? undefined,
    });
  }

  /**
   * Store one memory in this project.
   *
   * @param input - the memory to store.
   * @param input.content - memory text.
   * @param input.kind - one of `note`, `decision`, `bugfix`, `lesson`.
   * @returns the stored memory with its id and timestamp.
   * @throws {MemoryError} when the input is invalid or PocketBase refuses.
   */
  async remember({ content, kind }) {
    const client = this._requireClient();
    const projectId = assertProjectId(this.projectId);
    const record = await this._writable(() =>
      client.remember({
        content: assertContent(content),
        projectId,
        kind: assertKind(kind),
      }),
    );
    const memory = toMemory(record);
    if (memory === null) {
      throw new MemoryError('MEMORY_PROTOCOL', 'PocketBase returned a memory without an id');
    }
    return memory;
  }

  /**
   * Read memories of this project, newest first.
   *
   * @param input - the query.
   * @param input.query - optional text fragment; empty lists the newest.
   * @param input.kind - optional kind filter.
   * @param input.limit - optional result cap; defaults to 8.
   * @returns the matching memories, newest first.
   * @throws {MemoryError} when the input is invalid or PocketBase refuses.
   */
  async recall({ query, kind, limit } = {}) {
    const client = this._requireClient();
    const records = await client.recall({
      projectId: assertProjectId(this.projectId),
      query: typeof query === 'string' ? query : '',
      kind: optionalKind(kind),
      limit: assertLimit(limit),
    });
    return records.map(toMemory).filter((memory) => memory !== null);
  }

  /**
   * Delete one memory from this project.
   *
   * @param id - the memory id.
   * @returns whether a memory was deleted; `false` means the id is not part of
   * this project (or never existed), which is deliberately indistinguishable.
   * @throws {MemoryError} when PocketBase refuses the delete.
   */
  async forget(id) {
    const client = this._requireClient();
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new MemoryError('MEMORY_INVALID_ID', 'id must be a non-empty string');
    }
    const projectId = assertProjectId(this.projectId);
    // A delete is a write like any other: it waits behind a restore rather
    // than racing one, so the console can never report a deletion that the
    // database swap silently undid.
    return this._writable(() => client.forget(id.trim(), projectId));
  }

  /**
   * Run one write, waiting for any maintenance operation to finish first.
   *
   * @param operation - the write to perform once writing is allowed.
   * @returns whatever the write returns.
   * @throws {MemoryError} when the transport is unavailable or the write fails.
   */
  async _writable(operation) {
    // A loop rather than one wait: a second restore that starts while this
    // write is parked must park it again, not let it through behind the first.
    while (this._barrier !== null) await this._barrier;
    return operation();
  }

  /**
   * Run one maintenance operation with memory writes held off.
   *
   * Writes already in flight are *not* awaited: the caller is expected to be
   * the only writer of this database at that moment, and PocketBase's own
   * backup mechanism takes the write lock it needs. What this guarantees is
   * narrower and is the part that matters to a user: no `remember` starts while
   * the database is being replaced, so nothing is written into a snapshot that
   * is about to be swapped out.
   *
   * @param operation - the operation to run exclusively.
   * @returns whatever the operation returns.
   * @throws {MemoryError} when another operation already holds the barrier.
   */
  async exclusive(operation) {
    if (this._barrier !== null) {
      throw new MemoryError(
        'MEMORY_BUSY',
        'another memory maintenance operation is already running',
      );
    }
    let lift;
    this._barrier = new Promise((resolve) => {
      lift = resolve;
    });
    try {
      return await operation();
    } finally {
      const release = lift;
      this._barrier = null;
      release();
    }
  }

  /**
   * Counts and recency for one project's memory, for the console's header.
   *
   * @returns the scope, the total, the per-kind counts and the newest write.
   * @throws {MemoryError} when PocketBase refuses a read.
   */
  async stats() {
    const client = this._requireClient();
    const projectId = assertProjectId(this.projectId);
    const total = await client.count({ projectId });

    const kinds = {};
    for (const kind of MEMORY_KINDS) {
      kinds[kind] = total === 0 ? 0 : await client.count({ projectId, kind });
    }

    const newest = total === 0 ? null : await client.newest(projectId);
    return {
      project_id: projectId,
      total,
      kinds,
      last_write: toIsoTimestamp(newest),
    };
  }

  /**
   * Read one page of this project's memories, without their content.
   *
   * @param input - the query.
   * @param input.query - optional text fragment; empty lists the newest.
   * @param input.kind - optional kind filter.
   * @param input.page - 1-based page number.
   * @param input.perPage - rows per page.
   * @returns the rows, newest first, and the total matching the filter.
   * @throws {MemoryError} when the input is invalid or PocketBase refuses.
   */
  async page({ query, kind, page, perPage } = {}) {
    const client = this._requireClient();
    const result = await client.page({
      projectId: assertProjectId(this.projectId),
      query: typeof query === 'string' ? query : '',
      kind: optionalKind(kind),
      page: Number.isInteger(page) && page > 0 ? page : 1,
      perPage: Number.isInteger(perPage) && perPage > 0 ? perPage : 20,
      // The content is requested because the preview is cut from it; it is
      // dropped by the projection below, so a listing that crosses to the
      // browser carries no memory text, only its first line.
      fields: 'id,content,kind,created_at',
    });
    return {
      items: result.items.map(toMemorySummary).filter((row) => row !== null),
      total: result.total,
    };
  }

  /**
   * Read one memory of this project, content included.
   *
   * @param id - the memory id.
   * @returns the memory, or `null` when the id is not part of this project —
   * which is deliberately the same answer as an id that never existed.
   * @throws {MemoryError} when PocketBase refuses the read.
   */
  async read(id) {
    const client = this._requireClient();
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new MemoryError('MEMORY_INVALID_ID', 'id must be a non-empty string');
    }
    const record = await client.find(id.trim(), assertProjectId(this.projectId));
    return record === null ? null : toMemory(record);
  }

  /**
   * How many memories every project holds, this one included.
   *
   * Only the backup and restore paths ask for this: a backup's manifest records
   * what the archive contains so a restore can be checked against it. It is
   * never rendered in the interface, which stays scoped to one project.
   *
   * @returns the number of rows in the whole collection.
   * @throws {MemoryError} when PocketBase refuses the read.
   */
  async countAll() {
    const client = this._requireClient();
    return client.count({});
  }

  /**
   * Ask the sidecar to snapshot its database, through its own backup API.
   *
   * @param name - the archive name to store the snapshot under.
   * @returns the key PocketBase stored it under.
   * @throws {MemoryError} when PocketBase refuses or cannot snapshot.
   */
  async backupCreate(name) {
    const client = this._requireClient();
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new MemoryError('MEMORY_INVALID_ARGS', 'a backup needs a name');
    }
    return client.createBackup(name.trim());
  }

  /**
   * The snapshots the sidecar currently holds.
   *
   * @returns the archive descriptors, newest first, or an empty list.
   * @throws {MemoryError} when PocketBase refuses the read.
   */
  async backupList() {
    const client = this._requireClient();
    return client.listBackups();
  }

  /**
   * Remove one archive from the sidecar's own backups directory.
   *
   * @param key - the archive to remove, as returned by {@link backupCreate}.
   * @throws {MemoryError} when PocketBase refuses the delete.
   */
  async backupDelete(key) {
    const client = this._requireClient();
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new MemoryError('MEMORY_INVALID_ARGS', 'a backup key is required');
    }
    await client.deleteBackup(key.trim());
  }

  /**
   * Hand an archive to the sidecar and make it the live database.
   *
   * @param input - the archive and the name to upload it under.
   * @param input.bytes - the archive's bytes, in the sidecar's own layout.
   * @param input.name - the name the sidecar stores it under.
   * @returns the report PocketBase's own backup list would give for it.
   * @throws {MemoryError} when the upload or the restore is refused.
   */
  async backupRestore({ bytes, name }) {
    const client = this._requireClient();
    const key = await client.uploadBackup(bytes, name);
    await client.restoreBackup(key);
    return key;
  }

  /**
   * Report the connection this service resolved to.
   *
   * @returns a one line summary including the collection's record count.
   * @throws {MemoryError} when the sidecar or the collection is missing.
   */
  async health() {
    const client = this._requireClient();
    return `${this.projectId} · ${await client.health()}`;
  }
}

/**
 * Mount the memory service, reporting one line about the resolved connection.
 *
 * @param ctx - the owning Cordis context.
 * @param config - the plugin row's configuration, if any.
 */
export function apply(ctx, config = {}) {
  const service = new PocketBaseMemory(ctx, {
    baseUrl: resolveBaseUrl(config.url),
    identity: setting(config.identity, ENV_IDENTITY),
    password: setting(config.password, ENV_PASSWORD),
    projectId: setting(config.projectId, ENV_PROJECT_ID),
  });

  const announce = config.announce !== false;
  if (announce) {
    if (service.projectId === '') {
      ctx.logger.warn(
        `${name}: no project_id configured; memory tools will answer with an error`,
      );
    } else {
      ctx.logger.info(
        `${name}: project=${service.projectId} backend=${service.target} (connection is verified on first use)`,
      );
    }
  }
}

export { MemoryError };
