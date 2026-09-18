/**
 * A fake PocketBase instance for the memory tests.
 *
 * It speaks the REST calls the memory client and the console make — superuser
 * authentication, create, list with a filter and a projection, count, delete,
 * and the whole `/api/backups` family — against an in-memory store. It
 * deliberately implements PocketBase's filter *semantics*
 * (`project_id = '...' && kind = '...' && content ~ '...'`) rather than
 * ignoring the filter, because the project scope is the property under test:
 * a fake that returned every row regardless of the filter would let a broken
 * scope check pass.
 *
 * The backup endpoints are real enough to be worth having: asking for a
 * snapshot writes an actual zip into a snapshot directory, and restoring reads
 * it back and replaces the store. That is what lets the console's transaction —
 * snapshot, delete, restore, verify — be tested without a sidecar, leaving the
 * real binary to prove the parts only it can (`tests/backup-live.mjs`).
 *
 * It is not a PocketBase emulator. The data file it snapshots is a real file
 * with SQLite's header and a JSON payload after it, not a database: the console
 * checks the header before it will touch anything, and nothing here parses SQL.
 *
 * @module newpi-plugin-pocketbase-memory/tests/fake-pocketbase
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

/** The 16 bytes every SQLite file starts with. The console refuses an archive
 * whose database does not begin with them, so the fake writes them too. */
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

/** Matches the seeded superuser identity the tests configure. */
export const TEST_IDENTITY = 'newpi-test@local.test';
/** Matches the seeded superuser password the tests configure. */
export const TEST_PASSWORD = 'newpi-test-password';

/** Split a PocketBase filter on a separator that is outside any quotes. */
function splitOutsideQuotes(input, separator) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "'") {
      if (quoted && input[index + 1] === "'") {
        current += "''";
        index += 1;
        continue;
      }
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted && input.startsWith(separator, index)) {
      parts.push(current);
      current = '';
      index += separator.length - 1;
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

/** Decode one single-quoted PocketBase literal, including escaped quotes. */
function unquote(literal, { doubleBackslash = false } = {}) {
  const trimmed = literal.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) return null;
  let value = trimmed.slice(1, -1).replaceAll("''", "'");
  if (doubleBackslash) value = value.replaceAll('\\\\', '\\');
  return value;
}

/**
 * Evaluate the subset of the PocketBase filter language the memory client
 * emits, against one record.
 *
 * @param filter - the filter expression.
 * @param record - the candidate record.
 * @returns whether the record matches.
 * @throws {Error} when the filter uses a form this fake does not implement,
 * so an unimplemented clause fails the test instead of silently matching.
 */
export function matchesFilter(filter, record) {
  if (filter.trim().length === 0) return true;
  return splitOutsideQuotes(filter, '&&').every((clause) => {
    const text = clause.trim();
    const equal = text.match(/^([a-z_]+)\s*=\s*('(?:[^']|'')*')$/);
    if (equal !== null) return record[equal[1]] === unquote(equal[2]);
    const like = text.match(/^([a-z_]+)\s*~\s*('(?:[^']|'')*')$/);
    if (like !== null) {
      const needle = unquote(like[2], { doubleBackslash: true });
      const haystack = String(record[like[1]] ?? '');
      // SQL LIKE semantics: `%` and `_` are wildcards, matching is
      // case-insensitive for ASCII, and a newline in the value is ordinary
      // content — hence the `s` flag on the translated pattern.
      const pattern = needle
        .replace(/\\([\\%_])/g, '\u0000$1')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('\u0000%', '%')
        .replaceAll('\u0000_', '_')
        .replaceAll('%', '.*')
        .replaceAll('_', '.')
        .replaceAll('\u0000', '\\');
      return new RegExp(`^${pattern}$`, 'is').test(haystack);
    }
    throw new Error(`fake PocketBase does not implement filter clause: ${text}`);
  });
}

/**
 * Start the fake instance on an ephemeral loopback port.
 *
 * @param options - the fake's options.
 * @param options.snapshots - the directory the fake writes its snapshots into.
 *   When absent, a directory below the system temporary directory is created so
 *   the backup endpoints still work.
 * @returns handles to drive and stop it.
 */
export async function startFakePocketBase(options = {}) {
  /** Every stored record, in creation order. */
  const records = [];
  /**
   * Protocol state. `activeToken` is the only bearer value the fake accepts,
   * and `rejectToken` invalidates one named token — which is how a test forces
   * the client's 401-and-retry path.
   */
  const state = {
    logins: 0,
    requests: 0,
    activeToken: '',
    rejectToken: null,
    /** Mints the bearer value one login returns. */
    tokenIssuer: () => 'fake-token',
    /** Every snapshot the fake has been asked for, newest last. */
    snapshots: [],
    /** How many times the fake was asked to replace its store. */
    restores: 0,
  };

  const snapshots =
    options.snapshots ?? join(process.env.TMPDIR ?? '/tmp', `newpi-fake-backups-${process.pid}`);
  await mkdir(snapshots, { recursive: true });

  /** Write one record set as the fake's database file. */
  const databaseBytes = () =>
    Buffer.concat([SQLITE_HEADER, Buffer.from(JSON.stringify(records), 'utf8')]);

  /**
   * Snapshot the store the way PocketBase does: it writes a zip of the data
   * files into its own backups directory, under the name it was given.
   */
  async function writeSnapshot(name) {
    const staging = join(snapshots, `.staging-${name}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'data.db'), databaseBytes());
    await writeFile(join(staging, 'auxiliary.db'), Buffer.concat([SQLITE_HEADER, Buffer.from('{}')]));
    await writeFile(join(staging, 'types.d.ts'), '// the fake has no types\n');
    await new Promise((resolve, reject) => {
      const zip = spawn('/usr/bin/zip', ['-q', '-r', '-X', join(snapshots, name), '.'], {
        cwd: staging,
      });
      zip.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`zip exited ${code}`))));
    });
    await rm(staging, { recursive: true, force: true });
    const size = (await readFile(join(snapshots, name))).byteLength;
    state.snapshots.push({ key: name, size, modified: new Date().toISOString() });
    return { key: name, size };
  }

  /**
   * Replace the store from one snapshot, the way PocketBase's own restore does:
   * the database file becomes the store.
   */
  async function restoreSnapshot(name) {
    const staging = join(snapshots, `.restore-${name}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    await new Promise((resolve, reject) => {
      const unzip = spawn('/usr/bin/unzip', ['-o', '-q', join(snapshots, name), '-d', staging]);
      unzip.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`))));
    });
    const bytes = await readFile(join(staging, 'data.db'));
    await rm(staging, { recursive: true, force: true });
    records.splice(0, records.length, ...JSON.parse(bytes.subarray(SQLITE_HEADER.length).toString('utf8')));
    state.restores += 1;
  }

  const server = createServer((request, response) => {
    state.requests += 1;
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const isJson = (request.headers['content-type'] ?? '').includes('application/json');
      const body = isJson && raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null;
      const send = (status, payload) => {
        const text = payload === undefined ? '' : JSON.stringify(payload);
        response.writeHead(status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        });
        response.end(text);
      };

      if (url.pathname === '/api/collections/_superusers/auth-with-password') {
        if (body?.identity !== TEST_IDENTITY || body?.password !== TEST_PASSWORD) {
          send(400, { status: 400, message: 'Failed to authenticate.' });
          return;
        }
        state.logins += 1;
        // PocketBase signs tokens with the app's secret, so a second login on
        // the same instance returns the same bearer value. `tokenIssuer` lets a
        // test model a restart that mints a different one.
        state.activeToken = state.tokenIssuer();
        send(200, { token: state.activeToken });
        return;
      }

      if (url.pathname === '/api/health') {
        send(200, { message: 'API is healthy.', code: 200, data: {} });
        return;
      }

      // Everything past this point is superuser-only, as it is in PocketBase.
      const presented = request.headers.authorization;
      if (presented === undefined || presented.length === 0) {
        // No credential at all: PocketBase answers 403, not 401.
        send(403, { status: 403, message: 'Only superusers can perform this action.' });
        return;
      }
      const accepted = presented === state.activeToken && presented !== state.rejectToken;
      if (!accepted) {
        // A stale or unknown bearer token: PocketBase answers 401, which is
        // what makes the client re-authenticate exactly once.
        send(401, { status: 401, message: 'The request requires valid record authorization token.' });
        return;
      }

      try {
        if (url.pathname === '/api/backups' && request.method === 'GET') {
          send(200, state.snapshots);
          return;
        }
        if (url.pathname === '/api/backups' && request.method === 'POST') {
          const key = typeof body?.name === 'string' && body.name.length > 0 ? body.name : 'backup.zip';
          const created = await writeSnapshot(key);
          send(200, created);
          return;
        }
        if (url.pathname === '/api/backups/upload' && request.method === 'POST') {
          // The upload is a multipart body: the fake reads the boundary out of
          // the request and takes everything between the part's headers and the
          // closing boundary as the archive.
          const boundary = /boundary=([^;]+)/.exec(request.headers['content-type'] ?? '')?.[1];
          const name =
            /filename="([^"]+)"/.exec(raw.toString('latin1', 0, 512))?.[1] ?? 'upload.zip';
          const start = raw.indexOf('\r\n\r\n');
          const closing = Buffer.from(`\r\n--${boundary}--`);
          const end = raw.indexOf(closing, start);
          await writeFile(
            join(snapshots, name),
            raw.subarray(start + 4, end === -1 ? raw.length : end),
          );
          state.snapshots.push({ key: name, size: raw.byteLength, modified: new Date().toISOString() });
          send(200, { key: name });
          return;
        }
        if (url.pathname.startsWith('/api/backups/') && url.pathname.endsWith('/restore')) {
          const key = decodeURIComponent(url.pathname.slice('/api/backups/'.length, -'/restore'.length));
          await restoreSnapshot(key);
          send(204);
          return;
        }
        if (url.pathname.startsWith('/api/backups/') && request.method === 'DELETE') {
          const key = decodeURIComponent(url.pathname.slice('/api/backups/'.length));
          await rm(join(snapshots, key), { force: true });
          state.snapshots = state.snapshots.filter((entry) => entry.key !== key);
          send(204);
          return;
        }
      } catch (error) {
        send(500, { status: 500, message: String(error?.message ?? error) });
        return;
      }

      if (
        url.pathname === '/api/collections/memories/records' ||
        url.pathname.startsWith('/api/collections/memories/records/')
      ) {
        if (request.method === 'GET' && url.pathname.endsWith('/records')) {
          const filter = url.searchParams.get('filter') ?? '';
          const perPage = Number(url.searchParams.get('perPage') ?? '30');
          const page = Number(url.searchParams.get('page') ?? '1');
          const fields = url.searchParams.get('fields');
          const matching = records
            .filter((record) => matchesFilter(filter, record))
            .sort((left, right) =>
              right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id),
            );
          const items = matching.slice((page - 1) * perPage, page * perPage).map((record) => {
            if (fields === null || fields === undefined) return record;
            // PocketBase returns only the requested columns, which is the whole
            // point of the console asking for a projection.
            return Object.fromEntries(
              fields
                .split(',')
                .map((name) => name.trim())
                .filter((name) => name.length > 0)
                .map((name) => [name, record[name]]),
            );
          });
          send(200, {
            page,
            perPage,
            totalItems: matching.length,
            totalPages: Math.max(1, Math.ceil(matching.length / perPage)),
            items,
          });
          return;
        }

        if (request.method === 'POST' && url.pathname.endsWith('/records')) {
          const record = {
            id: `rec${String(records.length + 1).padStart(4, '0')}`,
            collectionId: 'fake',
            collectionName: 'memories',
            content: body.content,
            project_id: body.project_id,
            kind: body.kind,
            created_at: new Date(Date.now() + records.length).toISOString(),
            updated_at: new Date(Date.now() + records.length).toISOString(),
          };
          records.push(record);
          send(200, record);
          return;
        }

        if (request.method === 'DELETE') {
          const id = decodeURIComponent(url.pathname.split('/').pop());
          const index = records.findIndex((record) => record.id === id);
          if (index < 0) {
            send(404, { status: 404, message: 'The requested resource wasn\'t found.' });
            return;
          }
          records.splice(index, 1);
          send(204);
          return;
        }
      }

      send(404, { status: 404, message: 'The requested resource wasn\'t found.' });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    /** Every record the fake currently holds, for isolation assertions. */
    records,
    /** Counters and knobs for protocol-level assertions. */
    state,
    /** The directory the fake writes its snapshots into. */
    snapshots,
    /** Stop the fake. */
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await rm(snapshots, { recursive: true, force: true });
    },
  };
}
