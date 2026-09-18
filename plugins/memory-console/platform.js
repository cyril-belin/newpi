/**
 * The local platform operations the memory console needs, and nothing else.
 *
 * Every one of them is a process on this machine reading or writing files this
 * machine already owns: the archive tools macOS ships, a file panel, the
 * Finder's "reveal", and the hashing and inspection helpers the backup format
 * is verified with. There is no network call in this module, and no command is
 * ever built by string concatenation — arguments are passed as an array, so a
 * file name can never become a shell word.
 *
 * The panel commands are the only interactive part. `osascript` is what macOS
 * offers a process that is not itself a Cocoa application, which is exactly the
 * situation of the harness: it runs inside NewPi but is not NewPi's UI process.
 * A cancel is a normal answer, not an error, so it is reported as `null` rather
 * than raised — the difference between "the user changed their mind" and "the
 * panel could not be shown" is one error number, and both are handled here.
 *
 * @module newpi-plugin-memory-console/platform
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readFile, readdir, rename, stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** macOS's own archive tools and dialogs, by absolute path: the harness does
 * not inherit a terminal's `PATH`, and an absolute path cannot be shadowed by
 * something earlier on it. */
export const TOOLS = {
  zip: '/usr/bin/zip',
  unzip: '/usr/bin/unzip',
  osascript: '/usr/bin/osascript',
  open: '/usr/bin/open',
};

/** How long one archive command may take. A snapshot of a personal memory
 * database is small; anything past this is a stuck process, not a large file. */
const ARCHIVE_TIMEOUT_MS = 120_000;

/** How long a file panel may stay open before it is abandoned. A dialog that
 * nobody answers must not pin the console's single maintenance slot forever. */
const PANEL_TIMEOUT_MS = 300_000;

/** Error numbers `osascript` reports for the two ways a panel ends without a
 * path: the user cancelled (`-128`), or there is no session to draw in
 * (`-1713`, `-600`). The wording is the one the engine's own directory picker
 * matches on, for the same reason. */
const CANCEL_CODES = ['-128', 'User canceled', 'User cancelled'];
const NO_SESSION_CODES = ['-1713', '-600', 'No user interaction allowed'];

/** Raised when a local command fails for a reason the user should read. */
export class PlatformError extends Error {
  /**
   * @param message - what failed, in the user's words.
   * @param options - standard error options (`cause`).
   */
  constructor(message, options) {
    super(message, options);
    this.name = 'PlatformError';
  }
}

/**
 * Render one string as an AppleScript string literal.
 *
 * Backslash first, then the quote: the other order would escape the escapes
 * this function itself inserted.
 *
 * @param value - the raw value.
 * @returns the literal, quotes included.
 */
export function appleScriptString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Run one local command to completion.
 *
 * @param command - the executable, an absolute path.
 * @param args - its arguments, as an array.
 * @param options - run options.
 * @param options.cwd - working directory.
 * @param options.timeoutMs - how long it may take.
 * @param options.allowFailure - return the result instead of throwing when the
 *   command exits non-zero. Used for `unzip -t`, whose exit code *is* the
 *   integrity answer.
 * @returns the command's standard output and standard error, as text.
 * @throws {PlatformError} when the command fails or exceeds its timeout.
 */
export async function command(command, args, options = {}) {
  const { cwd, timeoutMs = ARCHIVE_TIMEOUT_MS, allowFailure = false } = options;
  try {
    const { stdout, stderr } = await run(command, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { stdout, stderr, code: 0, signal: null };
  } catch (error) {
    const code = typeof error?.code === 'number' ? error.code : 1;
    const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
    const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
    const signal = typeof error?.signal === 'string' ? error.signal : null;
    if (allowFailure) return { stdout, stderr, code, signal };
    const detail = (stderr.trim() || stdout.trim() || String(error?.message ?? error)).trim();
    throw new PlatformError(`${command} ${args[0] ?? ''} a échoué : ${detail}`, { cause: error });
  }
}

/**
 * Classify an `osascript` failure.
 *
 * A panel whose process was signalled ended without an answer — the flow was
 * abandoned, or the application is going away — and that is a cancellation:
 * nothing was chosen, and nothing failed.
 *
 * @param result - the command result.
 * @returns `'cancelled'`, `'no-session'`, or `'failed'`.
 */
export function panelOutcome(result) {
  if (result.signal !== null && result.signal !== undefined) return 'cancelled';
  const text = `${result.stderr}\n${result.stdout}`;
  if (CANCEL_CODES.some((needle) => text.includes(needle))) return 'cancelled';
  if (NO_SESSION_CODES.some((needle) => text.includes(needle))) return 'no-session';
  return 'failed';
}

/**
 * The AppleScript one save panel is asked with.
 *
 * Kept as its own pure function because it is compiled, as a string, by the
 * operating system: a test compiles it with `osacompile` without ever showing
 * a panel, which is the only way to check a script that would otherwise wait
 * for a person.
 *
 * @param options - the panel.
 * @param options.prompt - the message shown in the panel.
 * @param options.name - the pre-filled file name.
 * @param options.directory - where the panel opens.
 * @returns the script, one statement per line.
 */
export function savePanelScript({ prompt, name, directory }) {
  return [
    `set target to choose file name with prompt ${appleScriptString(prompt)}` +
      ` default name ${appleScriptString(name)}` +
      ` default location (POSIX file ${appleScriptString(directory)})`,
    'return POSIX path of target',
  ].join('\n');
}

/**
 * Ask for a path to write one file to.
 *
 * @param options - the panel.
 * @param options.prompt - the message shown in the panel.
 * @param options.name - the pre-filled file name.
 * @param options.directory - where the panel opens.
 * @returns the chosen path, or `null` when the user cancelled.
 * @throws {PlatformError} when the panel could not be shown at all.
 */
export async function savePanel({ prompt, name, directory }) {
  // One statement per line, and never joined with an empty string: measured on
  // the real compiler, `…))return POSIX path of target` is a syntax error, and
  // a panel script that does not compile is a save button that never worked.
  const script = savePanelScript({ prompt, name, directory });
  const result = await command(TOOLS.osascript, ['-e', script], {
    timeoutMs: PANEL_TIMEOUT_MS,
    allowFailure: true,
  });
  if (result.code === 0) {
    const path = result.stdout.trim();
    return path.length > 0 ? path : null;
  }
  const outcome = panelOutcome(result);
  if (outcome === 'cancelled') return null;
  throw new PlatformError(
    outcome === 'no-session'
      ? 'Aucune session graphique ne peut afficher le sélecteur de fichier ; la sauvegarde sera écrite dans le dossier des sauvegardes.'
      : `Le sélecteur de fichier n'a pas pu être affiché : ${result.stderr.trim()}`,
  );
}

/**
 * Show one directory in the Finder.
 *
 * @param path - the directory to reveal.
 * @throws {PlatformError} when the directory is missing or the Finder refuses.
 */
export async function revealDirectory(path) {
  const info = await stat(path).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new PlatformError(`Le dossier ${path} n'existe pas.`);
  }
  await command(TOOLS.open, [path], { timeoutMs: 15_000 });
}

/**
 * Build one zip archive from a directory's entries.
 *
 * `-X` drops the extra file attributes — owner, group, resource fork — and `-D`
 * suppresses directory entries, so the archive holds exactly the files that
 * were asked for and nothing about the machine they came from.
 * The archive is written to a temporary name first and renamed into place: a
 * half-written archive must never be mistaken for a usable backup.
 *
 * @param options - the archive.
 * @param options.source - the directory to read from.
 * @param options.entries - the entry names to store, relative to `source`.
 * @param options.destination - the archive to produce.
 * @returns the archive's size in bytes.
 * @throws {PlatformError} when the archive cannot be written.
 */
export async function zipEntries({ source, entries, destination }) {
  const partial = `${destination}.part`;
  await command(TOOLS.zip, ['-q', '-r', '-X', '-D', partial, ...entries], {
    cwd: source,
  });
  await rename(partial, destination);
  return fileSize(destination);
}

/**
 * The entry names one archive holds.
 *
 * @param archive - the archive path.
 * @returns the names, in the order the archive stores them.
 * @throws {PlatformError} when the archive cannot be read.
 */
export async function archiveEntries(archive) {
  const { stdout } = await command(TOOLS.unzip, ['-Z1', archive]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Read one entry out of an archive without unpacking the rest.
 *
 * The bytes come back raw: the manifest is text, but the same helper reads the
 * database when it is checked against its digest, and a UTF-8 decode would
 * silently corrupt it.
 *
 * @param archive - the archive path.
 * @param entry - the entry name.
 * @returns the entry's bytes.
 * @throws {PlatformError} when the entry is missing or unreadable.
 */
export async function archiveEntry(archive, entry) {
  try {
    const { stdout } = await run(TOOLS.unzip, ['-p', archive, entry], {
      timeout: ARCHIVE_TIMEOUT_MS,
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'buffer',
    });
    return stdout;
  } catch (error) {
    throw new PlatformError(`Entrée illisible dans l'archive : ${entry}`, { cause: error });
  }
}

/**
 * Whether an archive's own checksums are intact.
 *
 * @param archive - the archive path.
 * @returns `true` when `unzip -t` accepts every entry.
 */
export async function archiveIsIntact(archive) {
  const result = await command(TOOLS.unzip, ['-t', '-qq', archive], { allowFailure: true });
  return result.code === 0;
}

/**
 * Unpack named entries into a directory.
 *
 * Only the entries the caller names are extracted, and every name is checked
 * first: an archive that tries to escape its destination with an absolute path
 * or a `..` segment is refused rather than unpacked. The list of names comes
 * from the archive itself, so a manifest cannot smuggle in a path the archive
 * does not hold — and the archive cannot smuggle in one the caller did not ask
 * for.
 *
 * @param options - the extraction.
 * @param options.archive - the archive path.
 * @param options.target - the directory to unpack into; it must exist.
 * @param options.entries - the entry names to unpack.
 * @returns the entry names that were unpacked.
 * @throws {PlatformError} when a name is unsafe or the extraction fails.
 */
export async function extractEntries({ archive, target, entries }) {
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new PlatformError(`L'archive contient un chemin refusé : ${entry}`);
    }
  }
  if (entries.length === 0) return [];
  await command(TOOLS.unzip, ['-o', '-q', archive, ...entries, '-d', target]);
  return entries;
}

/**
 * A file's size in bytes.
 *
 * @param path - the file.
 * @returns the size.
 * @throws {PlatformError} when the file cannot be measured.
 */
export async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    throw new PlatformError(`Fichier illisible : ${path}`, { cause: error });
  }
}

/**
 * SHA-256 of a file, lowercase hex, read in one pass.
 *
 * @param path - the file.
 * @returns the digest.
 * @throws {PlatformError} when the file cannot be read.
 */
export async function sha256File(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch (error) {
    throw new PlatformError(`Fichier illisible : ${path}`, { cause: error });
  }
}

/**
 * Whether a file begins with the SQLite header.
 *
 * The archive's integrity check proves the bytes arrived as they left; this
 * proves they are a database at all, which a renamed text file is not.
 *
 * @param path - the file.
 * @returns `true` when the file starts with the SQLite magic.
 */
export async function isSqliteFile(path) {
  const header = Buffer.alloc(16);
  let handle;
  try {
    handle = await open(path, 'r');
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return bytesRead === header.length && header.toString('utf8') === 'SQLite format 3\0';
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The files directly inside one directory, with their sizes.
 *
 * @param directory - the directory.
 * @returns the entries, `{name, path, bytes, modified}`; an empty list when the
 * directory does not exist, which is a normal state for a fresh install.
 */
export async function directoryEntries(directory) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const entries = [];
  for (const name of names) {
    const path = `${directory}/${name}`;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      entries.push({ name, path, bytes: info.size, modified: info.mtime.toISOString() });
    } catch {
      // A file that vanished between the listing and the stat is simply gone.
    }
  }
  return entries;
}
