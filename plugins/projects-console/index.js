/**
 * The Projects section: which project is open, which ones are recent, and how
 * to change project without knowing a path, a variable or a command.
 *
 * # What it is
 *
 * A NewPi plugin in the same shape as the Memory, Backup and Storage sections:
 * one service, one injection into the rendered page, and no engine file
 * written. It owns **no endpoint**. Every project fact and every project action
 * goes through `ctx.projectModel` — the model already mounted at launch — and
 * the browser reaches it through the one route the model already registers,
 * `POST /api/newpi.project`.
 *
 * # Why the page gets facts it cannot compute
 *
 * Three things the page cannot know by itself are decided on the host and
 * inlined into the document once: the directory the harness was launched in
 * (the honest explanation of why a change needs a restart), whether NewPi is
 * running from an `.app` bundle the system can open again, and which project
 * capabilities this build lets an interface change. None of them is a secret,
 * and none is a capability: the page is still a plain web page that can only
 * name an action, and the Project Model reads the same list again when the
 * action arrives.
 *
 * @module newpi-plugin-projects-console
 */

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import { installProjects } from './ui.js';

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'projects-console';

/**
 * The one route this section calls. It is the Project Model's route, not this
 * plugin's: the browser is given exactly one door into project facts. The
 * literal is repeated here because a plugin is deployed on its own and must not
 * import another plugin's module; a test asserts the two literals agree.
 */
export const PROJECTS_ENDPOINT = '/api/newpi.project';

/**
 * The webserver, whose rendered index this section is spliced into, and the
 * Project Model, which is the only source of project truth. The section has no
 * boot opinion: without either of them it simply does not mount, and the rest
 * of NewPi is unaffected.
 */
export const inject = ['webServer', 'projectModel'];

/**
 * The plugin's configuration. The section renders nothing secret, so it has
 * nothing to carry: only whether it announces itself once at load.
 */
export const Config = z.object({
  /** Log the mounted section once at load. Defaults to true. */
  announce: z.boolean(),
});

/**
 * The Projects service, reachable as `ctx.projectsConsole`.
 *
 * Read only by construction: it holds no state of its own and mutates nothing.
 * It exists to answer one question — what does the page need to know before it
 * can start asking the Project Model anything — and to inject the section.
 */
export class ProjectsConsole extends Service {
  /**
   * @param ctx - the owning Cordis context.
   * @param options - the resolved configuration.
   */
  constructor(ctx, options = {}) {
    super(ctx, 'projectsConsole');
    this.announce = options.announce !== false;
  }

  /**
   * The facts the page starts from.
   *
   * Computed when the index is rendered, never persisted. `ready: false` when
   * the Project Model is not mounted at all, which is the one case the section
   * says out loud rather than rendering an empty panel.
   *
   * @returns a frozen description.
   */
  facts() {
    const model = this.ctx.get('projectModel');
    if (model === undefined || model === null) {
      return Object.freeze({ ready: false, endpoint: PROJECTS_ENDPOINT });
    }
    let workspace = null;
    let relaunch = false;
    let editable = [];
    try {
      const described = typeof model.describe === 'function' ? model.describe() : null;
      workspace = typeof described?.workspace === 'string' ? described.workspace : null;
      relaunch = typeof model.canRelaunch === 'function' ? model.canRelaunch() === true : false;
      editable =
        typeof model.modifiableCapabilities === 'function' ? model.modifiableCapabilities() : [];
    } catch {
      // A model that cannot describe itself is reported as absent rather than
      // failing the page: the panel's own endpoint calls are the real check.
      workspace = null;
      relaunch = false;
      editable = [];
    }
    return Object.freeze({
      ready: true,
      endpoint: PROJECTS_ENDPOINT,
      launchRoot: workspace !== '' ? workspace : null,
      relaunch,
      // Which capability controls the page may render, straight from the
      // model. The page never decides this for itself, and the endpoint
      // enforces the same list again on the way back.
      editableCapabilities: Object.freeze(
        (Array.isArray(editable) ? editable : []).filter((name) => typeof name === 'string'),
      ),
    });
  }
}

/**
 * Mount the section: inject it into the rendered interface.
 *
 * @param ctx - the owning Cordis context.
 * @param config - the plugin row's configuration.
 */
export function apply(ctx, config = {}) {
  const service = new ProjectsConsole(ctx, config);

  // The facts are recomputed on every render of the index rather than captured
  // once, so a page served after a project change carries the right launch root.
  ctx.webServer.tapIndex((html) => installProjects(html, service.facts()));

  if (config.announce !== false) {
    const current = ctx.get('projectModel')?.currentProject ?? null;
    ctx.logger?.info?.(
      `${name}: section Projets montée — projet=${current?.name ?? '(aucun)'} ` +
        `racine=${current?.rootPath ?? '(inconnue)'}`,
    );
  }
}
