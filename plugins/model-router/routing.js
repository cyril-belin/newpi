/**
 * The model router's decisions, as pure functions.
 *
 * Everything here is a function of its arguments: which failure may move to a
 * fallback, what a provider's returned metadata means as a capability, whether a
 * route can run a task, how a diagnostic is scrubbed before it is journalled.
 * The service in `index.js` owns the state and calls these; keeping the policy
 * here is what makes it testable without a harness, a provider, or a clock.
 *
 * @module newpi-plugin-model-router/routing
 */

/**
 * Provider-neutral failure codes that mean "this route could not answer".
 *
 * The harness's adapters normalize provider failures to these, so the router
 * never parses a provider's prose to decide whether to fall back. The set is
 * deliberately explicit rather than "anything that looks transient": a code
 * that is not listed here does *not* fall back, so a new failure class silently
 * promoting itself to a route change is impossible.
 */
export const FALLBACK_CODES = Object.freeze([
  'NO_ADAPTER',
  'RATE_LIMIT',
  'QUOTA',
  'TIMEOUT',
  'NETWORK',
  'CONNECTION_ERROR',
  'FETCH_FAILED',
  'UNAVAILABLE',
  'PROVIDER_UNAVAILABLE',
  'MODEL_UNAVAILABLE',
  'OVERLOADED',
  'SERVICE_UNAVAILABLE',
  'SERVER_ERROR',
  'BAD_GATEWAY',
  'GATEWAY_TIMEOUT',
]);

/**
 * Codes that must never move to a fallback, even if a provider returns a
 * transport-looking status.
 *
 * These are the failures where trying another model would either repeat the
 * same rejection (`CONTEXT_WINDOW_EXCEEDED`), hide a configuration mistake
 * (`AUTH`, `MISSING_CREDENTIAL`), or mask a decision the model itself made
 * (`EMPTY_RESPONSE` is advertised as safe to retry, but a fallback is a *route
 * change*, not a retry, and the user did not ask for one).
 */
export const NON_FALLBACK_CODES = Object.freeze([
  'ABORTED',
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'INVALID_ARGS',
  'INVALID_PREPARED_CALL',
  'CONTEXT_WINDOW_EXCEEDED',
  'EMPTY_RESPONSE',
  'INVARIANT',
]);

/** HTTP statuses that describe an unavailable route rather than a bad request. */
export const FALLBACK_STATUSES = Object.freeze([408, 425, 429, 500, 502, 503, 504, 522, 524]);

/** Raised for a routing request the router refuses. */
export class RouterError extends Error {
  /**
   * @param code - stable machine-routable failure class.
   * @param message - human readable detail.
   */
  constructor(code, message) {
    super(message);
    this.name = 'RouterError';
    this.code = code;
  }
}

/**
 * Whether a failure may move the operation to its role's fallback route.
 *
 * Fails closed: an unknown code is not eligible. A functional or logical
 * failure of the model — a bad answer, an argument error, a context overflow —
 * is never eligible, because switching provider would not fix it and would
 * make the router's choices impossible to reason about.
 *
 * @param failure - the harness's `LlmFailure`, from a terminal finish chunk.
 * @returns whether a fallback may be attempted.
 */
export function isFallbackEligible(failure) {
  if (failure === null || typeof failure !== 'object') return false;
  const code = typeof failure.code === 'string' ? failure.code : '';
  if (NON_FALLBACK_CODES.includes(code)) return false;
  if (FALLBACK_CODES.includes(code)) return true;
  const status = Number(failure.status);
  if (Number.isInteger(status) && FALLBACK_STATUSES.includes(status)) return true;
  return false;
}

/**
 * The failure facts worth journalling, with every secret-shaped substring
 * removed.
 *
 * The harness already keeps keys out of its own messages, but the router is the
 * last thing that writes before a log line leaves the process, so it scrubs
 * rather than trusts. A key that arrived in a provider's error text must not
 * become a record.
 *
 * @param failure - the harness's `LlmFailure`.
 * @returns a frozen `{ code, status?, message? }`.
 */
export function describeFailure(failure) {
  const facts = { code: typeof failure?.code === 'string' ? failure.code : 'UNKNOWN' };
  const status = Number(failure?.status);
  if (Number.isInteger(status)) facts.status = status;
  const message = failure?.message;
  if (typeof message === 'string' && message.length > 0) {
    facts.message = redact(message).slice(0, 300);
  }
  return Object.freeze(facts);
}

/** Patterns that turn a diagnostic into a redacted one. */
const REDACTIONS = Object.freeze([
  [/\bsk-[A-Za-z0-9_-]{4,}/g, '[redacted]'],
  [/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]'],
  [/\b(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '[redacted]'],
  // Any long opaque run: a key that reached a message without a label.
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]'],
]);

/**
 * Remove anything that looks like a credential from one string.
 *
 * @param text - the text to scrub.
 * @returns the scrubbed text.
 */
export function redact(text) {
  let result = String(text);
  for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement);
  return result;
}

/**
 * The capability facts a harness adapter disclosed for one exact route.
 *
 * Only what the harness actually publishes is derived. `tools` is not part of
 * `LlmResolvedModelInfo`, so it is never guessed here — an undeclared `tools`
 * stays unknown, and a plan that needs it must declare it.
 *
 * @param resolved - the value `llm.resolveModelInfo()` returned.
 * @returns a capability object, or `undefined` when nothing was disclosed.
 */
export function deriveCapabilities(resolved) {
  if (resolved === null || typeof resolved !== 'object') return undefined;
  const derived = {};
  const contextWindow = resolved.context?.contextWindow;
  if (Number.isInteger(contextWindow) && contextWindow > 0) {
    derived.maxContext = contextWindow;
  }
  if (Array.isArray(resolved.inputModalities)) {
    derived.vision = resolved.inputModalities.includes('image');
  }
  if (resolved.reasoning !== undefined && resolved.reasoning !== null) {
    derived.reasoning =
      Array.isArray(resolved.reasoning.efforts) && resolved.reasoning.efforts.length > 0;
  }
  return Object.keys(derived).length === 0 ? undefined : Object.freeze(derived);
}

/**
 * Overlay a route's declared capabilities on what its adapter disclosed.
 *
 * The declaration wins: a deployment that knows its gateway proxies images for
 * a model the adapter calls text-only is entitled to say so.
 *
 * @param declared - the plan's declaration, when it has one.
 * @param derived - what the adapter disclosed, when it disclosed anything.
 * @returns the merged capabilities, or `undefined` when nothing is known.
 */
export function mergeCapabilities(declared, derived) {
  if (declared === undefined && derived === undefined) return undefined;
  const merged = { ...(derived ?? {}), ...(declared ?? {}) };
  return Object.keys(merged).length === 0 ? undefined : Object.freeze(merged);
}

/**
 * Check a route's capabilities against what a task needs.
 *
 * A requirement is a floor, and only `true` states one: `{ tools: true }` means
 * the route must be able to call tools, while `{ tools: false }` means tools are
 * not needed — not that they are forbidden. `maxContext` is a minimum.
 *
 * A capability that is *unknown* is not a failure: an adapter that discloses
 * nothing must not make every route look incapable. Unknown keys are reported so
 * the caller can say what it could not prove.
 *
 * @param capabilities - the route's merged capabilities.
 * @param requirements - the task's requirements.
 * @returns a frozen `{ capable, missing, unknown }`.
 */
export function meetsRequirements(capabilities, requirements) {
  const missing = [];
  const unknown = [];
  const known = capabilities ?? {};
  for (const [key, needed] of Object.entries(requirements ?? {})) {
    if (needed === undefined || needed === null || needed === false) continue;
    const have = known[key];
    if (have === undefined || have === null) {
      unknown.push(key);
      continue;
    }
    if (key === 'maxContext') {
      if (have < needed) missing.push(key);
    } else if (have !== true) {
      missing.push(key);
    }
  }
  return Object.freeze({ capable: missing.length === 0, missing, unknown });
}

/**
 * Normalize a selection supplied at runtime, the way `parseSelection` does for
 * a plan.
 *
 * @param value - the raw selection.
 * @param where - diagnostic path.
 * @returns a frozen `{ provider, model, reasoningEffort? }`.
 * @throws {RouterError} when it is not a usable selection.
 */
export function normalizeSelection(value, where = 'selection') {
  const invalid = (detail) =>
    new RouterError('MODEL_ROUTER_INVALID_SELECTION', `${where}: ${detail}`);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('an object with a provider and a model is required');
  }
  for (const key of Object.keys(value)) {
    if (!['provider', 'model', 'reasoningEffort'].includes(key)) {
      throw invalid(`unknown key ${JSON.stringify(key)}`);
    }
    if (/api[_-]?key|apikey|token|secret|password|credential/i.test(key)) {
      throw invalid('a credential does not belong in a model selection');
    }
  }
  const provider = value.provider;
  const model = value.model;
  if (typeof provider !== 'string' || provider.trim() === '') {
    throw invalid('provider must be a non-empty string');
  }
  if (typeof model !== 'string' || model.trim() === '') {
    throw invalid('model must be a non-empty string');
  }
  const selection = { provider: provider.trim(), model: model.trim() };
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== null) {
    if (typeof value.reasoningEffort !== 'string' || value.reasoningEffort.trim() === '') {
      throw invalid('reasoningEffort must be a non-empty string when present');
    }
    selection.reasoningEffort = value.reasoningEffort.trim();
  }
  return Object.freeze(selection);
}

/**
 * Whether two selections name the same route and effort.
 *
 * @param a - one selection.
 * @param b - the other.
 * @returns whether they are equal field by field.
 */
export function sameSelection(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    (a.reasoningEffort ?? null) === (b.reasoningEffort ?? null)
  );
}

/**
 * One operation's captured route.
 *
 * A lease is the router's answer to "the model must not change mid-operation".
 * Its selection is fixed the moment it is taken, so a switch, a mode change or
 * a role override made while the operation runs affects the *next* operation
 * and never this one. A critical lease additionally refuses a switch outright
 * until it is released, which is what keeps an atomic step from being announced
 * as one model and completed with another.
 */
export class ModelLease {
  /**
   * @param options - the captured route and the operation's identity.
   * @param options.id - unique lease id, for the journal.
   * @param options.role - the role the operation asked for.
   * @param options.selection - the route captured at acquisition.
   * @param options.fallback - the role's fallback route, when it has one.
   * @param options.sessionId - session the operation belongs to, when known.
   * @param options.operationId - operation identity, when known.
   * @param options.critical - whether a switch must wait for this lease.
   * @param options.acquiredAt - acquisition time, in epoch milliseconds.
   * @param options.onRelease - called once when the lease is released.
   */
  constructor(options) {
    /** Unique lease id. */
    this.id = options.id;
    /** The role the operation asked for. */
    this.role = options.role;
    /** The route, frozen at acquisition. */
    this.selection = options.selection;
    /** The role's fallback route, or `undefined`. */
    this.fallback = options.fallback;
    /** The session this operation belongs to, or `undefined`. */
    this.sessionId = options.sessionId;
    /** The operation identity, or `undefined`. */
    this.operationId = options.operationId;
    /** Whether a switch must wait for this lease to end. */
    this.critical = options.critical !== false;
    /** Acquisition time, in epoch milliseconds. */
    this.acquiredAt = options.acquiredAt;
    /** Whether the lease has been released. */
    this.released = false;
    /** @private */
    this.onRelease = options.onRelease;
  }

  /**
   * Whether the selection this lease captured is still the route a new operation
   * would get. False means a switch happened while this operation ran — which is
   * allowed, and exactly why the lease exists.
   *
   * @param current - a selection resolved now.
   * @returns whether they name the same route.
   */
  isCurrent(current) {
    return sameSelection(this.selection, current);
  }

  /**
   * End the operation's hold on its route. Idempotent.
   *
   * @returns whether this call was the one that released it.
   */
  release() {
    if (this.released) return false;
    this.released = true;
    this.onRelease?.(this);
    return true;
  }
}
