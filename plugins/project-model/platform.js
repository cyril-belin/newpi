/**
 * The two host operations the Project section needs, and nothing else: a native
 * folder chooser, and a clean relaunch of NewPi.
 *
 * # Why `osascript`
 *
 * The interface is a web page served by the harness over loopback, and it has
 * deliberately no Tauri capability — it cannot ask macOS for anything. The
 * harness itself is not a Cocoa application, so `osascript` is what macOS
 * offers a process in that position, exactly as the memory console's save panel
 * documents. The panel therefore belongs to the `osascript` process; that is
 * assumed and paid for by the interface receiving no native API at all.
 *
 * # Why the relaunch is a second script
 *
 * One runtime, one workspace: opening a project whose root is not the launch
 * directory only takes effect when NewPi itself restarts. The script below
 * quits NewPi and activates it again, and it runs **detached** in its own
 * process group, because NewPi's shutdown kills the runtime's whole group —
 * including the plugin that started it. Nothing is built by string
 * concatenation into a shell: the application is addressed by its bundle
 * identifier inside AppleScript, and no path from the page ever reaches a
 * command.
 *
 * @module newpi-plugin-project-model/platform
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The macOS tools, by absolute path: the harness does not inherit a terminal's
 * `PATH`, and an absolute path cannot be shadowed by something earlier on it.
 */
export const TOOLS = {
  osascript: '/usr/bin/osascript',
  open: '/usr/bin/open',
};

/** How long a folder panel may stay open before it is abandoned. A dialog
 * nobody answers must not pin the request forever. */
const PANEL_TIMEOUT_MS = 300_000;

/** Error numbers `osascript` reports for the two ways a panel ends without an
 * answer: the user cancelled (`-128`), or there is no session to draw in
 * (`-1713`, `-600`). The memory console matches the same codes for the same
 * reason. */
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
 * @param options.timeoutMs - how long it may take.
 * @param options.allowFailure - return the result instead of throwing when the
 *   command exits non-zero.
 * @returns the command's standard output and standard error, as text.
 * @throws {PlatformError} when the command fails or exceeds its timeout.
 */
export async function command(command, args, options = {}) {
  const { timeoutMs = PANEL_TIMEOUT_MS, allowFailure = false } = options;
  try {
    const { stdout, stderr } = await run(command, args, {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
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
    throw new PlatformError(`${command} a échoué : ${detail}`, { cause: error });
  }
}

/**
 * Classify an `osascript` failure.
 *
 * A panel whose process was signalled ended without an answer, and that is a
 * cancellation: nothing was chosen, and nothing failed.
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
 * The AppleScript one folder panel is asked with.
 *
 * Kept as its own pure function because it is compiled, as a string, by the
 * operating system: a test compiles it with `osacompile` without ever showing a
 * panel, which is the only way to check a script that would otherwise wait for
 * a person.
 *
 * @param options - the panel.
 * @param options.prompt - the message shown in the panel.
 * @param options.directory - where the panel opens; omitted when empty.
 * @returns the script, one statement per line.
 */
export function chooseFolderScript({ prompt, directory }) {
  const location =
    typeof directory === 'string' && directory !== ''
      ? ` default location (POSIX file ${appleScriptString(directory)})`
      : '';
  return [
    `set target to choose folder with prompt ${appleScriptString(prompt)}${location}`,
    'return POSIX path of target',
  ].join('\n');
}

/**
 * Ask for one project directory.
 *
 * @param options - the panel.
 * @param options.prompt - the message shown in the panel.
 * @param options.directory - where the panel opens.
 * @returns the chosen directory, or `null` when the user cancelled.
 * @throws {PlatformError} when the panel could not be shown at all.
 */
export async function chooseFolder({ prompt, directory }) {
  const script = chooseFolderScript({ prompt, directory });
  const result = await command(TOOLS.osascript, ['-e', script], {
    timeoutMs: PANEL_TIMEOUT_MS,
    allowFailure: true,
  });
  if (result.code === 0) {
    // `choose folder` answers with a trailing separator; the Project Model
    // canonicalizes the path anyway, and a bare `/` must stay `/`.
    const path = result.stdout.trim().replace(/\/+$/, '');
    return path.length > 0 ? path : null;
  }
  const outcome = panelOutcome(result);
  if (outcome === 'cancelled') return null;
  throw new PlatformError(
    outcome === 'no-session'
      ? "Aucune session graphique ne peut afficher le sélecteur de dossier ; ouvrez un projet depuis NewPi plutôt qu'en ligne de commande."
      : `Le sélecteur de dossier n'a pas pu être affiché : ${result.stderr.trim()}`,
  );
}

/**
 * The AppleScript that quits NewPi and starts it again.
 *
 * The application is addressed by its bundle identifier, so no filesystem path
 * is involved and no shell word is ever built. `activate` launches an
 * application that is not running, which is what makes the pair a relaunch.
 *
 * @param options - the relaunch.
 * @param options.appId - the bundle identifier.
 * @param options.delaySeconds - how long to let the caller's answer leave first.
 * @param options.graceSeconds - how long to give NewPi to stop.
 * @returns the script, one statement per line.
 */
export function relaunchScript({ appId, delaySeconds = 0.8, graceSeconds = 4 }) {
  return [
    `delay ${Number(delaySeconds)}`,
    `tell application id ${appleScriptString(appId)} to quit`,
    `delay ${Number(graceSeconds)}`,
    `tell application id ${appleScriptString(appId)} to activate`,
  ].join('\n');
}

/**
 * Ask the host to quit NewPi and start it again, without waiting for it.
 *
 * The child is detached and unreferenced on purpose: NewPi stops the runtime's
 * whole process group when it quits, and a helper inside that group would be
 * killed before it could start the application again.
 *
 * @param options - the relaunch.
 * @param options.appId - the bundle identifier.
 * @returns whether the request was handed to the system.
 * @throws {PlatformError} when the helper could not be started at all.
 */
export function requestRelaunch({ appId }) {
  try {
    const child = spawn(TOOLS.osascript, ['-e', relaunchScript({ appId })], {
      detached: true,
      stdio: 'ignore',
    });
    // A spawn failure arrives asynchronously. Left unhandled it would take the
    // runtime down with it, and the truthful answer — "the helper could not be
    // started" — belongs in the log, not in a crash.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch (error) {
    throw new PlatformError(
      `NewPi n'a pas pu programmer son redémarrage : ${error?.message ?? error}`,
      { cause: error },
    );
  }
}
