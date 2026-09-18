/**
 * The console section: one command at a time, in the project's own directory,
 * with the output streamed into the interface.
 *
 * # What it is
 *
 * A NewPi plugin in the same shape as the Memory, Backup, Storage and Projects
 * sections: one service, one authenticated route, and one injection into the
 * rendered page. Nothing of the engine is written: the route is registered on
 * the shared connection (so it inherits the same loopback + token fence as
 * every other interface call) and the panel is spliced into the document head
 * by `tapIndex`.
 *
 * # What it deliberately is not
 *
 * No PTY. A PTY is the right answer for `vim`, `htop` and anything that asks
 * the operating system for a terminal; it is a different feature with its own
 * library to vendor, and this console says so rather than half-imitating one.
 * One command, one process group, streamed output, a stop button.
 *
 * # The two rules it keeps
 *
 * - **The workspace comes from the host.** The page names a command and
 *   nothing else: the directory a command runs in is resolved here, from the
 *   row's configuration or from the Project Model, never from the browser.
 * - **The output is reduced to text before it leaves.** The panel is a `<pre>`,
 *   so escapes are stripped here, where they can be tested without a browser.
 *
 * @module newpi-plugin-terminal-console
 */

import { spawn } from 'node:child_process';

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import {
  COMMAND_TIMEOUT_MS,
  DEFAULT_SHELL,
  MAX_OUTPUT_BYTES,
  TERMINAL_ENDPOINT,
  encodeFrame,
  exitFrames,
  panelFacts,
  plainText,
  readCommand,
  spawnSpec,
} from './terminal.js';
import { installTerminal } from './ui.js';

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'terminal-console';

/** The shared connection owns the authenticated route; the webserver owns the rendered index. */
export const inject = ['connection', 'webServer'];

/** The plugin's configuration: where commands run, and in what shell. */
export const Config = z.object({
  /** Directory commands run in. Defaults to the Project Model's current project. */
  workspace: z.string(),
  /** Absolute shell used to run a command line. Defaults to `/bin/zsh`. */
  shell: z.string(),
  /** Log the mounted section once at load. Defaults to true. */
  announce: z.boolean(),
});

/** The console service, reachable as `ctx.terminalConsole`. */
export class TerminalConsole extends Service {
  /**
   * @param ctx - the owning Cordis context.
   * @param options - the resolved configuration.
   */
  constructor(ctx, options = {}) {
    super(ctx, 'terminalConsole');
    this.workspace = typeof options.workspace === 'string' ? options.workspace : '';
    this.shell = typeof options.shell === 'string' && options.shell !== '' ? options.shell : DEFAULT_SHELL;
    this.announce = options.announce !== false;
  }

  /**
   * The directory commands run in.
   *
   * The configured workspace wins; otherwise the current project's root, so a
   * console is useful the moment it is mounted; otherwise the harness's own
   * working directory, which is the last honest answer available.
   *
   * @returns an absolute directory path.
   */
  directory() {
    if (this.workspace !== '') return this.workspace;
    try {
      const model = this.ctx.get('projectModel');
      const root = model?.currentProject?.rootPath;
      if (typeof root === 'string' && root !== '') return root;
    } catch {
      // A model that cannot describe itself is not a reason to refuse a
      // console: the fallback below is still a real directory.
    }
    return process.cwd();
  }

  /**
   * The facts the panel starts from.
   *
   * @returns a frozen description, carrying no secret.
   */
  facts() {
    return panelFacts({ workspace: this.directory() });
  }

  /**
   * Run one command and answer with its output stream.
   *
   * The response is newline-delimited JSON: one `out` frame per chunk of plain
   * text, then one `exit` frame carrying the code, the signal, whether the
   * output was cut off, and how long it took. A cancelled request — the panel's
   * stop button — kills the process group, so nothing keeps running unseen.
   *
   * @param request - the authenticated Fetch request.
   * @returns the streaming response, or a refusal.
   */
  async handle(request) {
    let command;
    try {
      command = readCommand(await request.json());
    } catch (error) {
      return Response.json(
        { ok: false, error: { code: error?.code ?? 'TERMINAL_BAD_REQUEST', message: String(error?.message ?? error) } },
        { status: 400 },
      );
    }

    const spec = spawnSpec(this.shell, this.directory(), command);
    const child = spawn(spec.file, spec.args, {
      cwd: spec.cwd,
      env: process.env,
      // Its own group, so a command that spawns children (a build, a watcher)
      // can be stopped whole rather than leaving orphans behind.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const encoder = new TextEncoder();
    const started = Date.now();
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let closed = false;

    const stop = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        // Already gone: nothing to stop, and the close handler still runs.
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, COMMAND_TIMEOUT_MS);
    request.signal?.addEventListener?.('abort', () => {
      clearTimeout(timer);
      stop();
    });

    const stream = new ReadableStream({
      start(controller) {
        const emit = (chunk) => {
          if (closed) return;
          const text = plainText(String(chunk));
          if (text === '') return;
          const room = MAX_OUTPUT_BYTES - bytes;
          if (room <= 0) {
            truncated = true;
            return;
          }
          bytes += text.length;
          if (text.length > room) {
            truncated = true;
            controller.enqueue(encoder.encode(encodeFrame({ type: 'out', text: text.slice(0, room) })));
            return;
          }
          controller.enqueue(encoder.encode(encodeFrame({ type: 'out', text })));
        };

        child.stdout?.on('data', emit);
        child.stderr?.on('data', emit);
        child.on('error', (error) => {
          emit(`\n${spec.file}: ${error.message}\n`);
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          if (closed) return;
          closed = true;
          const outcome = {
            code,
            signal: signal ?? undefined,
            truncated,
            ms: Date.now() - started,
            error: timedOut ? `Délai dépassé (${COMMAND_TIMEOUT_MS / 60000} min) : commande arrêtée.` : undefined,
          };
          for (const frame of exitFrames(outcome)) controller.enqueue(encoder.encode(encodeFrame(frame)));
          controller.close();
        });
      },
      cancel() {
        closed = true;
        clearTimeout(timer);
        stop();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }
}

/**
 * Mount the console: the route the panel calls, and the panel itself.
 *
 * @param ctx - the owning Cordis context.
 * @param config - the plugin row's configuration.
 */
export function apply(ctx, config = {}) {
  const service = new TerminalConsole(ctx, config);

  ctx.connection.fetch.register({
    path: TERMINAL_ENDPOINT,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => service.handle(request),
  });

  // Re-evaluated on every render of the index, so a page served after a project
  // change shows the directory its commands actually run in.
  ctx.webServer.tapIndex((html) => installTerminal(html, service.facts()));

  if (config.announce !== false) {
    ctx.logger?.info?.(`${name}: console montée — dossier=${service.directory()}`);
  }
}

// The literal the panel is given, restated where a test can compare the two
// sides: a plugin is deployed on its own, so the page's copy cannot be imported
// from here — it can only be asserted against it.
export { TERMINAL_ENDPOINT } from './terminal.js';
