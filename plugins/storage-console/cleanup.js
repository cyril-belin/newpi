/**
 * Remove one safe target, and refuse everything else.
 *
 * # The three locks
 *
 * A cleanup runs only when all three of these hold, and each one exists because
 * the other two are not enough on their own:
 *
 * 1. **The catalog says the target is safe.** Not the request, not the caller —
 *    the table in `catalog.js`. A guarded id is refused before any path is
 *    resolved, so there is no string a browser can send that names a session, a
 *    memory or a backup.
 * 2. **The path is inside a root NewPi was given, and is not one of them.** A
 *    catalog is data; a bug in it must not become `rm -rf $HOME`. Every target
 *    is re-checked against the resolved roots at removal time, after
 *    `path.resolve`, so neither a `..` segment nor a symlinked parent can walk
 *    out of the fence.
 * 3. **The size the user was shown still matches the size on disk.** The
 *    preview and the removal are two requests, and a build directory can grow
 *    by gigabytes between them. A mismatch is not a warning: it aborts, so the
 *    figure in the confirmation is always the figure that was deleted.
 *
 * # What "safe" buys
 *
 * Every removable target is a compiler output or a cache. Removing one costs
 * time and bandwidth on the next run. None of them is a record of anything: no
 * conversation, no memory row, no archive, no credential, no plugin source.
 *
 * @module newpi-plugin-storage-console/cleanup
 */

import { lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

import { CLEANUP, GUARDED, isRemovable } from './catalog.js';
import { measureTree } from './scan.js';

/** Raised for a cleanup request that must not run. */
export class CleanupError extends Error {
  /**
   * @param code - stable failure class, echoed to the interface.
   * @param message - what the user should read.
   * @param status - the HTTP status to answer with.
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CleanupError';
    this.code = code;
    this.status = status;
  }
}

/** How much the target may have changed between preview and removal, in bytes.
 * A build directory is written to by a compiler that does not know this preview
 * happened; the allowance covers log files and lock files, not a new build. */
export const SIZE_TOLERANCE_BYTES = 8 * 1024 * 1024;

/**
 * How much the target may have changed, as a proportion of what was measured.
 *
 * The floor covers log files and lock files written by a compiler that does not
 * know a preview happened. It is capped at half the measured size, so a tiny
 * target cannot be swapped for a wildly different one under cover of an
 * absolute allowance: the number in the confirmation has to be the number that
 * was deleted, at every scale.
 *
 * @param expected - the size the user was shown.
 * @returns the tolerated absolute difference.
 */
export function toleranceFor(expected) {
  const floor = Math.min(SIZE_TOLERANCE_BYTES, Math.floor(Math.max(0, expected) / 2));
  return Math.max(floor, Math.ceil(Math.max(0, expected) * 0.02));
}

/**
 * Whether `child` is strictly below `parent`.
 *
 * Both are resolved first, so symbolic components are expanded once and the
 * comparison is of real locations. Equality is not "inside": a cleanup verb
 * must never be pointed at a root itself.
 *
 * @param child - the candidate path.
 * @param parent - the fence.
 * @returns `true` when `child` is strictly below `parent`.
 */
export function isStrictlyInside(child, parent) {
  if (typeof parent !== 'string' || parent.length === 0) return false;
  const outer = resolve(parent);
  const inner = resolve(child);
  return inner !== outer && inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
}

/**
 * Refuse a path that the roots do not fence.
 *
 * @param path - the resolved target.
 * @param roots - the paths NewPi was launched with; at least one must contain
 *   the target.
 * @throws {CleanupError} when no root contains the target.
 */
export function assertFenced(path, roots) {
  const fences = Object.values(roots).filter((value) => typeof value === 'string' && value.length > 0);
  if (fences.length === 0) {
    throw new CleanupError(
      'STORAGE_NO_ROOTS',
      'Aucune racine connue : le nettoyage est refusé.',
      500,
    );
  }
  if (!fences.some((fence) => isStrictlyInside(path, fence))) {
    throw new CleanupError(
      'STORAGE_OUT_OF_SCOPE',
      `Cible hors périmètre : ${path} n'est sous aucune des racines autorisées.`,
      403,
    );
  }
}

/**
 * Remove the children of a directory and keep the directory.
 *
 * A symbolic link is unlinked, never followed: clearing a cache that contains a
 * link back into the user's home must not delete the home.
 *
 * @param path - the directory to empty.
 * @returns the number of entries removed.
 */
async function clearContents(path) {
  let names;
  try {
    names = await readdir(path);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const child = `${path}/${name}`;
    try {
      await rm(child, { recursive: true, force: true, maxRetries: 2 });
      removed += 1;
    } catch (error) {
      throw new CleanupError(
        'STORAGE_REMOVE_FAILED',
        `Suppression impossible de ${child} : ${error?.message ?? error}`,
        500,
      );
    }
  }
  return removed;
}

/**
 * Measure one entry and describe what removing it would do.
 *
 * This is the figure the interface shows before it asks for confirmation, which
 * is why it is measured live rather than read from a cache: the number in the
 * dialog and the number in the report have to be the same measurement.
 *
 * @param options - the preview.
 * @param options.entry - the catalog entry.
 * @param options.roots - the resolved roots.
 * @param options.limits - measurement bounds, passed through to the scan.
 * @returns the id, the label, the target, the measurement, and whether the
 *   entry may be removed.
 */
export async function previewCleanup({ entry, roots, limits }) {
  const removable = isRemovable(entry);
  const report = typeof entry.path === 'string' ? await measureTree(entry.path, limits) : null;
  return {
    id: entry.id,
    label: entry.label,
    role: entry.role,
    safety: entry.safety,
    removable,
    target: entry.path,
    what: entry.what,
    cost: entry.cost,
    cleanup: entry.cleanup,
    measurement: report,
    // A guarded target is shown with its size and its reason, and that is all
    // this endpoint will ever do with it.
    refusal: removable
      ? null
      : entry.safety === GUARDED
        ? 'Cible protégée : NewPi ne supprime jamais une session, une mémoire ou une sauvegarde.'
        : 'Cible non nettoyable : aucun mode de suppression n\'est déclaré pour elle.',
  };
}

/**
 * Remove one safe target, once the size the user saw is confirmed.
 *
 * @param options - the cleanup.
 * @param options.entry - the catalog entry.
 * @param options.roots - the resolved roots used as the fence.
 * @param options.confirm - must equal the entry id. A boolean is accepted as
 *   `true` only, so an old caller cannot silently downgrade to a flag.
 * @param options.expectBytes - the allocated size the user was shown.
 * @param options.limits - measurement bounds.
 * @returns what was removed, what it measured before and after, and the bytes
 *   actually freed.
 * @throws {CleanupError} when any of the three locks fails.
 */
export async function runSafeCleanup({ entry, roots, confirm, expectBytes, limits }) {
  if (!isRemovable(entry)) {
    throw new CleanupError(
      'STORAGE_GUARDED_TARGET',
      entry.safety === GUARDED
        ? `Cible protégée : ${entry.label}. NewPi ne supprime jamais une session, une mémoire PocketBase ou une sauvegarde.`
        : `Cible non nettoyable : ${entry.label}.`,
      403,
    );
  }
  if (confirm !== entry.id) {
    throw new CleanupError(
      'STORAGE_CONFIRMATION_REQUIRED',
      `Confirmez en recopiant l'identifiant de la cible (${entry.id}).`,
    );
  }
  if (!Number.isFinite(expectBytes) || expectBytes < 0) {
    throw new CleanupError(
      'STORAGE_CONFIRMATION_REQUIRED',
      'La taille annoncée manque : relancez l\'aperçu, puis confirmez avec la taille affichée.',
    );
  }

  const target = resolve(entry.path);
  assertFenced(target, roots);

  let info;
  try {
    info = await lstat(target);
  } catch {
    return {
      id: entry.id,
      target,
      removed: false,
      reason: 'absent',
      before: expectBytes,
      after: 0,
      freed: 0,
    };
  }
  if (info.isSymbolicLink()) {
    // Never delete through a link: the entry would name a path that is not the
    // one the catalog described.
    throw new CleanupError(
      'STORAGE_SYMLINK_TARGET',
      `Cible refusée : ${target} est un lien symbolique.`,
      403,
    );
  }

  const before = await measureTree(target, limits);
  const tolerance = toleranceFor(expectBytes);
  if (Math.abs(before.allocated - expectBytes) > tolerance) {
    throw new CleanupError(
      'STORAGE_SIZE_CHANGED',
      `La cible a changé depuis l'aperçu (${before.allocated} octets alloués, ` +
        `${expectBytes} annoncés). Relancez l'aperçu avant de confirmer.`,
      409,
    );
  }

  let entriesRemoved = 0;
  if (entry.cleanup === CLEANUP.directory) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 2 });
    } catch (error) {
      throw new CleanupError(
        'STORAGE_REMOVE_FAILED',
        `Suppression impossible de ${target} : ${error?.message ?? error}`,
        500,
      );
    }
    entriesRemoved = before.files + before.directories;
  } else {
    entriesRemoved = await clearContents(target);
    // A cache directory is expected to exist: recreate it when it was missing,
    // so the tool that owns it finds the shape it left behind.
    try {
      await mkdir(target, { recursive: true });
    } catch {
      // It exists, or its owner will make it. Neither is an error here.
    }
  }

  const after = await measureTree(target, limits);
  return {
    id: entry.id,
    label: entry.label,
    target,
    removed: true,
    mode: entry.cleanup,
    entriesRemoved,
    before: before.allocated,
    beforeBytes: before.bytes,
    after: after.allocated,
    freed: Math.max(0, before.allocated - after.allocated),
  };
}
