/**
 * The context layer model, and the version ledger that names it.
 *
 * # Why layers exist at all
 *
 * A prompt sent to a provider is not one homogeneous block: a large stable
 * prefix (the harness rules, the deployment persona, the project's own
 * instructions) is sent on every step and almost never changes, a handoff
 * summary sits on top of the compacted history and only changes when a
 * compaction runs, and the tail — the current message, the tool results just
 * produced — changes on every call. A provider's prompt cache can only be
 * reused on the part that has not moved, so "what changed since the last call"
 * is the question worth answering before asking "was the cache hit".
 *
 * This module answers it *structurally*: five layers, each reduced to a digest,
 * a count and the names that contributed. No layer ever keeps the prompt text,
 * which is what lets the telemetry be logged without a secret ever reaching a
 * record.
 *
 * # The five layers
 *
 * | Layer     | Stability    | Source in the harness |
 * | --------- | ------------ | --------------------- |
 * | `core`    | stable       | the assembled system-prompt sections |
 * | `project` | semi-stable  | the assembled runtime-context contributions |
 * | `handoff` | semi-stable  | the last completed compaction's summary |
 * | `session` | dynamic      | the history before the current user message |
 * | `live`    | dynamic      | the current message and the trailing tool outputs |
 *
 * # Versioning
 *
 * Two counters, both per session, both monotonic:
 *
 * - `contextVersion` (`ctx_vN`) names the **cacheable prefix** — `core` +
 *   `project` + `handoff`. It advances only when that prefix's digest changes,
 *   so two consecutive calls with the same context version are calls whose
 *   provider cache can be reused, and a version change is the moment a cache
 *   miss is *expected* rather than surprising. `session` and `live` are
 *   deliberately excluded: they change on every call, and a version that
 *   changed on every call would name nothing.
 * - `handoffVersion` (`handoff_vN`) names the **frozen handoff**. It advances
 *   once per completed compaction and not before: between two compactions the
 *   handoff record is immutable, which is exactly the invariant the manager
 *   exists to make checkable.
 *
 * @module newpi-plugin-context-cache-manager/context
 */

import { createHash } from 'node:crypto';

/** The layer vocabulary, in cache-relevance order: the most stable first. */
export const LAYERS = Object.freeze(['core', 'project', 'handoff', 'session', 'live']);

/**
 * How movable each layer is. Kinds are named, not ordered, so a consumer that
 * only cares whether a layer is cache-relevant can ask for `stable` and
 * `semi-stable` without knowing the vocabulary.
 */
export const LAYER_STABILITY = Object.freeze({
  core: 'stable',
  project: 'semi-stable',
  handoff: 'semi-stable',
  session: 'dynamic',
  live: 'dynamic',
});

/** The layers whose digest forms the cacheable prefix and drives `contextVersion`. */
export const PREFIX_LAYERS = Object.freeze(['core', 'project', 'handoff']);

/** The layers expected to move on every call. */
export const DYNAMIC_LAYERS = Object.freeze(['session', 'live']);

/**
 * A digest long enough that two different prompts collide only by accident,
 * short enough to be read in a log line.
 */
export const DIGEST_LENGTH = 16;

/**
 * Hash one string.
 *
 * Digests are the only representation of prompt text this plugin ever keeps:
 * a digest proves "this is the same prefix" without being the prefix.
 *
 * @param text - the text to hash.
 * @returns the first {@link DIGEST_LENGTH} hex characters of its SHA-256.
 */
export function digest(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, DIGEST_LENGTH);
}

/**
 * Serialize a JSON value with sorted object keys, so two structurally equal
 * values always hash the same.
 *
 * A message's own key order is stable in practice, but a digest that depended
 * on it would report a spurious prefix change if an adapter ever reordered a
 * field.
 *
 * @param value - the value to serialize.
 * @returns a canonical JSON string.
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/**
 * Hash a JSON value by its canonical form.
 *
 * @param value - the value to hash.
 * @returns its digest.
 */
export function digestValue(value) {
  return digest(canonical(value));
}

/**
 * The stable-prefix digest of a layer set.
 *
 * `null` layers contribute a `null`, so an unknown layer is distinguishable
 * from an empty one in the ledger: an unobserved assembly and an empty prompt
 * are different facts.
 *
 * @param layers - a map of layer name to a layer descriptor (or `null`).
 * @returns the prefix digest.
 */
export function prefixDigest(layers) {
  const parts = {};
  for (const name of PREFIX_LAYERS) parts[name] = layers?.[name]?.digest ?? null;
  return digestValue(parts);
}

/**
 * Reduce a list of named text contributions to a layer descriptor.
 *
 * The names are kept because they are identifiers — a section name such as
 * `deployment:persona-prefix` — and never the text itself, which is reduced to
 * a digest. That is the whole privacy contract of the layer model.
 *
 * @param layer - the layer name.
 * @param parts - `{ name, text }` contributions, in assembly order.
 * @returns a frozen descriptor: `{ layer, stability, digest, count, names }`.
 */
export function textLayer(layer, parts) {
  const list = Array.isArray(parts) ? parts : [];
  const names = [];
  const hasher = createHash('sha256');
  for (const part of list) {
    const name = typeof part?.name === 'string' ? part.name : '';
    names.push(name);
    hasher.update(name);
    hasher.update('\u0000');
    hasher.update(typeof part?.text === 'string' ? part.text : '');
    hasher.update('\u0001');
  }
  return Object.freeze({
    layer,
    stability: LAYER_STABILITY[layer] ?? 'unknown',
    digest: list.length === 0 ? null : hasher.digest('hex').slice(0, DIGEST_LENGTH),
    count: list.length,
    names: Object.freeze(names),
  });
}

/**
 * Reduce a list of model messages to a layer descriptor.
 *
 * The digest covers the messages themselves — so a content change is visible —
 * but only the role counts, the total count and the tool-output count are
 * retained as facts.
 *
 * @param layer - `session` or `live`.
 * @param messages - the messages belonging to this layer.
 * @returns a frozen descriptor.
 */
export function messageLayer(layer, messages) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  let toolOutputs = 0;
  for (const message of list) {
    const role = typeof message?.role === 'string' ? message.role : 'unknown';
    roles[role] = (roles[role] ?? 0) + 1;
    if (isToolResult(message)) toolOutputs += 1;
  }
  return Object.freeze({
    layer,
    stability: LAYER_STABILITY[layer] ?? 'unknown',
    digest: list.length === 0 ? null : digestValue(list),
    count: list.length,
    roles: Object.freeze(roles),
    toolOutputs: layer === 'live' ? toolOutputs : 0,
  });
}

/**
 * Whether one message is a tool result.
 *
 * The harness has no `tool` role: a tool result is a `user`-role message whose
 * source identifies the call that produced it. Telling the two apart by role
 * alone would count a tool batch as a human prompt, which is exactly the
 * mistake that would make the `live` cut land in the wrong place.
 *
 * @param message - a model message.
 * @returns whether it is a tool result.
 */
export function isToolResult(message) {
  return message?.role === 'user' && message?.source?.kind === 'tool';
}

/**
 * Whether one message is a human turn.
 *
 * A message with no `source` at all is treated as human: a hand-built request
 * does not always carry one, and guessing "tool result" for it would leave
 * `live` empty on exactly the requests the layer exists to describe.
 *
 * @param message - a model message.
 * @returns whether it is a human user message.
 */
export function isHumanMessage(message) {
  return message?.role === 'user' && !isToolResult(message);
}

/**
 * Split a request's message list into the `session` and `live` layers.
 *
 * The cut is the last human user message: everything before it is history the
 * agent has already finished with, everything from it onwards is the work in
 * progress — the message being answered and the tool results it produced. A
 * tool result is itself a `user`-role message in this harness, so the cut uses
 * {@link isHumanMessage}, not the role alone. A request with no human message
 * at all (a one-shot summarization call, for instance) puts the whole list in
 * `session` and leaves `live` empty rather than guessing.
 *
 * System-role messages belong to the `core` layer and are returned separately,
 * both because they are the fallback source for `core` when no assembly was
 * observed and because keeping them out of the dynamic layers stops a stable
 * prompt from looking like moving history.
 *
 * @param messages - the request's messages, in order.
 * @returns `{ systems, history, live }`.
 */
export function splitMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systems = [];
  const rest = [];
  for (const message of list) {
    if (message?.role === 'system') systems.push(message);
    else rest.push(message);
  }
  let lastUser = -1;
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    if (isHumanMessage(rest[index])) {
      lastUser = index;
      break;
    }
  }
  if (lastUser === -1) return { systems, history: rest, live: [] };
  return { systems, history: rest.slice(0, lastUser), live: rest.slice(lastUser) };
}

/**
 * Reduce the assembled prompt to its two registry layers.
 *
 * The assembly is the authoritative split between the stable sections and the
 * dynamic contexts: the harness registers them through two different APIs, so
 * no text inspection is needed to tell a persona rule from a workspace
 * snapshot.
 *
 * @param assembly - a `PromptAssembly`, or `undefined` when none was observed.
 * @returns `{ core, project }`, both possibly `null`.
 */
export function assemblyLayers(assembly) {
  if (assembly === null || typeof assembly !== 'object') return { core: null, project: null };
  return {
    core: textLayer('core', assembly.sections),
    project: textLayer('project', assembly.contexts),
  };
}

/** The label of a handoff version. */
export function handoffLabel(version) {
  return `handoff_v${Number.isInteger(version) && version > 0 ? version : 0}`;
}

/** The label of a context version. */
export function contextLabel(version) {
  return `ctx_v${Number.isInteger(version) && version > 0 ? version : 0}`;
}

/**
 * Reduce a committed handoff to its layer descriptor.
 *
 * @param handoff - the handoff record, or `null` before the first compaction.
 * @returns a frozen descriptor.
 */
export function handoffLayer(handoff) {
  return Object.freeze({
    layer: 'handoff',
    stability: 'semi-stable',
    version: Number.isInteger(handoff?.version) ? handoff.version : 0,
    label: handoffLabel(handoff?.version),
    kind: typeof handoff?.kind === 'string' ? handoff.kind : 'none',
    digest: typeof handoff?.digest === 'string' ? handoff.digest : null,
    count: Number.isInteger(handoff?.summaryBlocks) ? handoff.summaryBlocks : 0,
    compactedAt: Number.isInteger(handoff?.at) ? handoff.at : null,
    shadowedTokens: Number.isInteger(handoff?.shadowedTokens) ? handoff.shadowedTokens : null,
  });
}

/**
 * One session's context ledger: its layers, its versions, and the open
 * compaction that will become the next handoff.
 *
 * Every mutator is total — it accepts whatever the harness handed it and never
 * throws — because a manager that could fail a model call by misreading an
 * event would be worse than no manager at all.
 */
export class SessionContext {
  /**
   * @param sessionId - the session this ledger follows, or `null` for the
   *   synthetic ledger that stands in for calls the harness did not attribute.
   */
  constructor(sessionId = null) {
    /** The session this ledger follows. */
    this.sessionId = sessionId;
    /** `ctx_vN` counter, advanced when the cacheable prefix changes. */
    this.contextVersion = 0;
    /** `handoff_vN` counter, advanced once per completed compaction. */
    this.handoffVersion = 0;
    /** The committed handoff, frozen between two compactions. */
    this.handoff = null;
    /** The compaction currently open, when one is. */
    this.pending = null;
    /** The last assembly's `core` descriptor. */
    this.core = null;
    /** The last assembly's `project` descriptor. */
    this.project = null;
    /** The `session` layer of the last observed request. */
    this.history = null;
    /** The `live` layer of the last observed request. */
    this.live = null;
    /** The prefix digest the current `contextVersion` was minted for. */
    this.prefix = null;
    /** When this ledger last changed, in epoch milliseconds. */
    this.updatedAt = null;
    /** How many requests this ledger has observed. */
    this.observations = 0;
  }

  /**
   * Record an assembled prompt. Idempotent for an unchanged assembly.
   *
   * @param assembly - the resolved `PromptAssembly`.
   * @param at - when the assembly was observed.
   * @returns whether the cacheable prefix changed.
   */
  observeAssembly(assembly, at = Date.now()) {
    const { core, project } = assemblyLayers(assembly);
    this.core = core;
    this.project = project;
    return this.recompute(at);
  }

  /**
   * Record a request's messages as the `session` and `live` layers.
   *
   * When no assembly was observed — a deployment without the system-prompt
   * service, or a call that happens before the first step — the request's own
   * system messages are used as the `core` fallback, and `project` stays
   * unknown. That keeps a first call attributable without inventing a
   * project layer nobody registered.
   *
   * @param messages - the request's messages.
   * @param at - when the request was observed.
   * @returns whether the cacheable prefix changed.
   */
  observeRequest(messages, at = Date.now()) {
    const { systems, history, live } = splitMessages(messages);
    if (this.core === null) {
      this.core = textLayer(
        'core',
        systems
          .map((message, index) => ({ name: `system:${index}`, text: textOf(message) }))
          .filter((part) => part.text !== ''),
      );
    }
    this.history = messageLayer('session', history);
    this.live = messageLayer('live', live);
    this.observations += 1;
    return this.recompute(at);
  }

  /**
   * Recompute the prefix digest and mint a new context version when it moved.
   *
   * @param at - when the change was observed.
   * @returns whether a new version was minted.
   */
  recompute(at = Date.now()) {
    this.updatedAt = at;
    const next = prefixDigest(this.layers());
    if (this.prefix === null || next !== this.prefix) {
      this.prefix = next;
      this.contextVersion += 1;
      return true;
    }
    return false;
  }

  /**
   * Open a compaction.
   *
   * Opening does not move the handoff: that is the point of "frozen between
   * two compactions". The summary and prune facts are gathered while it runs
   * and committed by {@link finishCompaction}.
   *
   * @param options - the compaction's identity.
   * @param options.compactionId - the harness's compaction id.
   * @param options.turn - the turn the compaction belongs to, or `null`.
   * @param options.at - when the compaction started.
   * @returns the open pending record.
   */
  beginCompaction({ compactionId = null, turn = null, at = Date.now() } = {}) {
    this.pending = {
      compactionId,
      turn,
      startedAt: at,
      summary: null,
      pruned: false,
      failed: false,
    };
    return this.pending;
  }

  /**
   * Gather one compaction summary's facts. The summary text itself is reduced
   * to a digest and never retained.
   *
   * @param options - the summary facts.
   * @param options.summary - the summary content blocks.
   * @param options.shadowedTokens - the harness's estimate of the replaced range.
   * @param options.provider - the route that wrote the summary.
   * @param options.model - the model that wrote the summary.
   * @param options.usage - the summarization call's reported usage, if any.
   * @param options.at - when the summary was observed.
   * @returns the pending record.
   */
  noteSummary({ summary = [], shadowedTokens = null, provider = null, model = null, usage = null, at = Date.now() } = {}) {
    if (this.pending === null) this.beginCompaction({ at });
    this.pending.summary = Object.freeze({
      digest: digestValue(summary),
      blocks: Array.isArray(summary) ? summary.length : 0,
      shadowedTokens: Number.isInteger(shadowedTokens) ? shadowedTokens : null,
      provider: typeof provider === 'string' ? provider : null,
      model: typeof model === 'string' ? model : null,
      usage: usage ?? null,
      at,
    });
    return this.pending;
  }

  /**
   * Note a model-free prune inside the open compaction.
   *
   * A prune produces no summary, so it cannot mint a handoff with content, but
   * it is still a compaction boundary and is recorded as one.
   *
   * @param options - the prune facts.
   * @param options.shadowedTokens - the replaced range's estimate.
   * @param options.at - when the prune was observed.
   * @returns the pending record.
   */
  notePrune({ shadowedTokens = null, at = Date.now() } = {}) {
    if (this.pending === null) this.beginCompaction({ at });
    this.pending.pruned = true;
    this.pending.prunedTokens = Number.isInteger(shadowedTokens) ? shadowedTokens : null;
    return this.pending;
  }

  /**
   * Close a compaction and, when it succeeded, commit the next handoff.
   *
   * A failed compaction commits nothing: the previous handoff stays frozen and
   * current, which is the honest answer when the summarizer errored.
   *
   * @param options - the closing facts.
   * @param options.error - the harness's error string, when the compaction failed.
   * @param options.at - when the compaction ended.
   * @returns the committed handoff, or `null` when nothing was committed.
   */
  finishCompaction({ error = null, at = Date.now() } = {}) {
    const pending = this.pending;
    this.pending = null;
    if (pending === null || error !== null) return null;
    this.handoffVersion += 1;
    const summary = pending.summary;
    this.handoff = Object.freeze({
      version: this.handoffVersion,
      label: handoffLabel(this.handoffVersion),
      kind: summary !== null ? 'summary' : pending.pruned ? 'prune' : 'compaction',
      digest: summary?.digest ?? null,
      summaryBlocks: summary?.blocks ?? 0,
      shadowedTokens: summary?.shadowedTokens ?? pending.prunedTokens ?? null,
      provider: summary?.provider ?? null,
      model: summary?.model ?? null,
      usage: summary?.usage ?? null,
      compactionId: pending.compactionId ?? null,
      startedAt: pending.startedAt ?? null,
      at,
    });
    this.recompute(at);
    return this.handoff;
  }

  /**
   * The five layer descriptors, handoff included.
   *
   * @returns a frozen map of layer name to descriptor or `null`.
   */
  layers() {
    return Object.freeze({
      core: this.core,
      project: this.project,
      handoff: this.handoff === null ? null : handoffLayer(this.handoff),
      session: this.history,
      live: this.live,
    });
  }

  /**
   * The layer digests alone, the compact form a per-call record carries.
   *
   * @returns a frozen `{ core, project, handoff, session, live }` of digests.
   */
  layerDigests() {
    const layers = this.layers();
    const digests = {};
    for (const name of LAYERS) digests[name] = layers[name]?.digest ?? null;
    return Object.freeze(digests);
  }

  /**
   * A detached snapshot of this ledger, safe to hand to an interface.
   *
   * @returns the frozen snapshot.
   */
  snapshot() {
    const layers = this.layers();
    return Object.freeze({
      sessionId: this.sessionId,
      contextVersion: this.contextVersion,
      contextLabel: contextLabel(this.contextVersion),
      handoffVersion: this.handoffVersion,
      handoffLabel: handoffLabel(this.handoffVersion),
      prefix: this.prefix,
      layers,
      handoff: this.handoff,
      pendingCompaction: this.pending === null ? null : Object.freeze({ ...this.pending }),
      observations: this.observations,
      updatedAt: this.updatedAt,
    });
  }
}

/**
 * The text of one message, for the `core` fallback path only.
 *
 * Only the fallback hashes message content directly: the assembled sections are
 * the normal source, and this exists so a deployment without the system-prompt
 * service still gets an attributable `core` layer.
 *
 * @param message - a model message.
 * @returns its text content, flattened.
 */
function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('\n');
}
