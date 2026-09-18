/**
 * The model router: one place that decides which provider and model an
 * operation runs on.
 *
 * # Why this is a service and not a set of rules in the agents
 *
 * NewPi does not own a provider registry, and this plugin does not build one.
 * The harness already has exactly one — `ctx.llm`, an adapter registry with a
 * streaming call API — and the agent layer already has exactly one selection
 * value, the `ModelSelection` triple (`provider`, `model`, `reasoningEffort`)
 * an agent resolves its requests from. What was missing was the *policy*: which
 * of those triples a request gets, by mode and by role. That policy lives here,
 * once, so no agent has to know a provider's name to ask for a kind of work:
 *
 * ```js
 * const selection = ctx.modelRouter.forRole('coding');
 * for await (const chunk of ctx.modelRouter.stream('review', request, { sessionId })) { … }
 * ```
 *
 * # The three modes
 *
 * - `manual` — the configured selection, and nothing else. No role, no
 *   automatic decision. `switchTo()` refuses, because in this mode the
 *   configuration *is* the decision.
 * - `switch` — one active selection, replaced at runtime by `switchTo()`. The
 *   change applies to the next operation and is journalled.
 * - `auto` — a selection per requested role. An unmapped role resolves to
 *   `default`, and `switchTo({ …, role })` overrides one role at runtime.
 *
 * In every mode the process-wide default selection (`agentDefaultModel`, the
 * service the harness creates fresh agents from) follows the mode's active
 * route, so an agent that does not ask for a role still starts where the plan
 * pointed. `auto` additionally exposes the per-role routes through `forRole()`.
 *
 * # Session safety
 *
 * Every operation that goes through `stream()` takes a {@link ModelLease}
 * first, and a lease's selection is frozen when it is taken. A switch, a mode
 * change or a role override therefore affects the operations that start after
 * it and never the one already running. A *critical* lease (the default) also
 * refuses a switch outright until it ends, which is what keeps an atomic step
 * from being announced as one model and completed with another.
 *
 * # Fallback
 *
 * A role may declare a fallback route. It is used only when the primary failed
 * with a provider-availability failure — unavailable provider, timeout, quota,
 * rate limit, network error, temporarily missing model — and only before the
 * caller has received any output, because re-dispatching after partial output
 * would duplicate it. A functional or logical failure of the model never falls
 * back: switching provider would not fix it and would hide the real cause.
 * Every fallback is journalled with its reason.
 *
 * # Observability
 *
 * Every call — routed or not — produces one record carrying the active mode,
 * the requested role, the provider and model used, the fallback and its reason,
 * and the session and operation identities. The record never carries a message,
 * a prompt, or a credential; a diagnostic that reaches it is scrubbed first.
 *
 * @module newpi-plugin-model-router
 */

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import { ADAPTIVE_MODEL, ADAPTIVE_PROVIDER, AdaptiveAdapter, adaptiveStream } from './adaptive.js';
import { DEFAULT_ROLE, MODES, ROLES, assertRole, parsePlan, routeSelection } from './plan.js';
import {
  ModelLease,
  RouterError,
  describeFailure,
  deriveCapabilities,
  isFallbackEligible,
  meetsRequirements,
  mergeCapabilities,
  normalizeSelection,
  redact,
  sameSelection,
} from './routing.js';

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'model-router';

/** The one service this plugin needs: the harness's adapter registry. */
export const inject = ['llm'];

/**
 * The exact keys one journal record may carry.
 *
 * Exported so a test can prove the contract: a record that grew a `messages` or
 * an `apiKey` field by accident has to fail here rather than in a log.
 */
export const RECORD_KEYS = Object.freeze([
  'at',
  'operation',
  'mode',
  'role',
  'provider',
  'model',
  'reasoningEffort',
  'sessionId',
  'operationId',
  'outcome',
  'from',
  'fallback',
  'failure',
]);

/**
 * The plugin's configuration: the plan, exactly as the launcher patch carries
 * it. Nothing else is configurable from NewPi, and a credential has no field to
 * arrive in.
 */
export const Config = z.object({
  /** The routing plan, as JSON. Written by NewPi's Rust side. */
  plan: z.string(),
  /** How many journal records to retain for the interface. */
  journalLimit: z.number().default(200),
});

/** Requests this router dispatched, so its own waterfall listener skips them. */
const ROUTED = new WeakSet();

/** The Model router service, reachable as `ctx.modelRouter`. */
export class ModelRouterService extends Service {
  // The members below are underscore-prefixed rather than `#private` on
  // purpose. Cordis resolves a service through a tracing shadow that forwards
  // method calls with a borrowed receiver, and JavaScript private members are
  // reachable only from the exact instance — a `#record()` would throw
  // "Receiver must be an instance of class ModelRouterService" the first time
  // the harness called `ctx.modelRouter.stream()`. The underscore is the
  // documentation; nothing outside this file may use them.

  /** The validated plan. */
  plan;
  /** `role -> selection`, the runtime overrides `switchTo()` created. */
  overrides = new Map();
  /** The active leases, keyed by identity. */
  activeLeases = new Set();
  /** The retained journal, oldest first. */
  journal = [];
  /** The registered journal listeners. */
  listeners = new Set();
  /** The active mode, mutable through `setMode()`. */
  currentMode;
  /** The active selection in `switch` mode, mutable through `switchTo()`. */
  currentActive;
  /** How many journal records are retained. */
  _journalLimit;
  /** Monotonic lease-id counter. */
  _sequence = 0;

  /**
   * @param ctx - the owning Cordis context, carrying `llm`.
   * @param config - the plugin row's configuration.
   * @throws {import('./plan.js').PlanError} when the plan is missing or invalid.
   */
  constructor(ctx, config = {}) {
    // The plan is parsed before `super()` on purpose: `Service` registers the
    // instance as it is constructed, so a plan that does not validate must
    // throw before there is anything registered. A half-mounted router whose
    // every call throws would be worse than a row that failed to load.
    const plan = parsePlan(config.plan);
    super(ctx, 'modelRouter');
    this.plan = plan;
    this.currentMode = plan.mode;
    this.currentActive = plan.active;
    this._journalLimit = Number.isInteger(config.journalLimit) ? config.journalLimit : 200;
  }

  // ------------------------------------------------------------ the mode

  /**
   * The active mode.
   *
   * @returns `manual`, `switch` or `auto`.
   */
  mode() {
    return this.currentMode;
  }

  /**
   * Change the mode at runtime.
   *
   * A mode change affects only operations that start afterwards; a lease
   * already taken keeps its selection.
   *
   * @param mode - the mode to switch to.
   * @returns the new mode.
   * @throws {RouterError} when the mode is unknown or the plan cannot support it.
   */
  setMode(mode) {
    if (!MODES.includes(mode)) {
      throw new RouterError(
        'MODEL_ROUTER_MODE',
        `unknown mode ${JSON.stringify(mode)}; use ${MODES.join(', ')}`,
      );
    }
    if (mode === 'manual' && this.plan.manual === undefined) {
      throw new RouterError('MODEL_ROUTER_MODE', 'manual mode needs a manual provider and model');
    }
    if (mode === 'switch' && this.plan.active === undefined) {
      throw new RouterError('MODEL_ROUTER_MODE', 'switch mode needs an active provider and model');
    }
    if (mode === 'auto' && this.plan.roles[DEFAULT_ROLE] === undefined) {
      throw new RouterError('MODEL_ROUTER_MODE', 'auto mode needs a default role');
    }
    const from = this.currentMode;
    this.currentMode = mode;
    this._record({ operation: 'mode', outcome: 'applied', from: { mode: from } });
    return mode;
  }

  /**
   * The selection a new operation gets right now.
   *
   * In `auto` mode this is the `default` role's route, or the runtime override
   * placed on it — not a promise that every role resolves here. A caller that
   * wants its role's route asks for it with `forRole()`.
   *
   * @returns the selection.
   */
  active() {
    if (this.currentMode === 'manual') return this.plan.manual;
    if (this.currentMode === 'switch') return this.currentActive;
    return this._routeFor(DEFAULT_ROLE).selection;
  }

  // ------------------------------------------------------------ resolution

  /**
   * Resolve the route one role runs on, without any I/O.
   *
   * This is the call an agent makes instead of naming a model. It never
   * consults a provider and never falls back: it answers from the plan, so it
   * is safe to call while assembling a request. Capability checking belongs to
   * `resolve()` and `lease()`, which can read a provider's metadata.
   *
   * @param role - the task role asked for.
   * @returns the frozen selection.
   * @throws {import('./plan.js').PlanError} when the role is not in the vocabulary.
   */
  forRole(role) {
    assertRole(role);
    return this._routeFor(role).selection;
  }

  /**
   * Resolve the route one role runs on, checking it can do the work.
   *
   * The role's declared requirements are applied to the *requested* role, even
   * when the role itself is unmapped and resolves to `default`: the caller
   * asked for a kind of work, and that is what has to be possible. When the
   * primary route cannot do it and the role declares a fallback that can, the
   * fallback is chosen; when neither can, this refuses rather than silently
   * running a model that cannot do the task.
   *
   * @param role - the task role asked for.
   * @param options - the resolution.
   * @param options.require - additional capability requirements for this call.
   * @returns the frozen `{ role, selection, fallback, capabilities, required, checked }`.
   * @throws {RouterError} when no candidate route satisfies the requirements.
   */
  async resolve(role, options = {}) {
    assertRole(role);
    const route = this._routeFor(role);
    const required = Object.freeze({
      ...(this.plan.requirements[role] ?? {}),
      ...(options.require ?? {}),
    });

    const candidates = [{ selection: route.selection, declared: route.capabilities, fallback: route.fallback }];
    if (route.fallback !== undefined) {
      candidates.push({ selection: route.fallback, declared: undefined, fallback: undefined });
    }

    const checked = [];
    for (const candidate of candidates) {
      const capabilities = await this.capabilities(
        candidate.selection.provider,
        candidate.selection.model,
        candidate.declared,
      );
      const verdict = meetsRequirements(capabilities, required);
      checked.push(
        Object.freeze({
          provider: candidate.selection.provider,
          model: candidate.selection.model,
          capabilities,
          missing: verdict.missing,
          unknown: verdict.unknown,
        }),
      );
      if (verdict.capable) {
        return Object.freeze({
          role,
          selection: candidate.selection,
          fallback: candidate.fallback,
          capabilities: capabilities ?? Object.freeze({}),
          required,
          checked: Object.freeze(checked),
        });
      }
    }

    const reasons = checked
      .map((entry) => `${entry.provider}/${entry.model} lacks ${entry.missing.join(', ')}`)
      .join('; ');
    throw new RouterError(
      'MODEL_ROUTER_INCAPABLE',
      `no route for role ${JSON.stringify(role)} satisfies the requirements: ${reasons}`,
    );
  }

  /**
   * What one route can do, declared capabilities over disclosed ones.
   *
   * A provider that cannot answer the metadata query is not a failure: the
   * route simply has unknown capabilities, which is reported as such.
   *
   * @param provider - the provider route.
   * @param model - the model id.
   * @param declared - the plan's declaration for this route, if any.
   * @returns the frozen merged capabilities (possibly empty).
   */
  async capabilities(provider, model, declared) {
    let derived;
    try {
      derived = deriveCapabilities(await this.ctx.llm.resolveModelInfo(provider, model));
    } catch (error) {
      this._warn(`could not read capabilities of ${provider}/${model}: ${this._scrub(error)}`);
      derived = undefined;
    }
    return mergeCapabilities(declared, derived) ?? Object.freeze({});
  }

  // ------------------------------------------------------------ leases

  /**
   * Capture a role's route for one operation.
   *
   * The returned lease's selection does not change, whatever a concurrent
   * `switchTo()` or `setMode()` does. Call `release()` when the operation ends;
   * `stream()` does it for the operations it dispatches.
   *
   * @param role - the task role asked for.
   * @param meta - the operation's identity and needs.
   * @param meta.sessionId - session the operation belongs to.
   * @param meta.operationId - operation identity, for the journal.
   * @param meta.critical - whether a switch must wait for this lease (default true).
   * @param meta.require - additional capability requirements.
   * @returns the lease.
   * @throws {RouterError} when no candidate route satisfies the requirements.
   */
  async lease(role, meta = {}) {
    const resolved = await this.resolve(role, { require: meta.require });
    const lease = new ModelLease({
      id: `${++this._sequence}`,
      role,
      selection: resolved.selection,
      fallback: resolved.fallback,
      sessionId: meta.sessionId,
      operationId: meta.operationId,
      critical: meta.critical !== false,
      acquiredAt: Date.now(),
      onRelease: (released) => this.activeLeases.delete(released),
    });
    this.activeLeases.add(lease);
    return lease;
  }

  /**
   * The leases currently held, as plain summaries.
   *
   * @returns the summaries, oldest first.
   */
  leases() {
    return [...this.activeLeases].map((lease) =>
      Object.freeze({
        id: lease.id,
        role: lease.role,
        provider: lease.selection.provider,
        model: lease.selection.model,
        critical: lease.critical,
        sessionId: lease.sessionId ?? null,
        operationId: lease.operationId ?? null,
        acquiredAt: lease.acquiredAt,
      }),
    );
  }

  // ------------------------------------------------------------ switching

  /**
   * Replace the active route while NewPi runs.
   *
   * This is the SWITCH mode's whole API: no configuration file is edited, the
   * change is journalled, and it applies to the next operation. Operations that
   * already hold a lease keep the route they captured — and while a *critical*
   * lease is held, this refuses rather than letting an atomic step be split
   * across two providers.
   *
   * @param selection - the new `{ provider, model, reasoningEffort? }`.
   * @param options - the switch.
   * @param options.role - in `auto` mode, the role to override (default `default`).
   * @param options.force - replace the route even while a critical lease is held.
   * @returns the selection that was applied.
   * @throws {RouterError} in `manual` mode, while busy, or on a malformed selection.
   */
  async switchTo(selection, options = {}) {
    if (this.currentMode === 'manual') {
      throw new RouterError(
        'MODEL_ROUTER_READ_ONLY',
        'manual mode is imposed by the configuration; change model_router.manual and relaunch',
      );
    }
    const next = normalizeSelection(selection, 'switchTo');
    const critical = [...this.activeLeases].filter((lease) => lease.critical);
    if (critical.length > 0 && options.force !== true) {
      throw new RouterError(
        'MODEL_ROUTER_BUSY',
        `${critical.length} critical operation(s) in flight; the switch would not affect them, ` +
          'and was refused so the new route is never half applied',
      );
    }

    if (this.currentMode === 'switch') {
      const from = this.currentActive;
      this.currentActive = next;
      await this.publishDefault();
      this._record({
        operation: 'switch',
        role: null,
        provider: next.provider,
        model: next.model,
        reasoningEffort: next.reasoningEffort,
        outcome: 'applied',
        from: from === undefined ? null : Object.freeze({ provider: from.provider, model: from.model }),
      });
      return next;
    }

    const role = options.role ?? DEFAULT_ROLE;
    assertRole(role);
    const from = this._routeFor(role).selection;
    this.overrides.set(role, next);
    if (role === DEFAULT_ROLE) await this.publishDefault();
    this._record({
      operation: 'switch',
      role,
      provider: next.provider,
      model: next.model,
      reasoningEffort: next.reasoningEffort,
      outcome: 'applied',
      from: Object.freeze({ provider: from.provider, model: from.model }),
    });
    return next;
  }

  /**
   * Make the process-wide default selection follow this mode's active route.
   *
   * The harness creates agents from `agentDefaultModel`; pointing it at the
   * route the plan chose is what makes MANUAL and SWITCH change what an
   * ordinary agent runs on, and what makes AUTO's `default` role the baseline
   * every unmapped role starts from. Nothing is written when the selection is
   * already current, and a deployment without that service — or without a
   * settings provider, where `saveSelection` is a documented no-op — costs
   * nothing.
   *
   * @returns whether a write happened.
   */
  async publishDefault() {
    // Nothing in here may reject: `apply` calls it without awaiting, and a
    // settings write must never become an unhandled rejection during a mount.
    try {
      const target = this.ctx.get('agentDefaultModel');
      if (target === undefined || typeof target.saveSelection !== 'function') return false;
      const selection = this.active();
      if (selection === undefined) return false;
      if (typeof target.currentSelection === 'function') {
        const current = target.currentSelection();
        if (current !== undefined && sameSelection(current, selection)) return false;
      }
      await target.saveSelection({ ...selection });
      return true;
    } catch (error) {
      this._warn(`could not record the default model: ${this._scrub(error)}`);
      return false;
    }
  }

  // ------------------------------------------------------------ calls

  /**
   * Run one model call under a role, with fallback and observability.
   *
   * The operation takes a lease first, so its route is fixed for its whole
   * duration. If the primary route fails with a provider-availability failure
   * *before any chunk reached the caller*, the role's fallback is dispatched
   * instead and the reason is journalled; otherwise the terminal chunk is
   * yielded as the provider produced it. An error thrown by the harness or by a
   * downstream consumer is rethrown, never turned into a route change.
   *
   * @param role - the task role asked for.
   * @param request - the request without a route; `provider` and `model` are
   *   overwritten from the resolved selection, which is the point.
   * @param meta - the operation's identity and needs.
   * @param meta.sessionId - session the operation belongs to.
   * @param meta.operationId - operation identity, for the journal.
   * @param meta.critical - whether a switch must wait for this call (default true).
   * @param meta.require - additional capability requirements.
   * @returns the harness's chunk stream.
   */
  async *stream(role, request, meta = {}) {
    const lease = await this.lease(role, meta);
    try {
      yield* this._dispatch(lease, request, meta);
    } finally {
      lease.release();
    }
  }

  /**
   * Dispatch one leased operation, moving to the fallback at most once.
   *
   * @param lease - the captured route.
   * @param request - the caller's request.
   * @param meta - the operation's identity.
   * @returns the chunk stream.
   */
  async *_dispatch(lease, request, meta) {
    const sessionId = meta.sessionId ?? request?.sessionId ?? null;
    let attempt = { selection: lease.selection, isFallback: false };
    let fallbackRecord = null;

    for (;;) {
      let emitted = false;
      const options = this._optionsFor(request, attempt.selection, lease);
      ROUTED.add(options);
      const identity = {
        provider: attempt.selection.provider,
        model: attempt.selection.model,
        reasoningEffort: attempt.selection.reasoningEffort,
        role: lease.role,
        sessionId,
        operationId: meta.operationId ?? null,
        fallback: fallbackRecord,
      };

      try {
        for await (const chunk of this.ctx.llm.stream(options)) {
          const finish = chunk?.type === 'finish' ? chunk.reason ?? {} : null;
          if (finish === null) {
            // Any chunk the caller sees commits this attempt: re-dispatching
            // after partial output would duplicate it.
            emitted = true;
            yield chunk;
            continue;
          }
          if (
            finish.kind === 'error' &&
            !emitted &&
            !attempt.isFallback &&
            lease.fallback !== undefined &&
            isFallbackEligible(finish.failure)
          ) {
            fallbackRecord = Object.freeze({
              from: Object.freeze({
                provider: attempt.selection.provider,
                model: attempt.selection.model,
              }),
              to: Object.freeze({
                provider: lease.fallback.provider,
                model: lease.fallback.model,
              }),
              reason: describeFailure(finish.failure),
            });
            break;
          }
          this._record({
            ...identity,
            operation: 'call',
            outcome:
              finish.kind === 'error' ? 'error' : finish.kind === 'aborted' ? 'aborted' : 'completed',
            failure: finish.kind === 'error' ? describeFailure(finish.failure) : null,
          });
          yield chunk;
          return;
        }
      } catch (error) {
        // A thrown error at this boundary is not the adapter's: the harness
        // normalizes adapter failures into finish chunks. It is therefore an
        // application failure, and an application failure never changes route.
        this._record({
          ...identity,
          operation: 'call',
          outcome: 'threw',
          failure: describeFailure({ code: 'THROWN', message: error?.message }),
        });
        throw error;
      }

      if (fallbackRecord === null) {
        // The stream ended without a terminal finish chunk; nothing to record
        // beyond the completion the caller will observe.
        this._record({ ...identity, operation: 'call', outcome: 'completed' });
        return;
      }

      this._warn(
        `${identity.provider}/${identity.model} unavailable ` +
          `(${fallbackRecord.reason.code}); falling back to ` +
          `${fallbackRecord.to.provider}/${fallbackRecord.to.model}`,
      );
      attempt = { selection: lease.fallback, isFallback: true };
    }
  }

  /**
   * The request the harness sees: the caller's, with the route it may not choose.
   *
   * @param request - the caller's request.
   * @param selection - the route the lease captured.
   * @param lease - the lease, for the session identity.
   * @returns a new request object.
   */
  _optionsFor(request, selection, lease) {
    const options = {
      ...request,
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    };
    if (options.reasoningEffort === undefined) delete options.reasoningEffort;
    if (options.sessionId === undefined && lease.sessionId !== undefined) {
      options.sessionId = lease.sessionId;
    }
    return options;
  }

  // ------------------------------------------------------------ observability

  /**
   * Record one call the router did not dispatch.
   *
   * The plugin's `llm/stream` listener wraps every request the harness makes,
   * so a call that bypassed `stream()` is still attributable to the active mode
   * and the provider and model it actually used. It carries no role, because
   * nothing asked for one.
   *
   * @param options - the request as the waterfall saw it.
   * @param source - the stream the waterfall would have returned.
   * @returns the same chunks, with one record appended at the end.
   */
  async *observe(options, source) {
    const identity = {
      provider: typeof options?.provider === 'string' ? options.provider : null,
      model: typeof options?.model === 'string' ? options.model : null,
      reasoningEffort: options?.reasoningEffort ?? null,
      role: null,
      sessionId: options?.sessionId ?? null,
      operationId: null,
      fallback: null,
    };
    let outcome = 'completed';
    let failure = null;
    try {
      for await (const chunk of source) {
        if (chunk?.type === 'finish') {
          if (chunk.reason?.kind === 'error') {
            outcome = 'error';
            failure = describeFailure(chunk.reason.failure);
          } else if (chunk.reason?.kind === 'aborted') {
            outcome = 'aborted';
          }
        }
        yield chunk;
      }
    } catch (error) {
      this._record({
        ...identity,
        operation: 'external',
        outcome: 'threw',
        failure: describeFailure({ code: 'THROWN', message: error?.message }),
      });
      throw error;
    }
    this._record({ ...identity, operation: 'external', outcome, failure });
  }

  /**
   * Subscribe to every journal record.
   *
   * @param listener - called with each frozen record.
   * @returns a disposer that unregisters the listener.
   */
  onCall(listener) {
    if (typeof listener !== 'function') {
      throw new RouterError('MODEL_ROUTER_INVALID_LISTENER', 'a call listener must be a function');
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The most recent journal records.
   *
   * @param limit - how many to return, most recent last.
   * @returns the records.
   */
  recentCalls(limit = 50) {
    if (!Number.isInteger(limit) || limit < 0) return [];
    return this.journal.slice(Math.max(0, this.journal.length - limit));
  }

  /**
   * A snapshot of the router for an interface.
   *
   * @returns the mode, the active route, every role's route, the runtime
   *   overrides, and the leases in flight.
   */
  describe() {
    const roles = {};
    for (const role of ROLES) roles[role] = this.forRole(role);
    return Object.freeze({
      mode: this.currentMode,
      active: this.active(),
      roles: Object.freeze(roles),
      requirements: this.plan.requirements,
      overrides: Object.freeze(Object.fromEntries(this.overrides)),
      leases: Object.freeze(this.leases()),
    });
  }

  // ------------------------------------------------------------ internals

  /**
   * The plan route one role resolves to, without validation or I/O.
   *
   * @param role - a role from the vocabulary.
   * @returns `{ selection, fallback, capabilities }`.
   */
  _routeFor(role) {
    if (this.currentMode === 'manual') {
      return { selection: this.plan.manual, fallback: undefined, capabilities: undefined };
    }
    if (this.currentMode === 'switch') {
      return { selection: this.currentActive, fallback: undefined, capabilities: undefined };
    }
    const mapped = this.plan.roles[role] ?? this.plan.roles[DEFAULT_ROLE];
    const direct = this.overrides.get(role);
    const inherited = this.plan.roles[role] === undefined ? this.overrides.get(DEFAULT_ROLE) : undefined;
    return {
      selection: direct ?? inherited ?? routeSelection(mapped),
      fallback: mapped.fallback,
      capabilities: mapped.capabilities,
    };
  }

  /**
   * Append one journal record. The shape is fixed by {@link RECORD_KEYS}: a
   * record cannot grow a field carrying a prompt or a credential.
   *
   * @param entry - the record's own fields.
   * @returns the frozen record.
   */
  _record(entry) {
    const record = {
      at: Date.now(),
      operation: entry.operation,
      mode: this.currentMode,
      role: entry.role ?? null,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      reasoningEffort: entry.reasoningEffort ?? null,
      sessionId: entry.sessionId ?? null,
      operationId: entry.operationId ?? null,
      outcome: entry.outcome ?? 'completed',
      from: entry.from ?? null,
      fallback: entry.fallback ?? null,
      failure: entry.failure ?? null,
    };
    Object.freeze(record);
    this.journal.push(record);
    if (this.journal.length > this._journalLimit) {
      this.journal.splice(0, this.journal.length - this._journalLimit);
    }
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (error) {
        this._warn(`a call listener failed: ${this._scrub(error)}`);
      }
    }
    return record;
  }

  /** Scrub one diagnostic before it is logged. */
  _scrub(error) {
    return redact(error?.message ?? String(error));
  }

  /** Log a routing warning, if the context has a logger. */
  _warn(message) {
    this.ctx.logger?.warn?.(`${name}: ${message}`);
  }
}

/**
 * Mount the router: read the plan, register the service, and watch every call.
 *
 * @param ctx - the owning Cordis context.
 * @param config - the plugin row's configuration.
 * @throws {import('./plan.js').PlanError} when the plan is missing or invalid.
 */
export function apply(ctx, config = {}) {
  const router = new ModelRouterService(ctx, config);

  // The router's own provider route, so the picker can offer a selection that
  // *is* the policy: `newpi-router/adaptive`. The catalog and the model
  // metadata come from the plan's own routes; the decision itself lives in the
  // waterfall below, where the request is rewritten before dispatch so the
  // logged route is the one that answered.
  ctx.llm.registerAdapter([ADAPTIVE_PROVIDER], new AdaptiveAdapter(ctx, router.plan));

  // Every model call, routed or not, is observed. The waterfall is the only
  // seam that sees requests this plugin did not originate, and calling `next()`
  // first keeps the router out of the call's path: it records, it does not
  // reroute. The adaptive route is the one exception, and it is the point: a
  // request that selected `newpi-router/adaptive` asked for exactly this
  // decision, so the router resolves the role and rewrites the request in
  // place — the harness logs the route that answered, not the pseudo-route.
  ctx.on('llm/stream', (options, next) => {
    if (options.provider === ADAPTIVE_PROVIDER) {
      return adaptiveStream(options, {
        plan: router.plan,
        active: () => {
          try {
            return router.active();
          } catch {
            return undefined;
          }
        },
        next,
        warn: (message) => ctx.logger?.warn?.(message),
      });
    }
    const stream = next();
    if (ROUTED.has(options)) return stream;
    return router.observe(options, stream);
  });

  // The mode's active route becomes the process-wide default, so an agent that
  // never asks for a role still starts where the plan pointed. It never
  // rejects: a settings write cannot be allowed to fail the mount.
  void router.publishDefault();

  ctx.logger?.info?.(
    `${name}: mode=${router.mode()} actif=${router.active()?.provider}/${router.active()?.model} ` +
      `adaptatif=${ADAPTIVE_PROVIDER}/${ADAPTIVE_MODEL}`,
  );
}

export { PlanError } from './plan.js';
export { RouterError, isFallbackEligible } from './routing.js';
export { MODES, ROLES } from './plan.js';
export {
  ADAPTIVE_DESCRIPTION,
  ADAPTIVE_MODEL,
  ADAPTIVE_NAME,
  ADAPTIVE_PROVIDER,
  AdaptiveAdapter,
  adaptiveChain,
  adaptiveRoleFor,
  adaptiveStream,
  applySelection,
  estimateRequestTokens,
} from './adaptive.js';
