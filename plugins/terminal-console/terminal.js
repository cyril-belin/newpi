/**
 * The command console: pure helpers, and the contract the page and the host
 * share.
 *
 * # What a "console" is here, and what it is not
 *
 * One command at a time, run by `/bin/zsh -lc` in the project's own directory,
 * with its output streamed to the panel. That covers what a person actually
 * does inside an editor — `git`, `pnpm test`, `cargo`, `pnpm storage` — and it
 * deliberately does not pretend to be a terminal: there is no PTY, no job
 * control, no interactive program. `vim` and `htop` need a real TTY, and a
 * command console that half-imitates one would be worse than one that says so.
 *
 * # Why the host strips the escapes
 *
 * A command that thinks it is talking to a terminal writes colours, cursor
 * moves and carriage-return progress bars. The panel is a `<pre>`, not an
 * emulator, so the host reduces every chunk to plain text before it is sent:
 * one place to do it, testable without a browser, and nothing that renders in
 * the page depends on escapes arriving intact.
 *
 * @module newpi-plugin-terminal-console/terminal
 */

/** The one route the panel calls. A test asserts the two sides agree. */
export const TERMINAL_ENDPOINT = '/api/newpi.terminal';

/** Longest command the console accepts, in characters. */
export const MAX_COMMAND_LENGTH = 4000;

/** How many bytes of output one command may stream before it is cut off. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** How long one command may run before the host stops it, in milliseconds. */
export const COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

/** The shell a command runs in. */
export const DEFAULT_SHELL = '/bin/zsh';

/** A carriage return, the byte progress bars use to redraw one line. */
const CR = '\r';

/** A CSI escape: `ESC [ ... final`. */
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** An OSC escape, terminated by BEL or ST. */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
/** Any remaining two-byte escape. */
const SHORT = /\u001b[@-Z\\-_]/g;
/** Other C0 controls a console never wants, except tab and newline. */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * What is wrong with a command, if anything.
 *
 * @param command - the raw text the panel sent.
 * @returns `null` when the command is runnable, otherwise a message.
 */
export function commandError(command) {
  if (typeof command !== 'string') return 'Commande absente.';
  const trimmed = command.trim();
  if (trimmed === '') return 'Commande vide.';
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return `Commande trop longue (${trimmed.length} > ${MAX_COMMAND_LENGTH} caractères).`;
  }
  return null;
}

/**
 * The command a request carries, or a refusal.
 *
 * @param payload - the decoded request body.
 * @returns the trimmed command.
 * @throws {Error} naming what is wrong, with `code` set for the panel.
 */
export function readCommand(payload) {
  const command = payload?.command;
  const error = commandError(command);
  if (error !== null) {
    const refusal = new Error(error);
    refusal.code = 'TERMINAL_INVALID_COMMAND';
    throw refusal;
  }
  return command.trim();
}

/**
 * Reduce one output chunk to plain text.
 *
 * Carriage returns are the interesting case: a progress bar redraws one line
 * dozens of times, and keeping every version would fill the panel with the same
 * line. Only the text after the last carriage return of a chunk is kept when
 * the chunk had no newline after it — which is exactly what a redraw means.
 *
 * @param chunk - one decoded chunk of stdout or stderr.
 * @returns text with escapes removed, safe to put in a `<pre>`.
 */
export function plainText(chunk) {
  if (typeof chunk !== 'string' || chunk === '') return '';
  let text = chunk.replace(OSC, '').replace(CSI, '').replace(SHORT, '');
  text = text.replace(CONTROLS, '');
  return text
    .split('\n')
    .map((line) => (line.includes(CR) ? line.slice(line.lastIndexOf(CR) + 1) : line))
    .join('\n');
}

/**
 * The spawn specification for one command.
 *
 * `-l` gives the login environment a person's own shell would have (their
 * `PATH`, their `pnpm`), which is the difference between a console that works
 * and one that cannot find `node`.
 *
 * @param shell - the shell to run.
 * @param workspace - the directory the command runs in.
 * @param command - the command line.
 * @returns the `spawn` arguments.
 */
export function spawnSpec(shell, workspace, command) {
  return {
    file: typeof shell === 'string' && shell !== '' ? shell : DEFAULT_SHELL,
    args: ['-lc', command],
    cwd: typeof workspace === 'string' && workspace !== '' ? workspace : process.cwd(),
  };
}

/**
 * One newline-delimited frame of the response stream.
 *
 * Every frame is one JSON object on its own line, so the panel needs no parser
 * and a frame boundary can never be confused with output that happens to look
 * like one.
 *
 * @param frame - the frame to encode.
 * @returns the encoded line.
 */
export function encodeFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * The frames one finished command produces, in order.
 *
 * @param outcome - how the command ended.
 * @returns the closing frames.
 */
export function exitFrames(outcome) {
  const frames = [];
  if (typeof outcome.error === 'string' && outcome.error !== '') {
    frames.push({ type: 'error', message: outcome.error });
  }
  frames.push({
    type: 'exit',
    code: typeof outcome.code === 'number' && Number.isInteger(outcome.code) ? outcome.code : null,
    signal: typeof outcome.signal === 'string' && outcome.signal !== '' ? outcome.signal : null,
    truncated: outcome.truncated === true,
    ms: typeof outcome.ms === 'number' ? Math.max(0, Math.round(outcome.ms)) : 0,
  });
  return frames;
}

/**
 * The facts the panel starts from, computed when the index is rendered.
 *
 * @param options - what the host knows.
 * @returns a frozen description, carrying no secret and no capability.
 */
export function panelFacts(options = {}) {
  const workspace = typeof options.workspace === 'string' && options.workspace !== '' ? options.workspace : null;
  return Object.freeze({
    endpoint: TERMINAL_ENDPOINT,
    workspace,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
}
