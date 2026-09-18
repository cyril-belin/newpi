/**
 * The Context & Cache Manager: one place that names the context a model call
 * was made of, and reports the provider's own cache counters for it.
 *
 * # What it is
 *
 * A NewPi plugin — a Cordis overlay, not a second shell. It reuses the
 * abstractions the harness already has and adds exactly three things DSH does
 * not:
 *
 * - **a layer model for the prompt** (see `context.js`): `core`, `project`,
 *   `handoff`, `session`, `live`, each reduced to a digest and a count;
 * - **versions for the two things worth versioning**: the cacheable prefix
 *   (`ctx_vN`) and the handoff between two compactions (`handoff_vN`);
 * - **a per-call telemetry record** that joins the route, the context version,
 *   the handoff version, the provider's reported cache counters, and the
 *   project the call belongs to.
 *
 * # The project binding
 *
 * One NewPi process runs one current project, and the Project Model is its
 * source of truth. This manager does not resolve that itself: the project
 * service binds it with {@link ContextCacheService#bindProject}, and every
 * record then carries the project id and its memory namespace. The binding is
 * what lets a cache window be read per project instead of mixing the calls of
 * two projects that happen to share this process, and it is why the manager
 * needs no project configuration of its own.
 *
 * # What it is not
 *
 * It is **not** a cache. It never stores a prompt, never serves a prefix,
 * never estimates a hit. The only numbers it reports are counters an adapter
 * emitted, or arithmetic over those counters. A provider that reports no cache
 * metrics produces `available: false` and a reason — an absence of data, never
 * an error, and never a fabricated zero. The manager also never mutates a
 * request: it observes the `llm/stream` waterfall, it does not sit in it.
 *
 * # The three seams it uses
 *
 * | Seam | What it yields |
 * | ---- | -------------- |
 * | `system-prompt/assemble` (waterfall) | the `core` and `project` layers, from the assembled sections and contexts |
 * | `llm/stream` (waterfall) | the `session` and `live` layers, and the `usage` chunk's cache counters |
 * | `session/event` | the `compaction/*` events that mint and freeze handoffs |
 *
 * Every seam is optional. A deployment without `ctx.systemPrompt` still gets a
 * `core` layer from the request's own system messages; a deployment whose
 * adapters report no usage still gets correct layer and version bookkeeping.
 *
 * # Additivity
 *
 * Nothing here changes a routing decision. The plugin mounts with no
 * configuration, has no `inject` dependency, and only ever reads. Its API is
 * the data a later cache-aware Model Router policy would consume — deliberately
 * prepared now and deliberately not wired into the AUTO policy yet.
 *
 * @module newpi-plugin-context-cache-manager
 */

import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import {
  LAYERS,
  SessionContext,
  contextLabel,
  handoffLabel,
} from './context.js';
import {
  DEFAULT_TEMPERATURE_OPTIONS,
  cacheFromUsage,
  describeFailure,
  estimateTemperature,
  normalizeUsage,
  redact,
  temperaturesByRoute,
} from './cache.js';

/** Plugin name, matching the row id NewPi writes into its launcher patch. */
export const name = 'context-cache-manager';

/**
 * The manager needs no service to mount.
 *
 * This is load-bearing, not an oversight. A manager that waited for `llm` or
 * `systemPrompt` would vanish on exactly the minimal deployments whose cache
 * behaviour is worth measuring, and "the feature is absent" would be
 * indistinguishable from "the feature observed nothing". It reads every seam
 * through an event subscription, which costs nothing when the seam is absent.
 */
export const inject = [];

/**
 * The exact keys one telemetry record may carry.
 *
 * Exported so a test can prove the contract: a record that grew a `messages`,
 * `prompt` or `apiKey` field by accident has to fail here rather than in a log.
 */
export const RECORD_KEYS = Object.freeze([
  'at',
  'callId',
  'provider',
  'model',
  'reasoningEffort',
  'sessionId',
  'operationId',
  'purpose',
  'projectId',
  'projectNamespace',
  'contextVersion',
  'contextLabel',
  'handoffVersion',
  'handoffLabel',
  'outcome',
  'failure',
  'usage',
  'cache',
  'layers',
]);

/** The layer names a per-call record reduces the context to. */
export const RECORDED_LAYERS = LAYERS;

/**
 * The plugin's configuration. Every field has a default, so an empty row — the
 * one NewPi writes — mounts a working manager, and the feature being
 * "unconfigured" changes no behaviour at all.
 */
export const Config = z.object({
  /** How many telemetry records to retain for the interface and the router. */
  journalLimit: z.number().default(200),
  /** How long an assembled prompt stays attachable to the next call. */
  assemblyTtlMs: z.number().default(5000),
  /** How many recent calls with cache data the temperature average uses. */
  window: z.number().default(DEFAULT_TEMPERATURE_OPTIONS.window),
  /** At or above this average hit ratio, a fresh route is `hot`. */
  hotRatio: z.number().default(DEFAULT_TEMPERATURE_OPTIONS.hotRatio),
  /** Strictly above this average, a fresh route is `warm`. */
  warmRatio: z.number().default(DEFAULT_TEMPERATURE_OPTIONS.warmRatio),
  /** How long a `hot` route stays hot without a fresh hit. */
  hotTtlMs: z.number().default(DEFAULT_TEMPERATURE_OPTIONS.hotTtlMs),
  /** How long any cache history stays meaningful at all. */
  warmTtlMs: z.number().default(DEFAULT_TEMPERATURE_OPTIONS.warmTtlMs),
});

/**
 * The Context & Cache Manager service, reachable as `ctx.contextCache`.
 *
 * The members below are underscore-prefixed rather than `#private` on purpose,
 * for the same reason `model-router` documents: Cordis resolves a service
 * through a tracing shadow that forwards method calls with a borrowed
 * receiver, and JavaScript private members are reachable only from the exact
 * instance. The underscore is the documentation; nothing outside this file may
 * use them.
 */
export class ContextCacheService extends Service {
  /** Per-session context ledgers, keyed by session id (or a synthetic key). */
  sessions = new Map();
  /** The retained telemetry journal, oldest first. */
  journal = [];
  /** The registered journal listeners. */
  listeners = new Set();
  /** The last assembled prompt, for calls that arrive before one is keyed. */
  lastAssembly = null;
  /** When {@link lastAssembly} was observed, in epoch milliseconds. */
  lastAssemblyAt = 0;
  /** The session {@link lastAssembly} was keyed to, or `null` when it named none. */
  lastAssemblySessionId = null;
  /**
   * The project the manager is bound to, or `null`.
   *
   * Set by the Project Model service through {@link ContextCacheService#bindProject}.
   * The manager never resolves a project itself: the project is the source of
   * truth, and a second answer here would be exactly the drift the binding
   * exists to prevent.
   */
  _project = null;
  /** How many records are retained. */
  _journalLimit;
  /** How long a last assembly stays attachable, in milliseconds. */
  _assemblyTtlMs;
  /** The temperature estimate's thresholds. */
  _temperature;
  /** Monotonic telemetry-id counter. */
  _sequence = 0;
  /** The synthetic ledger key for calls the harness did not attribute. */
  _unattributed = Symbol('unattributed');

  /**
   * @param ctx - the owning Cordis context.
   * @param config - the plugin row's configuration, every field optional.
   */
  constructor(ctx, config = {}) {
    super(ctx, 'contextCache');
    this._journalLimit = Number.isInteger(config.journalLimit) ? config.journalLimit : 200;
    this._assemblyTtlMs = Number.isInteger(config.assemblyTtlMs) ? config.assemblyTtlMs : 5000;
    this._temperature = Object.freeze({
      window: Number.isInteger(config.window) ? config.window : DEFAULT_TEMPERATURE_OPTIONS.window,
      hotRatio:
        typeof config.hotRatio === 'number' ? config.hotRatio : DEFAULT_TEMPERATURE_OPTIONS.hotRatio,
      warmRatio:
        typeof config.warmRatio === 'number'
          ? config.warmRatio
          : DEFAULT_TEMPERATURE_OPTIONS.warmRatio,
      hotTtlMs:
        Number.isInteger(config.hotTtlMs) ? config.hotTtlMs : DEFAULT_TEMPERATURE_OPTIONS.hotTtlMs,
      warmTtlMs:
        Number.isInteger(config.warmTtlMs)
          ? config.warmTtlMs
          : DEFAULT_TEMPERATURE_OPTIONS.warmTtlMs,
    });
  }

  // ------------------------------------------------------- the context state

  /**
   * The ledger for one session, created on first sight.
   *
   * @param sessionId - the session id, or `null` for the unattributed ledger.
   * @returns the ledger.
   */
  stateFor(sessionId) {
    const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : this._unattributed;
    let state = this.sessions.get(key);
    if (state === undefined) {
      state = new SessionContext(typeof key === 'string' ? key : null);
      this.sessions.set(key, state);
    }
    return state;
  }

  /**
   * Record an assembled prompt as the `core` and `project` layers.
   *
   * The assembly context carries the agent, and an agent carries its session,
   * so the layers are keyed to the session that will make the call. A context
   * that names no session is still kept as the last assembly, so a call the
   * harness did not attribute is not left with an empty `core`.
   *
   * @param assembly - the resolved `PromptAssembly`.
   * @param context - the waterfall's `AssembleContext`.
   * @returns whether the cacheable prefix changed.
   */
  observeAssembly(assembly, context = {}) {
    const at = Date.now();
    this.lastAssembly = assembly;
    this.lastAssemblyAt = at;
    const sessionId = sessionIdOf(context);
    this.lastAssemblySessionId = sessionId;
    if (sessionId === null) return false;
    return this.stateFor(sessionId).observeAssembly(assembly, at);
  }

  /**
   * Record one `session/event`, minting and freezing handoffs.
   *
   * @param session - the session the event belongs to.
   * @param event - the appended session event.
   * @returns the committed handoff when this event committed one, else `null`.
   */
  observeSessionEvent(session, event) {
    const state = this.stateFor(typeof session?.id === 'string' ? session.id : null);
    const at = Date.now();
    switch (event?.type) {
      case 'compaction/start':
        state.beginCompaction({ compactionId: event.compactionId ?? null, turn: event.turn ?? null, at });
        return null;
      case 'compaction/summary':
        state.noteSummary({
          summary: event.summary,
          shadowedTokens: event.shadowedTokenCount,
          provider: event.provider,
          model: event.model,
          usage: normalizeUsage(event.usage),
          at,
        });
        return null;
      case 'compaction/prune':
        state.notePrune({ shadowedTokens: event.shadowedTokenCount, at });
        return null;
      case 'compaction/end':
        return state.finishCompaction({ error: event.error ?? null, at });
      default:
        return null;
    }
  }

  /**
   * Observe one model call's whole stream and record its telemetry at the end.
   *
   * The chunks are yielded exactly as the adapter produced them: this wrapper
   * reads, and the only thing it changes is the journal it keeps.
   *
   * @param options - the request, as the waterfall saw it.
   * @param source - the stream the waterfall would have returned.
   * @returns the same chunks.
   */
  async *observe(options, source) {
    const at = Date.now();
    const identity = this.identityFor(options, at);
    let usage = null;
    let outcome = 'completed';
    let failure = null;
    try {
      for await (const chunk of source) {
        if (chunk?.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage;
        else if (chunk?.type === 'finish') {
          const kind = chunk.reason?.kind;
          if (kind === 'error') {
            outcome = 'error';
            failure = describeFailure(chunk.reason.failure);
          } else if (kind === 'aborted') {
            outcome = 'aborted';
          }
        }
        yield chunk;
      }
    } catch (error) {
      this.record({ ...identity, at, usage, outcome: 'threw', failure: describeFailure(error) });
      throw error;
    }
    this.record({ ...identity, at, usage, outcome, failure });
  }

  /**
   * The context identity one call is attributed to.
   *
   * The layers are refreshed from the request before the version is read, so a
   * call that moved the `session` or `live` layer is recorded against the
   * prefix version that was actually in force — and a call whose assembly
   * changed the prefix is recorded against the *new* version, which is the one
   * a later call's cache hit would be measured against.
   *
   * @param options - the request.
   * @param at - when the call started.
   * @returns the identity fields a record carries.
   */
  identityFor(options, at = Date.now()) {
    const sessionId = stringOrNull(options?.sessionId);
    const state = this.stateFor(sessionId);
    if (
      state.core === null &&
      this.lastAssembly !== null &&
      at - this.lastAssemblyAt <= this._assemblyTtlMs &&
      (this.lastAssemblySessionId === null || this.lastAssemblySessionId === sessionId)
    ) {
      state.observeAssembly(this.lastAssembly, this.lastAssemblyAt);
    }
    state.observeRequest(options?.messages, at);
    return {
      provider: stringOrNull(options?.provider),
      model: stringOrNull(options?.model),
      reasoningEffort: stringOrNull(options?.reasoningEffort),
      sessionId,
      operationId: stringOrNull(options?.operationId),
      purpose: stringOrNull(options?.purpose),
      // Read at call time: a rebinding after the call started must not
      // retroactively move the record to another project.
      projectId: this._project?.id ?? null,
      projectNamespace: this._project?.namespace ?? null,
      contextVersion: state.contextVersion,
      contextLabel: contextLabel(state.contextVersion),
      handoffVersion: state.handoffVersion,
      handoffLabel: handoffLabel(state.handoffVersion),
      layers: state.layerDigests(),
    };
  }

  // ------------------------------------------------------------ telemetry

  /**
   * Append one telemetry record.
   *
   * The shape is fixed by {@link RECORD_KEYS}: a record cannot grow a field
   * carrying a prompt, a message or a credential. A failure to record is
   * swallowed — telemetry must never be able to fail a model call.
   *
   * @param entry - the record's own fields.
   * @returns the frozen record, or `null` when it could not be recorded.
   */
  record(entry) {
    try {
      const record = {
        at: Number.isInteger(entry.at) ? entry.at : Date.now(),
        callId: `${++this._sequence}`,
        provider: entry.provider ?? null,
        model: entry.model ?? null,
        reasoningEffort: entry.reasoningEffort ?? null,
        sessionId: entry.sessionId ?? null,
        operationId: entry.operationId ?? null,
        purpose: entry.purpose ?? null,
        projectId: entry.projectId !== undefined ? entry.projectId : this._project?.id ?? null,
        projectNamespace:
          entry.projectNamespace !== undefined ? entry.projectNamespace : this._project?.namespace ?? null,
        contextVersion: entry.contextVersion ?? 0,
        contextLabel: entry.contextLabel ?? contextLabel(entry.contextVersion),
        handoffVersion: entry.handoffVersion ?? 0,
        handoffLabel: entry.handoffLabel ?? handoffLabel(entry.handoffVersion),
        outcome: entry.outcome ?? 'completed',
        failure: entry.failure ?? null,
        usage: normalizeUsage(entry.usage),
        cache: cacheFromUsage(entry.usage),
        layers: entry.layers ?? null,
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
          this._warn(`a call listener failed: ${redact(error?.message ?? error)}`);
        }
      }
      return record;
    } catch (error) {
      this._warn(`could not record a call: ${redact(error?.message ?? error)}`);
      return null;
    }
  }

  /**
   * Subscribe to every telemetry record.
   *
   * @param listener - called with each frozen record.
   * @returns a disposer that unregisters the listener.
   */
  onCall(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('a call listener must be a function');
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The most recent telemetry records.
   *
   * @param limit - how many to return, most recent last.
   * @returns the records.
   */
  recentCalls(limit = 50) {
    if (!Number.isInteger(limit) || limit < 0) return [];
    return this.journal.slice(Math.max(0, this.journal.length - limit));
  }

  // ------------------------------------------------------------ the API

  /**
   * Bind the manager to a project, or release the binding with `null`.
   *
   * The binding is what attributes every later call to a project: a record
   * minted while a project is bound carries its id and memory namespace, so a
   * cache window can be read per project rather than across every project that
   * shared this process. Already-recorded calls keep the project they were made
   * under; a binding never rewrites history.
   *
   * @param project - `{ id, namespace }`, or `null` to release.
   * @returns the new binding, frozen, or `null`.
   * @throws {TypeError} when the project names no id.
   */
  bindProject(project) {
    if (project === null || project === undefined) return this.unbindProject();
    const id = typeof project.id === 'string' && project.id !== '' ? project.id : null;
    if (id === null) throw new TypeError('a bound project needs a non-empty id');
    this._project = Object.freeze({
      id,
      namespace:
        typeof project.namespace === 'string' && project.namespace !== '' ? project.namespace : id,
    });
    return this._project;
  }

  /**
   * Release the project binding. Later calls are recorded as unattributed.
   *
   * @returns `null`.
   */
  unbindProject() {
    this._project = null;
    return null;
  }

  /**
   * The project the manager is currently bound to.
   *
   * @returns the frozen `{ id, namespace }`, or `null`.
   */
  project() {
    return this._project;
  }

  /**
   * The current context state — the snapshot a UI would show.
   *
   * @param sessionId - the session to describe; the most recently updated one
   *   when omitted.
   * @returns the frozen snapshot, or `null` when nothing was observed yet.
   */
  current(sessionId) {
    if (typeof sessionId === 'string') {
      const state = this.sessions.get(sessionId);
      return state === undefined ? null : state.snapshot();
    }
    const latest = this._latest();
    return latest === null ? null : latest.snapshot();
  }

  /**
   * Every session's current context snapshot, most recently updated first.
   *
   * @returns the snapshots.
   */
  snapshots() {
    return [...this.sessions.values()]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map((state) => state.snapshot());
  }

  /**
   * The versions in force.
   *
   * @param sessionId - the session to read; the most recent when omitted.
   * @returns `{ contextVersion, contextLabel, handoffVersion, handoffLabel, prefix }`,
   *   or `null` when nothing was observed yet.
   */
  versions(sessionId) {
    const snapshot = this.current(sessionId);
    if (snapshot === null) return null;
    return Object.freeze({
      sessionId: snapshot.sessionId,
      contextVersion: snapshot.contextVersion,
      contextLabel: snapshot.contextLabel,
      handoffVersion: snapshot.handoffVersion,
      handoffLabel: snapshot.handoffLabel,
      prefix: snapshot.prefix,
      handoff: snapshot.handoff,
    });
  }

  /**
   * Aggregate cache statistics over the retained calls.
   *
   * Only calls whose provider reported cache counters contribute to the
   * sums; `callsWithCache` says how many there were, so a caller can always
   * tell "no hits" from "no data".
   *
   * @param filter - optional `{ provider, model, sessionId, projectId, limit }`.
   * @returns the frozen statistics.
   */
  cacheStats(filter = {}) {
    const records = this._filtered(filter);
    let callsWithCache = 0;
    let hitTokens = 0;
    let missTokens = 0;
    let writeTokens = 0;
    let promptTokens = 0;
    let outputTokens = 0;
    let inputTokens = 0;
    for (const record of records) {
      inputTokens += record.usage?.inputTokens ?? 0;
      outputTokens += record.usage?.outputTokens ?? 0;
      if (record.cache?.available === true) {
        callsWithCache += 1;
        hitTokens += record.cache.hitTokens ?? 0;
        missTokens += record.cache.missTokens ?? 0;
        writeTokens += record.cache.writeTokens ?? 0;
        promptTokens += record.cache.promptTokens ?? 0;
      }
    }
    return Object.freeze({
      calls: records.length,
      callsWithCache,
      available: callsWithCache > 0,
      inputTokens,
      outputTokens,
      hitTokens: callsWithCache > 0 ? hitTokens : null,
      missTokens: callsWithCache > 0 ? missTokens : null,
      writeTokens: callsWithCache > 0 ? writeTokens : null,
      promptTokens: callsWithCache > 0 ? promptTokens : null,
      averageHitRatio: promptTokens > 0 ? hitTokens / promptTokens : null,
      reason:
        callsWithCache > 0
          ? null
          : 'no retained call reported provider cache counters for this filter',
    });
  }

  /**
   * The cache temperature of one route, from the retained calls.
   *
   * @param provider - the provider route.
   * @param model - the model id.
   * @param options - overrides for the configured thresholds.
   * @returns the frozen estimate, `unknown` when no call reported cache data.
   */
  temperature(provider, model, options = {}) {
    const records = this._filtered({ provider, model }).filter((record) => record.cache?.available);
    return estimateTemperature(records, { ...this._temperature, ...(options ?? {}) });
  }

  /**
   * The temperature of every route that has been called, keyed `provider/model`.
   *
   * @param options - overrides for the configured thresholds.
   * @returns the frozen estimates.
   */
  temperatures(options = {}) {
    return temperaturesByRoute(this.journal, { ...this._temperature, ...(options ?? {}) });
  }

  /**
   * Everything a cache-aware Model Router policy would need about one route.
   *
   * This is the seam the router is expected to consume later. It is exposed
   * now and wired nowhere: no routing decision reads it, so the AUTO policy is
   * exactly what it was before this plugin existed.
   *
   * @param provider - the provider route.
   * @param model - the model id.
   * @returns the frozen hints: temperature, cache statistics, and the versions
   *   the most recent call on this route ran under.
   */
  hintsFor(provider, model) {
    const records = this._filtered({ provider, model });
    const latest = records.length === 0 ? null : records[records.length - 1];
    return Object.freeze({
      provider: provider ?? null,
      model: model ?? null,
      temperature: this.temperature(provider, model),
      stats: this.cacheStats({ provider, model }),
      lastCall: latest === null ? null : Object.freeze({ at: latest.at, callId: latest.callId }),
      contextVersion: latest?.contextVersion ?? null,
      contextLabel: latest?.contextLabel ?? null,
      handoffVersion: latest?.handoffVersion ?? null,
      handoffLabel: latest?.handoffLabel ?? null,
      cacheObservable: records.some((record) => record.cache?.available === true),
    });
  }

  /**
   * {@link hintsFor} for every route the journal has seen.
   *
   * @returns a frozen array of hints, most recently called route last.
   */
  allHints() {
    const routes = new Map();
    for (const record of this.journal) {
      if (record.provider === null || record.model === null) continue;
      routes.set(`${record.provider}/${record.model}`, { provider: record.provider, model: record.model });
    }
    return Object.freeze(
      [...routes.values()].map(({ provider, model }) => this.hintsFor(provider, model)),
    );
  }

  /**
   * A snapshot of the manager for an interface.
   *
   * @returns the frozen description: the versions, the context, the recent
   *   calls, the per-route temperatures and the configured thresholds.
   */
  describe() {
    return Object.freeze({
      project: this._project,
      sessions: Object.freeze(this.snapshots()),
      temperatures: this.temperatures(),
      recentCalls: Object.freeze(this.recentCalls(20)),
      stats: this.cacheStats(this._project === null ? {} : { projectId: this._project.id }),
      journalLength: this.journal.length,
      journalLimit: this._journalLimit,
      temperatureOptions: this._temperature,
    });
  }

  // ------------------------------------------------------------ internals

  /**
   * The ledger updated most recently.
   *
   * @returns the ledger, or `null` when nothing was observed yet.
   */
  _latest() {
    let latest = null;
    for (const state of this.sessions.values()) {
      if (state.updatedAt === null) continue;
      if (latest === null || state.updatedAt >= latest.updatedAt) latest = state;
    }
    return latest;
  }

  /**
   * The journal entries matching one filter, oldest first.
   *
   * @param filter - `{ provider, model, sessionId, limit }`, all optional.
   * @returns the records.
   */
  _filtered(filter = {}) {
    let records = this.journal;
    if (typeof filter.provider === 'string') {
      records = records.filter((record) => record.provider === filter.provider);
    }
    if (typeof filter.model === 'string') {
      records = records.filter((record) => record.model === filter.model);
    }
    if (typeof filter.sessionId === 'string') {
      records = records.filter((record) => record.sessionId === filter.sessionId);
    }
    if (typeof filter.projectId === 'string') {
      records = records.filter((record) => record.projectId === filter.projectId);
    }
    if (Number.isInteger(filter.limit) && filter.limit >= 0) {
      records = records.slice(Math.max(0, records.length - filter.limit));
    }
    return records;
  }

  /** Scrub one diagnostic before it is logged. */
  _scrub(error) {
    return redact(error?.message ?? String(error));
  }

  /** Log a manager warning, if the context has a logger. */
  _warn(message) {
    this.ctx.logger?.warn?.(`${name}: ${message}`);
  }
}

/**
 * The session an assembly context belongs to.
 *
 * The agent loop assembles with `{ agent, scope: agent }`, and an agent carries
 * its live session; reading it here is what attributes a stable prefix to the
 * session whose calls it will be sent on. Anything else — a hand-built context,
 * a deployment without the agent loop — yields `null`, and the assembly is then
 * only kept as the fallback.
 *
 * @param context - the waterfall's `AssembleContext`.
 * @returns the session id, or `null`.
 */
function sessionIdOf(context) {
  const agent = context?.agent ?? context?.scope;
  const id = agent?.session?.id ?? agent?.sessionId;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * A non-empty string, or `null`.
 *
 * @param value - the raw value.
 * @returns the value when it is a non-empty string, else `null`.
 */
function stringOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Mount the manager: register the service and subscribe to its three seams.
 *
 * None of the three subscriptions changes what the harness does — each calls
 * through and observes the result — so a deployment that configures nothing
 * behaves exactly as it did before this plugin existed.
 *
 * @param ctx - the owning Cordis context.
 * @param config - the plugin row's configuration, every field optional.
 */
export function apply(ctx, config = {}) {
  const manager = new ContextCacheService(ctx, config);

  // The assembled prompt, after every other provider has contributed to it.
  // This is a waterfall, so `next()` is called first and the resolved value is
  // returned unchanged: the manager reads the assembly, it does not edit it.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const resolved = await next();
    try {
      manager.observeAssembly(resolved ?? assembly, context);
    } catch (error) {
      manager._warn(`could not observe an assembly: ${manager._scrub(error)}`);
    }
    return resolved;
  });

  // Every model call, routed or not. The waterfall's `next()` runs first and
  // the chunks are passed through untouched; the manager only joins its own
  // record at the end.
  ctx.on('llm/stream', (options, next) => {
    const stream = next();
    try {
      return manager.observe(options, stream);
    } catch (error) {
      manager._warn(`could not observe a call: ${manager._scrub(error)}`);
      return stream;
    }
  });

  // The compaction lifecycle is only visible as session events: there is no
  // `compaction/*` Cordis event, so this is the one seam a handoff can be read
  // from.
  ctx.on('session/event', (session, event) => {
    try {
      manager.observeSessionEvent(session, event);
    } catch (error) {
      manager._warn(`could not observe a session event: ${manager._scrub(error)}`);
    }
  });

  ctx.logger?.info?.(`${name}: prêt (journal ${manager._journalLimit}, aucune décision de routage)`);
}

export { LAYERS, handoffLabel, contextLabel };
