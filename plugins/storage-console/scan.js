/**
 * Measure a directory tree without ever following a link out of it.
 *
 * # Why this is not `du`
 *
 * The number this module reports has to be defensible, because a person reads
 * it and then decides to delete something. `du` is fast, but its answer is a
 * string formatted for a terminal. This module reports the same two quantities
 * `du` reports, computed on this side of the fence so a test can pin them:
 *
 * - **allocated** — `st_blocks * 512`, what the filesystem actually spends.
 *   This is the number that answers "why is my disk full".
 * - **bytes** — `st_size` summed, the logical size. A sparse file (a sandbox
 *   image, a simulator disk) is gigabytes here and megabytes there, and
 *   reporting only one of the two is how a "70 GB" reading becomes a mystery.
 *
 * # The two rules that make the figure match `du`
 *
 * - **A hard link is counted once.** Cargo links every artefact out of
 *   `target/debug/deps/` into `target/debug/`, so a walk that counted inodes
 *   rather than names reports a build directory at nearly twice its cost. Both
 *   figures would be "true", and the one a person acts on has to be the one
 *   their other tools report, so inodes with more than one link are counted the
 *   first time they are seen and skipped afterwards. The `files` count still
 *   counts every entry, because that is what was walked.
 * - **A symbolic link is never followed and never counted.** The answer to "how
 *   big is this directory" must not change because something inside it points
 *   at the whole home directory. The deployed plugins directory contains exactly
 *   that shape (`plugins/node_modules -> ~/.dsh/profiles/node_modules`).
 *
 * # Bounds
 *
 * Measurement is I/O on a tree whose size nobody controls, so every walk is
 * bounded three ways: a wall-clock deadline, a maximum number of entries, and a
 * bounded number of concurrent directory reads. A tree that hits a bound is
 * reported `truncated: true` with the partial total — never silently rounded up
 * to a number that was not measured.
 *
 * @module newpi-plugin-storage-console/scan
 */

import { lstat, opendir } from 'node:fs/promises';

/** The bounds one walk runs under. */
export const DEFAULT_LIMITS = Object.freeze({
  /** Entries visited before the walk stops early. */
  maxEntries: 400_000,
  /** Wall clock the walk may take. */
  timeoutMs: 20_000,
  /** Directory reads in flight at once. */
  concurrency: 16,
});

/**
 * What one path costs, as the filesystem counts it.
 *
 * `st_blocks` is not present on every platform Node runs on; when it is
 * missing the logical size is the only honest answer left.
 *
 * @param info - an `fs.Stats` for a regular file.
 * @returns the allocated size in bytes.
 */
export function allocatedBytes(info) {
  const blocks = info.blocks;
  if (typeof blocks === 'number' && Number.isFinite(blocks) && blocks >= 0) {
    return blocks * 512;
  }
  return info.size;
}

/**
 * A fresh, all-zero report for one path.
 *
 * @param path - the path being measured.
 * @returns the report.
 */
function emptyReport(path) {
  return {
    path,
    exists: false,
    kind: 'absent',
    bytes: 0,
    allocated: 0,
    files: 0,
    directories: 0,
    links: 0,
    unreadable: 0,
    truncated: false,
  };
}

/**
 * Measure one path, following nothing.
 *
 * The walk is iterative in effect and recursive in form: `walk` releases its
 * concurrency slot before awaiting its children, so a parent never holds a slot
 * a child would need. That is the difference between a bounded walk and a
 * deadlock, and it is the one detail worth stating out loud.
 *
 * @param root - the path to measure.
 * @param options - the bounds.
 * @param options.maxEntries - entries visited before stopping early.
 * @param options.timeoutMs - wall clock the walk may take.
 * @param options.concurrency - directory reads in flight at once.
 * @param options.clock - the clock, injectable so a test can expire it.
 * @returns the report. A path that does not exist is reported, not raised: a
 *   cache that was never created is a normal state, not a failure.
 */
export async function measureTree(root, options = {}) {
  const {
    maxEntries = DEFAULT_LIMITS.maxEntries,
    timeoutMs = DEFAULT_LIMITS.timeoutMs,
    concurrency = DEFAULT_LIMITS.concurrency,
    clock = () => Date.now(),
  } = options;

  const report = emptyReport(root);

  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    return report;
  }

  report.exists = true;
  if (rootInfo.isSymbolicLink()) {
    report.kind = 'link';
    report.links = 1;
    return report;
  }
  if (!rootInfo.isDirectory()) {
    report.kind = 'file';
    report.files = 1;
    report.bytes = rootInfo.size;
    report.allocated = allocatedBytes(rootInfo);
    return report;
  }
  report.kind = 'directory';

  const deadline = clock() + timeoutMs;
  let entries = 0;
  let stopped = false;

  // Inodes with more than one link, so a hard-linked artefact is charged to the
  // directory once. Only multi-link inodes are remembered: a tree of ordinary
  // files must not pay for a Set entry each.
  const counted = new Set();

  // A plain counting semaphore. `acquire` awaits when every slot is taken;
  // `release` hands the slot to the longest waiter, in order.
  let active = 0;
  const waiters = [];
  async function acquire() {
    if (active < concurrency) {
      active += 1;
      return;
    }
    await new Promise((resolve) => {
      waiters.push(resolve);
    });
    active += 1;
  }
  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  }

  /** Whether the walk has run out of budget. */
  function exhausted() {
    if (stopped) return true;
    if (entries >= maxEntries || clock() > deadline) {
      stopped = true;
      report.truncated = true;
      return true;
    }
    return false;
  }

  /**
   * Read one directory, count its files, and return its subdirectories.
   *
   * @param directory - the directory to read.
   * @returns the absolute paths of its subdirectories.
   */
  async function readOne(directory) {
    let handle;
    try {
      handle = await opendir(directory);
    } catch {
      report.unreadable += 1;
      return [];
    }

    const subdirectories = [];
    try {
      for await (const entry of handle) {
        if (exhausted()) break;
        entries += 1;
        const path = `${directory}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          report.links += 1;
          continue;
        }
        if (entry.isDirectory()) {
          report.directories += 1;
          subdirectories.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const info = await lstat(path);
          report.files += 1;
          // A hard link is the same bytes under a second name. Cargo produces
          // these by the thousand, so charging each name would report a build
          // directory at nearly twice what it costs.
          if (info.nlink > 1) {
            const inode = `${info.dev}:${info.ino}`;
            if (counted.has(inode)) continue;
            counted.add(inode);
          }
          report.bytes += info.size;
          report.allocated += allocatedBytes(info);
        } catch {
          report.unreadable += 1;
        }
      }
    } catch {
      report.unreadable += 1;
    }
    return subdirectories;
  }

  /**
   * Walk one directory, then its subdirectories.
   *
   * @param directory - the directory to walk.
   */
  async function walk(directory) {
    if (exhausted()) return;
    await acquire();
    let children;
    try {
      children = await readOne(directory);
    } finally {
      release();
    }
    if (children.length === 0) return;
    await Promise.all(children.map((child) => walk(child)));
  }

  report.directories = 1;
  await walk(root);
  return report;
}
