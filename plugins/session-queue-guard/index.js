/**
 * Queue user prompts while an agent is working.
 *
 * The Harness accepts two delivery modes for a user prompt. `steer` interrupts
 * the active turn, while `queue` lets that turn finish before the new message
 * starts another one. NewPi uses the latter because a status question must not
 * discard the work it is asking about.
 *
 * The page still owns the prompt UI and the Harness still owns admission. This
 * plugin changes only the documented delivery value at that admission seam.
 * It neither creates prompts nor retries model calls.
 *
 * @module newpi-plugin-session-queue-guard
 */

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'session-queue-guard'

/** The only service that admits prompts into an Agent inbox. */
export const inject = ['sessionController']

/** Marks a controller already wrapped by this plugin. */
const QUEUE_GUARD = Symbol('newpi-session-queue-guard')

/**
 * Convert one prompt request from interrupting to queued delivery.
 *
 * Unknown values remain untouched. The controller owns the request protocol,
 * so guarding it here covers both the web client and any other client that
 * reaches the same admission seam.
 *
 * @param request - the request the Harness is about to admit.
 * @returns the request the controller should receive.
 */
export function queuePromptRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request) || request.mode !== 'steer') {
    return request
  }
  return { ...request, mode: 'queue' }
}

/**
 * Guard the controller's real prompt-admission method.
 *
 * The Harness client uses its RPC transport for `session/prompt`, rather than
 * the page's ordinary `fetch`. Wrapping the controller prevents steering at
 * the one place where `steer` would otherwise cancel active work.
 *
 * @param controller - the Harness SessionController service.
 * @returns whether this call installed the guard.
 */
export function installSessionQueueGuard(controller) {
  if (controller === null || typeof controller !== 'object' || typeof controller.prompt !== 'function') {
    throw new TypeError('session-queue-guard requires a SessionController prompt method')
  }
  if (controller[QUEUE_GUARD] === true) return false
  const prompt = controller.prompt
  controller.prompt = function guardedPrompt(request, ...rest) {
    return prompt.call(this, queuePromptRequest(request), ...rest)
  }
  Object.defineProperty(controller, QUEUE_GUARD, { value: true })
  return true
}

/** Mount the controller guard. */
export function apply(ctx) {
  installSessionQueueGuard(ctx.sessionController)
  ctx.logger?.info?.(`${name}: user prompts queue behind active work`)
}
