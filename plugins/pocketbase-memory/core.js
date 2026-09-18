/**
 * The memory vocabulary shared by both plugins.
 *
 * This module is deliberately free of imports: it holds the one definition of
 * what a memory is, so the backend and the tools can never disagree about the
 * accepted `kind` values or the shape of a returned memory.
 *
 * @module newpi-plugin-pocketbase-memory/core
 */

/** The only `kind` values a memory may carry. Kept in sync with the values
 * documented in the versioned PocketBase migration. */
export const MEMORY_KINDS = ['note', 'decision', 'bugfix', 'lesson'];

/** The same vocabulary as a runtime set, for O(1) narrowing. */
const KIND_SET = new Set(MEMORY_KINDS);

/** Largest accepted `content`, in bytes of UTF-8. Well under PocketBase's own
 * `max` on the field; the bound exists so a runaway paste fails at the tool
 * boundary with a readable message instead of a PocketBase validation error. */
export const MAX_CONTENT_BYTES = 64 * 1024;

/** Largest number of memories one `recall` may return. */
export const MAX_RECALL_LIMIT = 50;

/** Default number of memories one `recall` returns. */
export const DEFAULT_RECALL_LIMIT = 8;

/** Smallest accepted `project_id`. */
export const MIN_PROJECT_ID_LENGTH = 1;

/** Largest accepted `project_id`. Kept in sync with the migration's `max`. */
export const MAX_PROJECT_ID_LENGTH = 200;

/**
 * Error raised by the memory backend. The `code` is the stable discriminant
 * callers may switch on; `message` is diagnostic prose meant for the model.
 */
export class MemoryError extends Error {
  /**
   * @param code - stable failure class.
   * @param message - human readable detail.
   * @param options - standard error options (`cause`).
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'MemoryError';
    this.code = code;
  }
}

/**
 * Assert that a value is one of {@link MEMORY_KINDS}.
 *
 * @param value - candidate kind.
 * @returns the kind, narrowed.
 * @throws {MemoryError} when the value is not a known kind.
 */
export function assertKind(value) {
  if (typeof value !== 'string' || !KIND_SET.has(value)) {
    throw new MemoryError(
      'MEMORY_INVALID_KIND',
      `kind must be one of ${MEMORY_KINDS.join(', ')} (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * Assert that a value is a usable `project_id`.
 *
 * The value never reaches this module from a tool argument: it is read once
 * from the project's own configuration, so this is a typo guard, not a trust
 * boundary.
 *
 * @param value - candidate project identifier.
 * @returns the trimmed identifier.
 * @throws {MemoryError} when the value is missing or too long.
 */
export function assertProjectId(value) {
  if (typeof value !== 'string' || value.trim().length < MIN_PROJECT_ID_LENGTH) {
    throw new MemoryError(
      'MEMORY_INVALID_PROJECT',
      'project_id is empty; set memory.project_id in the project cordis.yml',
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_PROJECT_ID_LENGTH) {
    throw new MemoryError(
      'MEMORY_INVALID_PROJECT',
      `project_id is longer than ${MAX_PROJECT_ID_LENGTH} characters`,
    );
  }
  return trimmed;
}

/**
 * Assert that a value is usable memory content.
 *
 * @param value - candidate content.
 * @returns the content with surrounding whitespace removed.
 * @throws {MemoryError} when the value is empty or over the byte budget.
 */
export function assertContent(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryError('MEMORY_EMPTY_CONTENT', 'content must be a non-empty string');
  }
  const trimmed = value.trim();
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  if (bytes > MAX_CONTENT_BYTES) {
    throw new MemoryError(
      'MEMORY_CONTENT_TOO_LARGE',
      `content is ${bytes} bytes, over the ${MAX_CONTENT_BYTES} byte limit`,
    );
  }
  return trimmed;
}

/**
 * Normalize a caller supplied `limit` for `recall`.
 *
 * @param value - candidate limit; `undefined` selects the default.
 * @returns an integer between 1 and {@link MAX_RECALL_LIMIT}.
 * @throws {MemoryError} when the value is not a positive integer.
 */
export function assertLimit(value) {
  if (value === undefined || value === null) return DEFAULT_RECALL_LIMIT;
  if (!Number.isInteger(value) || value < 1) {
    throw new MemoryError(
      'MEMORY_INVALID_LIMIT',
      `limit must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
  return Math.min(value, MAX_RECALL_LIMIT);
}

/**
 * Normalize an optional `kind` filter.
 *
 * @param value - candidate kind; `undefined` and `null` mean "every kind".
 * @returns the kind, or `undefined` when no filter applies.
 * @throws {MemoryError} when the value is present but not a known kind.
 */
export function optionalKind(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return assertKind(value);
}

/**
 * Project one PocketBase record onto the memory shape this package exposes.
 *
 * PocketBase owns `id` and `created_at`; everything else is ours. Unknown keys
 * are dropped so a later PocketBase version cannot leak new columns into a
 * model-facing tool result.
 *
 * @param record - a decoded PocketBase record.
 * @returns the memory, or `null` when the record is not a usable one.
 */
export function toMemory(record) {
  if (record === null || typeof record !== 'object') return null;
  const { id, content, project_id: projectId, kind, created_at: createdAt } = record;
  if (typeof id !== 'string' || typeof content !== 'string') return null;
  if (typeof projectId !== 'string' || typeof kind !== 'string') return null;
  return {
    id,
    content,
    project_id: projectId,
    kind,
    created_at: typeof createdAt === 'string' ? createdAt : '',
  };
}

/** Longest preview the console renders for one memory, in characters. */
export const MAX_PREVIEW_CHARS = 240;

/**
 * Project one PocketBase record onto the listing shape the console renders.
 *
 * A listing must not carry the content: the console shows a preview, and a
 * memory list of two hundred rows would otherwise cross the wire as two hundred
 * full documents. The projection is applied to the *request* as well (see
 * `PocketBaseMemories#page`), so the content never leaves PocketBase for a row
 * that is only being listed.
 *
 * @param record - a decoded PocketBase record, content optional.
 * @returns the listing row, or `null` when the record is not a usable one.
 */
export function toMemorySummary(record) {
  if (record === null || typeof record !== 'object') return null;
  const { id, content, kind, created_at: createdAt } = record;
  if (typeof id !== 'string' || typeof kind !== 'string') return null;
  const text = typeof content === 'string' ? content : '';
  return {
    id,
    kind,
    created_at: typeof createdAt === 'string' ? createdAt : '',
    preview: previewOf(text),
    characters: text.length,
  };
}

/**
 * Collapse a memory's text into one short line for a listing.
 *
 * Newlines and runs of whitespace become single spaces, and the result is
 * truncated on a word boundary when one is close enough to the limit — a
 * preview cut mid-word reads like a bug rather than like an excerpt.
 *
 * @param content - the memory's full text.
 * @returns the preview, at most {@link MAX_PREVIEW_CHARS} characters.
 */
export function previewOf(content) {
  const flat = String(content).replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_PREVIEW_CHARS) return flat;
  const clipped = flat.slice(0, MAX_PREVIEW_CHARS);
  const space = clipped.lastIndexOf(' ');
  return `${space > MAX_PREVIEW_CHARS - 40 ? clipped.slice(0, space) : clipped}…`;
}

/**
 * Normalize a PocketBase timestamp for the interface.
 *
 * PocketBase writes `2026-09-12 20:55:47.983Z` — a space where ISO 8601 puts a
 * `T`. Everything that displays or sorts a timestamp goes through here, so the
 * interface never has to know which spelling it received.
 *
 * @param value - the PocketBase timestamp.
 * @returns an ISO 8601 string, or `''` when the value is not a timestamp.
 */
export function toIsoTimestamp(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return '';
  const text = value.trim().replace(' ', 'T');
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}
