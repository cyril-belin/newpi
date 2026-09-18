/**
 * A minimal PocketBase REST client for the `memories` collection.
 *
 * Only the calls this feature needs exist here: authenticate, create one
 * record, list records matching a filter, read one record, delete one record.
 * No SDK, no collection discovery, no schema writes — the collection itself
 * belongs to the versioned migration, never to this client.
 *
 * The client is transport-honest: every failure becomes a {@link MemoryError}
 * whose `code` distinguishes "the sidecar is not reachable" from "PocketBase
 * refused the call", because those two need different words in front of a
 * model and a human.
 *
 * @module newpi-plugin-pocketbase-memory/client
 */

import { MemoryError } from './core.js';

/** Transport timeout for one request. The sidecar is on loopback: a call that
 * takes longer than this is a stuck process, not a slow network. */
const REQUEST_TIMEOUT_MS = 10_000;

/** PocketBase's own page size ceiling. */
const MAX_PER_PAGE = 500;

/** PocketBase's own page size floor. A page of zero records is rejected by the
 * API, so the console's `perPage` is clamped here rather than at every caller. */
const MIN_PER_PAGE = 1;

/** How long one backup archive may take to be produced or restored. The
 * default request timeout is sized for a record call; a full database snapshot
 * of a few hundred megabytes on a busy machine is not that. */
const BACKUP_TIMEOUT_MS = 120_000;

/**
 * Render one value as a PocketBase filter literal.
 *
 * PocketBase quotes string literals with single quotes and escapes an embedded
 * quote by doubling it. This is the only escaping the filter language offers,
 * so it is done in exactly one place.
 *
 * @param value - the raw string.
 * @returns the quoted and escaped literal.
 */
export function filterLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * A PocketBase filter expressing `content` LIKE `%query%`, escaped for the
 * filter language.
 *
 * Backslashes are doubled because PocketBase also treats `\` as an escape
 * inside a string literal. Dollar-quoting in the underlying SQL is not
 * reachable from a filter expression, so this pair is the whole story.
 *
 * @param query - the raw user query.
 * @returns the LIKE operand, quoted.
 */
export function likeLiteral(query) {
  const escaped = String(query)
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
  return filterLiteral(`%${escaped}%`);
}

/** The collection name from the versioned migration. */
export const MEMORIES_COLLECTION = 'memories';

/**
 * One PocketBase connection for one project scope.
 *
 * The credential is a PocketBase superuser, so the collection's own API rules
 * can stay closed to everyone else: this client is the only reader and writer,
 * and it runs inside the user's machine.
 */
export class PocketBaseMemories {
  #baseUrl;
  #identity;
  #password;
  #token = '';
  #authInFlight = null;

  /**
   * @param options - connection settings resolved from the environment.
   * @param options.baseUrl - loopback base URL, without a trailing slash.
   * @param options.identity - superuser identity (email).
   * @param options.password - superuser password.
   */
  constructor({ baseUrl, identity, password }) {
    this.#baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.#identity = identity;
    this.#password = password;
  }

  /** The loopback base URL this client talks to, for diagnostics. */
  get baseUrl() {
    return this.#baseUrl;
  }

  /**
   * Perform one authenticated JSON request, authenticating on first use and
   * re-authenticating once when the cached token is rejected.
   *
   * @param path - path below the base URL, starting with `/`.
   * @param options - request options.
   * @param options.method - HTTP method; defaults to GET.
   * @param options.body - JSON request body.
   * @param options.rawBody - raw request body, used instead of `body` for the
   *   one multipart call this client makes (a backup archive upload).
   * @param options.contentType - `content-type` for `rawBody`.
   * @param options.query - query string parameters; empty values are dropped.
   * @param options.timeoutMs - request timeout; defaults to ten seconds.
   * @param options.retryOnAuth - whether a 401 may be retried once; internal.
   * @returns the decoded response body, or `null` for an empty body.
   * @throws {MemoryError} on any transport or protocol failure.
   */
  async #request(path, options = {}) {
    const {
      method = 'GET',
      body,
      rawBody,
      contentType,
      query,
      timeoutMs = REQUEST_TIMEOUT_MS,
      retryOnAuth = true,
    } = options;
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    const token = await this.#authenticate();
    const headers = { accept: 'application/json' };
    if (token !== '') headers.authorization = token;
    if (rawBody !== undefined) headers['content-type'] = contentType;
    else if (body !== undefined) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body:
          rawBody !== undefined
            ? rawBody
            : body === undefined
              ? undefined
              : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new MemoryError(
        'MEMORY_UNREACHABLE',
        `PocketBase does not answer at ${this.#baseUrl}: ${error.message}`,
        { cause: error },
      );
    }

    if (response.status === 401 && retryOnAuth) {
      this.#token = '';
      return this.#request(path, { ...options, retryOnAuth: false });
    }

    if (response.status === 204) return null;

    const text = await response.text();
    let payload = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch (error) {
        throw new MemoryError(
          'MEMORY_PROTOCOL',
          `PocketBase answered ${response.status} with a body that is not JSON`,
          { cause: error },
        );
      }
    }

    if (!response.ok) {
      const detail =
        typeof payload?.message === 'string' && payload.message.length > 0
          ? payload.message
          : response.statusText;
      throw new MemoryError(
        'MEMORY_REQUEST_FAILED',
        `PocketBase refused ${method} ${path} with ${response.status}: ${detail}`,
      );
    }

    return payload;
  }

  /**
   * Resolve a usable superuser token, authenticating only when needed.
   *
   * @returns the `Authorization` header value, or `''` when no credential is
   * configured at all (which leaves the request unauthenticated on purpose, so
   * the resulting 403 is reported instead of a fabricated local error).
   * @throws {MemoryError} when authentication itself fails.
   */
  async #authenticate() {
    if (this.#token !== '') return this.#token;
    if (this.#identity === '' || this.#password === '') return '';
    if (this.#authInFlight === null) {
      this.#authInFlight = this.#login().finally(() => {
        this.#authInFlight = null;
      });
    }
    return this.#authInFlight;
  }

  /** Exchange the configured credential for a superuser token. */
  async #login() {
    const url = new URL(`${this.#baseUrl}/api/collections/_superusers/auth-with-password`);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ identity: this.#identity, password: this.#password }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MemoryError(
        'MEMORY_UNREACHABLE',
        `PocketBase does not answer at ${this.#baseUrl}: ${error.message}`,
        { cause: error },
      );
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok || typeof payload?.token !== 'string' || payload.token === '') {
      const detail =
        typeof payload?.message === 'string' ? payload.message : `${response.status}`;
      throw new MemoryError(
        'MEMORY_AUTH_FAILED',
        `PocketBase rejected the local superuser credential: ${detail}`,
      );
    }
    this.#token = payload.token;
    return this.#token;
  }

  /**
   * Report whether the sidecar answers and the collection exists.
   *
   * @returns a diagnostic string naming the collection and its record count.
   * @throws {MemoryError} when the sidecar or the collection is missing.
   */
  async health() {
    const payload = await this.#request(
      `/api/collections/${MEMORIES_COLLECTION}/records`,
      { query: { perPage: 1, fields: 'id' } },
    );
    const total = typeof payload?.totalItems === 'number' ? payload.totalItems : 0;
    return `${this.#baseUrl} · collection ${MEMORIES_COLLECTION} · ${total} record(s)`;
  }

  /**
   * Store one memory.
   *
   * @param memory - the record to create.
   * @param memory.content - memory text, already validated.
   * @param memory.projectId - the configured project scope.
   * @param memory.kind - one of the memory kinds.
   * @returns the stored memory, including PocketBase's `id` and `created_at`.
   * @throws {MemoryError} when PocketBase refuses the write.
   */
  async remember({ content, projectId, kind }) {
    const record = await this.#request(`/api/collections/${MEMORIES_COLLECTION}/records`, {
      method: 'POST',
      body: { content, project_id: projectId, kind },
    });
    return record;
  }

  /**
   * Read memories of one project, newest first.
   *
   * The project scope is part of the filter, never a post-filter: a query can
   * only ever see rows that already belong to `projectId`.
   *
   * @param options - the query.
   * @param options.projectId - the configured project scope.
   * @param options.query - optional full-text fragment; empty selects the newest.
   * @param options.kind - optional kind filter.
   * @param options.limit - maximum rows to return.
   * @returns the matching records, newest first.
   * @throws {MemoryError} when PocketBase refuses the read.
   */
  async recall({ projectId, query, kind, limit }) {
    const clauses = [`project_id = ${filterLiteral(projectId)}`];
    if (kind !== undefined) clauses.push(`kind = ${filterLiteral(kind)}`);
    if (typeof query === 'string' && query.trim().length > 0) {
      clauses.push(`content ~ ${likeLiteral(query.trim())}`);
    }

    const payload = await this.#request(`/api/collections/${MEMORIES_COLLECTION}/records`, {
      query: {
        filter: clauses.join(' && '),
        sort: '-created_at,-id',
        perPage: Math.min(limit, MAX_PER_PAGE),
        skipTotal: 1,
      },
    });

    return Array.isArray(payload?.items) ? payload.items : [];
  }

  /**
   * Read one page of a project's memories, with the total row count.
   *
   * `recall` deliberately skips the total and caps the page at the model's
   * `limit`; the console needs the opposite, so it has its own call rather than
   * a flag on `recall`: the model-facing path must not start paying for a
   * `COUNT(*)` it never reads.
   *
   * @param options - the query.
   * @param options.projectId - the configured project scope.
   * @param options.query - optional full-text fragment.
   * @param options.kind - optional kind filter.
   * @param options.page - 1-based page number.
   * @param options.perPage - records per page, clamped to PocketBase's bounds.
   * @param options.fields - the projection; the console asks for metadata only
   *   when it lists, and for the content when it opens one memory.
   * @returns the page's records, oldest last, and the total matching the filter.
   * @throws {MemoryError} when PocketBase refuses the read.
   */
  async page({ projectId, query, kind, page = 1, perPage = 20, fields }) {
    const clauses = [`project_id = ${filterLiteral(projectId)}`];
    if (kind !== undefined) clauses.push(`kind = ${filterLiteral(kind)}`);
    if (typeof query === 'string' && query.trim().length > 0) {
      clauses.push(`content ~ ${likeLiteral(query.trim())}`);
    }

    const payload = await this.#request(`/api/collections/${MEMORIES_COLLECTION}/records`, {
      query: {
        filter: clauses.join(' && '),
        sort: '-created_at,-id',
        page: Math.max(1, Math.trunc(page)),
        perPage: Math.min(Math.max(1, Math.trunc(perPage)), MAX_PER_PAGE),
        fields,
      },
    });

    return {
      items: Array.isArray(payload?.items) ? payload.items : [],
      total: Number.isFinite(payload?.totalItems) ? payload.totalItems : 0,
    };
  }

  /**
   * Count the memories of one project, or of every project.
   *
   * The unscoped form exists for one caller and one purpose: comparing the
   * database against the manifest of a backup being restored. Nothing else in
   * NewPi asks for a cross-project figure, and the console never renders one.
   *
   * @param options - the query.
   * @param options.projectId - the project scope; omit to count every row. The
   *   scope is applied to the request, never to a result the caller filtered.
   * @param options.kind - optional kind filter.
   * @returns the number of matching rows.
   * @throws {MemoryError} when PocketBase refuses the read.
   */
  async count({ projectId, kind } = {}) {
    const clauses = [];
    if (typeof projectId === 'string' && projectId.length > 0) {
      clauses.push(`project_id = ${filterLiteral(projectId)}`);
    }
    if (kind !== undefined) clauses.push(`kind = ${filterLiteral(kind)}`);

    const payload = await this.#request(`/api/collections/${MEMORIES_COLLECTION}/records`, {
      query: {
        filter: clauses.length > 0 ? clauses.join(' && ') : undefined,
        perPage: MIN_PER_PAGE,
        fields: 'id',
      },
    });
    return Number.isFinite(payload?.totalItems) ? payload.totalItems : 0;
  }

  /**
   * The timestamp of a project's most recent memory.
   *
   * @param projectId - the configured project scope.
   * @returns the PocketBase timestamp, or `null` when the project has none.
   * @throws {MemoryError} when PocketBase refuses the read.
   */
  async newest(projectId) {
    const payload = await this.#request(`/api/collections/${MEMORIES_COLLECTION}/records`, {
      query: {
        filter: `project_id = ${filterLiteral(projectId)}`,
        sort: '-created_at,-id',
        perPage: MIN_PER_PAGE,
        fields: 'created_at',
      },
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const stamp = items[0]?.created_at;
    return typeof stamp === 'string' && stamp.length > 0 ? stamp : null;
  }

  /**
   * Ask PocketBase to snapshot its own database.
   *
   * This is the official mechanism, and the only one NewPi ever uses to read
   * the database as a file: PocketBase writes a consistent archive of `data.db`
   * and `auxiliary.db` into `pb_data/backups/` while it holds the write lock
   * itself. NewPi never copies `data.db` behind the running server's back.
   *
   * @param name - the archive name PocketBase stores it under.
   * @returns the created archive's key, or the name it was asked for.
   * @throws {MemoryError} when PocketBase refuses or cannot write the snapshot.
   */
  async createBackup(name) {
    const payload = await this.#request('/api/backups', {
      method: 'POST',
      body: { name },
      timeoutMs: BACKUP_TIMEOUT_MS,
    });
    const key = payload?.key;
    return typeof key === 'string' && key.length > 0 ? key : name;
  }

  /**
   * The snapshots PocketBase currently holds, newest first.
   *
   * @returns the archive descriptors, or an empty list when there are none.
   * @throws {MemoryError} when PocketBase refuses the read.
   */
  async listBackups() {
    const payload = await this.#request('/api/backups');
    return Array.isArray(payload) ? payload : [];
  }

  /**
   * Hand PocketBase an archive to restore from.
   *
   * The multipart body is built here rather than through `FormData`, because
   * the bytes are already in memory and a hand-built body keeps this client
   * dependency-free and byte-exact.
   *
   * @param bytes - the archive's bytes.
   * @param filename - the name PocketBase stores it under, used as the key of
   *   the restore call that follows.
   * @returns the stored archive's key.
   * @throws {MemoryError} when PocketBase refuses the upload.
   */
  async uploadBackup(bytes, filename) {
    const boundary = `----newpi${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `content-disposition: form-data; name="file"; filename="${filename.replaceAll('"', '')}"\r\n` +
        `content-type: application/zip\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const payload = await this.#request('/api/backups/upload', {
      method: 'POST',
      rawBody: Buffer.concat([head, bytes, tail]),
      contentType: `multipart/form-data; boundary=${boundary}`,
      timeoutMs: BACKUP_TIMEOUT_MS,
    });
    const key = payload?.key;
    return typeof key === 'string' && key.length > 0 ? key : filename;
  }

  /**
   * Remove one archive from the sidecar's own backups directory.
   *
   * NewPi uses this to clean up after itself: the snapshot it exported into a
   * NewPi archive has no further use, and `pb_data/backups` is PocketBase's
   * directory to keep tidy.
   *
   * @param key - the archive to remove.
   * @throws {MemoryError} when PocketBase refuses the delete.
   */
  async deleteBackup(key) {
    await this.#request(`/api/backups/${encodeURIComponent(key)}`, { method: 'DELETE' });
  }

  /**
   * Replace the live database with one of the archives PocketBase holds.
   *
   * PocketBase restarts itself in place: the process keeps its pid and its
   * port, and the HTTP call returns before the restart completes, so a caller
   * that needs a serving database must poll the health endpoint afterwards.
   *
   * @param key - the archive to restore, as listed by {@link listBackups}.
   * @throws {MemoryError} when PocketBase refuses the restore.
   */
  async restoreBackup(key) {
    await this.#request(`/api/backups/${encodeURIComponent(key)}/restore`, {
      method: 'POST',
      timeoutMs: BACKUP_TIMEOUT_MS,
    });
  }

  /**
   * Read one memory, but only inside one project.
   *
   * @param id - the record id.
   * @param projectId - the configured project scope.
   * @returns the record, or `null` when it does not exist in this project.
   * @throws {MemoryError} when PocketBase refuses the read.
   */
  async find(id, projectId) {
    const payload = await this.#request(`/api/collections/${MEMORIES_COLLECTION}/records`, {
      query: {
        filter: `id = ${filterLiteral(id)} && project_id = ${filterLiteral(projectId)}`,
        perPage: 1,
      },
    });
    const items = Array.isArray(payload?.items) ? payload.items : [];
    return items.length > 0 ? items[0] : null;
  }

  /**
   * Delete one memory inside one project.
   *
   * @param id - the record id.
   * @param projectId - the configured project scope.
   * @returns `true` when a row was deleted, `false` when it does not exist
   * inside this project.
   * @throws {MemoryError} when PocketBase refuses the delete.
   */
  async forget(id, projectId) {
    const existing = await this.find(id, projectId);
    if (existing === null) return false;
    await this.#request(`/api/collections/${MEMORIES_COLLECTION}/records/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return true;
  }
}
