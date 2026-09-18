/**
 * The `Adaptive` route: one selectable model whose model is decided per request.
 *
 * # Why a route and not a settings row
 *
 * The picker lists what `ctx.llm` advertises. `mode: auto` was already a policy
 * the router owned, but nothing in the interface could *select* it: an agent had
 * to ask for a role in code, and a person had no way to say "you choose". This
 * module closes exactly that gap by registering the router's own provider route
 * (`newpi-router`) with one model (`adaptive`), so choosing it in the picker is
 * choosing the policy.
 *
 * # Where the decision happens, and why it mutates the request
 *
 * The harness logs the *selected* `provider`/`model` on every assistant message
 * (`dsh-agent-loop` reads `request.provider`/`request.model` when it assembles
 * the message). A delegating adapter that kept the pseudo-route on the request
 * would therefore make the whole history — and every token-cost projection that
 * prices by route — name a model that was never called. So the adaptive path
 * resolves the role *before* dispatch and rewrites the request in place:
 * `newpi-router/adaptive` becomes `deepseek-official/deepseek-flash` (or the
 * plan's fallback route if the primary fails), and the logged route is the one
 * that actually answered. The picker still shows `Adaptive`; the record stays
 * true.
 *
 * # What decides the role (v1)
 *
 * Only facts the request itself carries, never a heuristic about the prompt:
 *
 * | signal | role |
 * | --- | --- |
 * | `purpose: 'compaction' \| 'session-title'` | `fast` when the plan declares it (auxiliary calls are volume, not difficulty) |
 * | tool schemas present | `coding` when the plan declares it |
 * | anything else | `default` |
 *
 * The plan's own `roles` remain the source of truth for what each role *is* —
 * point `fast` at the cheapest route, `coding` at the agentic one, and the
 * policy is expressed in the document the user already edits. A role the plan
 * does not declare is simply skipped, so this never invents a model name.
 *
 * # Failover
 *
 * The route's declared `fallback` is tried when the primary fails *before*
 * emitting anything and the failure is one that means "this route could not
 * answer" (`isFallbackEligible`, the same predicate `stream()` uses). The
 * request is rewritten again before the retry, so a failover is attributed to
 * the route that answered too.
 *
 * @module newpi-plugin-model-router/adaptive
 */

import { DEFAULT_ROLE } from './plan.js';
import { isFallbackEligible } from './routing.js';

/** Provider route the picker shows as its own group. */
export const ADAPTIVE_PROVIDER = 'newpi-router';

/** The one model id under that route. */
export const ADAPTIVE_MODEL = 'adaptive';

/** Display name of the picker entry. */
export const ADAPTIVE_NAME = 'Adaptive';

/** Display description of the picker entry. */
export const ADAPTIVE_DESCRIPTION = 'Automatically balances quality and cost';

/** Provider group name in the picker. */
export const ADAPTIVE_PROVIDER_NAME = 'NewPi Router';

/**
 * Rough request size in tokens: four characters per token, the same neutral
 * heuristic the harness's own meter falls back to. Only used to pick between
 * roles, never to report a measurement.
 *
 * @param options - the request.
 * @returns an approximate token count.
 */
export function estimateRequestTokens(options) {
  const text = JSON.stringify(options?.messages ?? []);
  const tools = JSON.stringify(options?.tools ?? []);
  return Math.ceil((text.length + tools.length) / 4);
}

/**
 * The role one request runs as under the adaptive route.
 *
 * @param plan - the validated routing plan.
 * @param options - the request being dispatched.
 * @returns a declared role name, or `undefined` when the plan declares none.
 */
export function adaptiveRoleFor(plan, options) {
  const declared = Object.keys(plan?.roles ?? {});
  if (declared.length === 0) return undefined;
  const has = (role) => plan.roles[role] !== undefined;
  const auxiliary = options?.purpose === 'compaction' || options?.purpose === 'session-title';
  if (auxiliary && has('fast')) return 'fast';
  const wantsTools = Array.isArray(options?.tools) && options.tools.length > 0;
  if (wantsTools && has('coding')) return 'coding';
  return has(DEFAULT_ROLE) ? DEFAULT_ROLE : declared[0];
}

/**
 * Normalize a plan route's fallback into a selection.
 *
 * @param value - the declared fallback, as a selection or a route.
 * @returns the selection, or `undefined`.
 */
function fallbackSelection(value) {
  if (value === undefined || value === null) return undefined;
  const candidate = value.selection ?? value;
  return typeof candidate?.provider === 'string' && typeof candidate?.model === 'string'
    ? candidate
    : undefined;
}

/**
 * The ordered routes one adaptive request may use: the role's route, then its
 * declared fallback. An unmapped plan with no usable role answers with the
 * mode's active selection so the caller still gets a route.
 *
 * @param plan - the validated routing plan.
 * @param options - the request being dispatched.
 * @param active - thunk returning the mode's active selection.
 * @returns one or two deduplicated selections, primary first.
 */
export function adaptiveChain(plan, options, active) {
  const chain = [];
  const push = (selection) => {
    if (selection === undefined || selection === null) return;
    if (typeof selection.provider !== 'string' || typeof selection.model !== 'string') return;
    if (chain.some((s) => s.provider === selection.provider && s.model === selection.model)) return;
    chain.push(selection);
  };
  const role = adaptiveRoleFor(plan, options);
  const route = role === undefined ? undefined : plan?.roles?.[role];
  if (route !== undefined) {
    push(route.selection ?? route);
    push(fallbackSelection(route.fallback));
  }
  if (chain.length === 0) push(typeof active === 'function' ? active() : active);
  return chain;
}

/**
 * Rewrite a request onto one selection, in place.
 *
 * In place on purpose: the caller (and the harness loop that logs the message)
 * holds this exact object, so the route that answers is the route recorded.
 *
 * @param options - the request to rewrite.
 * @param selection - the route to run on.
 * @returns the same request object.
 */
export function applySelection(options, selection) {
  options.provider = selection.provider;
  options.model = selection.model;
  if (selection.reasoningEffort === undefined) delete options.reasoningEffort;
  else options.reasoningEffort = selection.reasoningEffort;
  return options;
}

/**
 * The adaptive stream: dispatch the request, and fail over once per chain link.
 *
 * @param options - the caller's request, rewritten in place per attempt.
 * @param context - plan, active thunk, downstream `next()` and a warning sink.
 * @returns the provider's chunks, from whichever route answered.
 */
export async function* adaptiveStream(options, context) {
  const chain = adaptiveChain(context.plan, options, context.active);
  if (chain.length === 0) {
    throw new Error('newpi-router: adaptive route has no plan route to run on');
  }
  for (let index = 0; index < chain.length; index += 1) {
    applySelection(options, chain[index]);
    const last = index === chain.length - 1;
    let emitted = false;
    let failover = false;
    for await (const chunk of context.next()) {
      const finish = chunk?.type === 'finish' ? (chunk.reason ?? {}) : null;
      if (
        finish !== null &&
        finish.kind === 'error' &&
        !emitted &&
        !last &&
        isFallbackEligible(finish.failure)
      ) {
        failover = true;
        context.warn?.(
          `newpi-router: ${chain[index].provider}/${chain[index].model} unavailable ` +
            `(${finish.failure?.code ?? 'UNKNOWN'}); falling back to ` +
            `${chain[index + 1].provider}/${chain[index + 1].model}`,
        );
        break;
      }
      emitted = true;
      yield chunk;
      if (chunk?.type === 'finish') return;
    }
    if (!failover) return;
  }
}

/**
 * The `newpi-router` adapter: catalog, model metadata, and the delegating
 * stream used by any caller that reaches the adapter directly.
 *
 * The stream is deliberately the same code path the `llm/stream` hook uses, so
 * there is one implementation of the policy and one place where the request is
 * rewritten.
 */
export class AdaptiveAdapter {
  /**
   * @param ctx - context carrying `llm`.
   * @param plan - the validated plan.
   */
  constructor(ctx, plan) {
    this.ctx = ctx;
    this.plan = plan;
    /** Underlying model metadata, resolved once per mount. */
    this.resolved = undefined;
  }

  /**
   * Describe the router's own route.
   *
   * @param provider - the registered route.
   * @returns display metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: ADAPTIVE_PROVIDER_NAME };
  }

  /**
   * The adapter's route-level retry policy: the harness defaults.
   *
   * @returns `undefined`, meaning the normal policy.
   */
  providerRetryPolicy() {
    return undefined;
  }

  /**
   * Resolve the distinct underlying routes the plan can dispatch to.
   *
   * @returns selections, primary roles first, in declaration order.
   */
  _routes() {
    const routes = [];
    const seen = new Set();
    const add = (selection) => {
      if (selection === undefined || typeof selection.provider !== 'string') return;
      const key = `${selection.provider}/${selection.model}`;
      if (seen.has(key)) return;
      seen.add(key);
      routes.push(selection);
    };
    for (const route of Object.values(this.plan.roles ?? {})) {
      add(route?.selection ?? route);
      add(fallbackSelection(route?.fallback));
    }
    add(this.plan.active);
    add(this.plan.manual);
    return routes;
  }

  /**
   * Underlying model metadata, resolved once and reused.
   *
   * @param signal - cancellation for the lookups.
   * @returns known metadata, in plan order.
   */
  async _underlying(signal) {
    if (this.resolved !== undefined) return this.resolved;
    const resolved = [];
    for (const route of this._routes()) {
      try {
        const info = await this.ctx.llm.resolveModelInfo(route.provider, route.model, signal);
        if (info !== undefined) resolved.push(info);
      } catch {
        // An unreachable route contributes no metadata; the others still serve.
      }
    }
    this.resolved = resolved;
    return resolved;
  }

  /**
   * Advertise the adaptive model.
   *
   * @param provider - one provider route owned by this adapter.
   * @returns the single catalog entry.
   */
  async listModels(provider) {
    const known = await this._underlying(undefined);
    const modalities = intersectionModalities(known);
    return [
      {
        provider,
        id: ADAPTIVE_MODEL,
        name: ADAPTIVE_NAME,
        description: ADAPTIVE_DESCRIPTION,
        ...(modalities.length === 0 ? {} : { inputModalities: modalities }),
      },
    ];
  }

  /**
   * Describe the adaptive model.
   *
   * The context window is the *smallest* window among the plan's routes: the
   * request may be dispatched to any of them, so claiming the largest would let
   * compaction size a request the chosen route cannot take. Modalities are the
   * intersection for the same reason.
   *
   * @param provider - the registered route.
   * @param model - the adaptive model id.
   * @param signal - cancellation for the lookups.
   * @returns resolved metadata.
   */
  async resolveModelInfo(provider, model, signal) {
    const known = await this._underlying(signal);
    const windows = known
      .map((info) => info.context?.contextWindow)
      .filter((window) => typeof window === 'number' && window > 0);
    const modalities = intersectionModalities(known);
    const primary = known[0];
    const efforts = unionEfforts(known);
    return {
      provider,
      id: model,
      name: ADAPTIVE_NAME,
      description: ADAPTIVE_DESCRIPTION,
      ...(modalities.length === 0 ? {} : { inputModalities: modalities }),
      ...(windows.length === 0 ? {} : { context: { contextWindow: Math.min(...windows) } }),
      ...(primary?.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: primary.defaultMaxTokens }),
      ...(efforts === undefined ? {} : { reasoning: efforts }),
      ...(primary?.systemPromptUpdate === undefined
        ? {}
        : { systemPromptUpdate: primary.systemPromptUpdate }),
    };
  }

  /**
   * Stream one adaptive request.
   *
   * @param options - the caller's request.
   * @returns the provider's chunks.
   */
  async *stream(options) {
    yield* adaptiveStream(options, {
      plan: this.plan,
      active: () => this.plan.roles?.[DEFAULT_ROLE] ?? this.plan.active,
      next: () => this.ctx.llm.stream(options),
      warn: (message) => this.ctx.logger?.warn?.(message),
    });
  }
}

/**
 * The modalities every known underlying model accepts.
 *
 * @param known - resolved model metadata.
 * @returns shared modalities, or an empty array when unknown.
 */
function intersectionModalities(known) {
  const declared = known
    .map((info) => info.inputModalities)
    .filter((modalities) => Array.isArray(modalities) && modalities.length > 0);
  if (declared.length !== known.length || declared.length === 0) return [];
  return declared[0].filter((modality) => declared.every((list) => list.includes(modality)));
}

/**
 * The reasoning efforts every known underlying model offers.
 *
 * @param known - resolved model metadata.
 * @returns a reasoning block, or `undefined` when the routes disagree.
 */
function unionEfforts(known) {
  const declared = known.map((info) => info.reasoning).filter((reasoning) => reasoning !== undefined);
  if (declared.length !== known.length || declared.length === 0) return undefined;
  const efforts = [];
  for (const reasoning of declared) {
    for (const effort of reasoning.efforts ?? []) {
      if (!efforts.some((known) => known.id === effort.id)) efforts.push(effort);
    }
  }
  return efforts.length === 0 ? undefined : { efforts };
}
