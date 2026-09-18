/**
 * The model router: modes, roles, leases, fallback, capabilities, configuration
 * and observability.
 *
 * The tests that matter most are the refusals and the reasons. A router is only
 * trustworthy if it can be asked why it chose a model: so this suite proves
 * that a fallback happens for exactly the provider failures that mean "this
 * route could not answer", that a functional failure never causes one, that a
 * misspelled plan is refused rather than half applied, and that no model name is
 * ever baked into the plugin — every route comes from the plan.
 *
 * The router is booted on a real Cordis context with a fake `llm`, the same way
 * the storage console is tested, so what runs is the service the harness would
 * run and not a reimplementation of it.
 *
 * @module newpi/tests/model-router
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MODES,
  ROLES,
  PlanError,
  assertRole,
  parsePlan,
} from '../plugins/model-router/plan.js';
import {
  FALLBACK_CODES,
  ModelLease,
  RouterError,
  deriveCapabilities,
  isFallbackEligible,
  meetsRequirements,
  mergeCapabilities,
  normalizeSelection,
  redact,
  sameSelection,
} from '../plugins/model-router/routing.js';
import {
  ADAPTIVE_MODEL,
  ADAPTIVE_PROVIDER,
  adaptiveChain,
  adaptiveRoleFor,
} from '../plugins/model-router/adaptive.js';
import { RECORD_KEYS } from '../plugins/model-router/index.js';

// --------------------------------------------------------------- the harness

/**
 * Resolve a path inside the harness's module tree.
 *
 * The plugin imports `@deepseek-ai/cordis`, which only resolves inside the
 * harness's module tree; the tests run against the same tree so what they boot
 * is what NewPi boots.
 *
 * @param name - the package or file to resolve, relative to the tree root.
 * @returns the absolute path.
 */
function harnessPath(name) {
  const tree =
    process.env.DSH_PROFILE_MODULES ??
    join(process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules');
  return join(tree, name);
}

/** One delta of visible text. */
const text = (value) => ({ type: 'text-delta', index: 0, text: value });

/** A successful terminal chunk. */
const finishOk = Object.freeze({ type: 'finish', reason: { kind: 'stop' } });

/**
 * A failed terminal chunk, the way an adapter normalizes one.
 *
 * @param code - the provider-neutral failure code.
 * @param extra - additional `LlmFailure` facts, such as a status.
 * @returns the finish chunk.
 */
const finishError = (code, extra = {}) => ({
  type: 'finish',
  reason: {
    kind: 'error',
    failure: { message: `the provider reported ${code}`, code, ...extra },
  },
});

/** An aborted terminal chunk. */
const finishAborted = Object.freeze({
  type: 'finish',
  reason: { kind: 'aborted', failure: { message: 'aborted by the caller', code: 'ABORTED' } },
});

/**
 * Build a fake `llm` service.
 *
 * `scripts` is one response per call, in dispatch order; the last entry repeats
 * when more calls arrive. A response is an array of chunks, in which a function
 * is awaited as a hook instead of being yielded, or an `Error` to throw.
 *
 * @param options - the fake's behavior.
 * @param options.scripts - per-call responses.
 * @param options.models - `provider/model -> LlmResolvedModelInfo`, or a
 *   function of both.
 * @returns the fake service, with its call log.
 */
function fakeLlm(options = {}) {
  const calls = [];
  const scripts = options.scripts ?? [[]];
  const models = options.models ?? (() => ({}));
  /** Adapter routes the mounted plugin registered: provider → adapter. */
  const adapters = new Map();
  return {
    calls,
    adapters,
    /**
     * Register adapter routes, the way the harness's `llm` service does.
     *
     * @param providers - route names owned by the adapter.
     * @param adapter - the adapter instance.
     * @returns the disposer, carrying `replace`.
     */
    registerAdapter(providers, adapter) {
      for (const provider of providers) adapters.set(provider, adapter);
      const handle = () => {
        for (const provider of providers) {
          if (adapters.get(provider) === adapter) adapters.delete(provider);
        }
      };
      handle.replace = (next) => {
        handle();
        for (const provider of next) adapters.set(provider, adapter);
      };
      return handle;
    },
    async listModels(provider) {
      const adapter = adapters.get(provider);
      return adapter === undefined ? [] : adapter.listModels(provider);
    },
    async resolveModelInfo(provider, model) {
      const resolved =
        typeof models === 'function' ? await models(provider, model) : models[`${provider}/${model}`];
      if (resolved instanceof Error) throw resolved;
      return resolved ?? {};
    },
    stream(request) {
      const index = calls.length;
      calls.push({
        provider: request.provider,
        model: request.model,
        reasoningEffort: request.reasoningEffort ?? null,
        sessionId: request.sessionId ?? null,
        request,
      });
      const script = scripts[Math.min(index, scripts.length - 1)] ?? [];
      return generate(script, request, index);
    },
  };
}

/**
 * Turn one scripted response into a chunk stream.
 *
 * @param script - the response: an array of chunks and hooks, or an Error.
 * @param request - the request the fake received.
 * @param index - the call index.
 * @returns the chunks.
 */
async function* generate(script, request, index) {
  if (script instanceof Error) throw script;
  for (const entry of script ?? []) {
    if (typeof entry === 'function') {
      await entry(request, index);
      continue;
    }
    yield entry;
  }
}

/**
 * Boot the plugin on a real Cordis context.
 *
 * @param plan - the plan to mount: an object, or a JSON string.
 * @param options - the test's seams.
 * @param options.scripts - the fake llm's per-call responses.
 * @param options.models - the fake llm's model metadata.
 * @param options.defaultSelection - the starting `agentDefaultModel` selection.
 * @param options.withoutDefaults - omit `agentDefaultModel` entirely.
 * @param options.config - extra plugin configuration.
 * @returns the context, the service, the fake llm and the default-model fake.
 */
async function bootRouter(plan, options = {}) {
  const { Context } = await import(pathToFileURL(harnessPath('@deepseek-ai/cordis/lib/index.js')));
  const ctx = new Context();
  const llm = fakeLlm(options);
  ctx.provide('llm', llm);

  let defaults;
  if (options.withoutDefaults !== true) {
    defaults = {
      current: options.defaultSelection,
      writes: [],
      async saveSelection(next) {
        this.writes.push(next);
        this.current = next;
      },
      currentSelection() {
        return this.current;
      },
    };
    ctx.provide('agentDefaultModel', defaults);
  }

  const { apply } = await import('../plugins/model-router/index.js');
  apply(ctx, {
    plan: typeof plan === 'string' ? plan : JSON.stringify(plan),
    ...(options.config ?? {}),
  });

  // `apply` publishes the default without blocking the mount, so a test that
  // wants to observe the write waits one turn for it.
  await new Promise((resolve) => setImmediate(resolve));

  return { ctx, router: ctx.get('modelRouter'), llm, defaults };
}

/**
 * Collect a whole stream.
 *
 * @param stream - the async iterable.
 * @returns its chunks.
 */
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** A plan in `auto` mode with every role mapped to a distinct route. */
function fullAutoPlan() {
  return {
    mode: 'auto',
    roles: {
      fast: { provider: 'alpha', model: 'small' },
      coding: { provider: 'alpha', model: 'big', reasoningEffort: 'high' },
      reasoning: { provider: 'gamma', model: 'deep' },
      research: { provider: 'delta', model: 'wide' },
      review: { provider: 'epsilon', model: 'critic' },
      default: { provider: 'alpha', model: 'mid' },
    },
  };
}

// ------------------------------------------------ 1. MANUAL

test('MANUAL uses exactly the model the configuration imposed', async () => {
  const { router, llm, defaults } = await bootRouter({
    mode: 'manual',
    manual: { provider: 'alpha', model: 'm1', reasoningEffort: 'high' },
    roles: { coding: { provider: 'beta', model: 'm2' } },
  });

  const selection = { provider: 'alpha', model: 'm1', reasoningEffort: 'high' };
  // Every role answers with the imposed route: in this mode a role may not
  // change what runs.
  for (const role of ROLES) assert.deepEqual(router.forRole(role), selection);
  assert.deepEqual(router.active(), selection);
  assert.deepEqual(router.describe().roles.coding, selection);

  // No automatic decision is taken, so a runtime switch is refused outright.
  await assert.rejects(
    router.switchTo({ provider: 'beta', model: 'm2' }),
    (error) => error.code === 'MODEL_ROUTER_READ_ONLY',
  );

  const chunks = await collect(
    router.stream('coding', { messages: [] }, { sessionId: 's-manual', operationId: 'op-1' }),
  );
  assert.deepEqual(chunks, []);
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, 'alpha');
  assert.equal(llm.calls[0].model, 'm1');
  assert.equal(llm.calls[0].reasoningEffort, 'high');
  assert.equal(llm.calls[0].sessionId, 's-manual');

  // And the harness's own default follows it, so an agent that never asks for a
  // role still starts on the imposed model.
  assert.deepEqual(defaults.current, selection);
});

// ------------------------------------------------ 2. SWITCH

test('SWITCH changes the model for the following operation, and only that one', async () => {
  const { router, defaults } = await bootRouter({
    mode: 'switch',
    active: { provider: 'alpha', model: 'm1' },
  });

  const first = await router.lease('coding', { sessionId: 's1', operationId: 'op-1' });
  assert.deepEqual(first.selection, { provider: 'alpha', model: 'm1' });
  assert.equal(first.critical, true, 'an operation is critical unless it says otherwise');

  // The switch is refused while the critical lease is held: the plan is never
  // half applied.
  await assert.rejects(
    router.switchTo({ provider: 'beta', model: 'm2' }),
    (error) => error.code === 'MODEL_ROUTER_BUSY',
  );
  assert.deepEqual(router.active(), { provider: 'alpha', model: 'm1' });

  // It is allowed with the explicit override, and then takes effect for the
  // next operation only.
  await router.switchTo({ provider: 'beta', model: 'm2' }, { force: true });
  assert.deepEqual(first.selection, { provider: 'alpha', model: 'm1' });

  const second = await router.lease('review');
  assert.deepEqual(second.selection, { provider: 'beta', model: 'm2' });
  assert.deepEqual(router.forRole('fast'), { provider: 'beta', model: 'm2' });
  assert.deepEqual(router.active(), { provider: 'beta', model: 'm2' });

  // The change updated the harness's default and was journalled with its cause.
  assert.deepEqual(defaults.current, { provider: 'beta', model: 'm2' });
  const switchRecord = router.recentCalls().find((record) => record.operation === 'switch');
  assert.ok(switchRecord, 'a switch must be journalled');
  assert.equal(switchRecord.outcome, 'applied');
  assert.deepEqual(switchRecord.from, { provider: 'alpha', model: 'm1' });
  assert.equal(switchRecord.provider, 'beta');
  assert.equal(switchRecord.model, 'm2');
});

test('SWITCH requires a well formed selection and says what was wrong', async () => {
  const { router } = await bootRouter({
    mode: 'switch',
    active: { provider: 'alpha', model: 'm1' },
  });

  for (const bad of [null, 'alpha', { provider: 'alpha' }, { provider: '', model: 'm' }, { provider: 'a', model: 'm', nope: 1 }]) {
    await assert.rejects(router.switchTo(bad), (error) => error.code === 'MODEL_ROUTER_INVALID_SELECTION');
  }
  await assert.rejects(
    router.switchTo({ provider: 'a', model: 'm', apiKey: 'sk-secret-value' }, { force: true }),
    (error) => error.code === 'MODEL_ROUTER_INVALID_SELECTION',
  );
});

// ------------------------------------------------ 3. in-flight stability

test('an operation already started keeps its model to the end', async () => {
  const { router, llm } = await bootRouter(
    { mode: 'switch', active: { provider: 'alpha', model: 'm1' } },
    {
      scripts: [
        [
          // A switch happens *while the call is being streamed*.
          async () => {
            await router.switchTo({ provider: 'beta', model: 'm2' }, { force: true });
          },
          text('answered by the leased route'),
          finishOk,
        ],
      ],
    },
  );

  const chunks = await collect(
    router.stream('coding', { messages: [] }, { sessionId: 's1', operationId: 'op-1' }),
  );
  assert.equal(chunks.length, 2);
  assert.equal(llm.calls.length, 1, 'the fallback must not be reached');
  assert.equal(llm.calls[0].provider, 'alpha');
  assert.equal(llm.calls[0].model, 'm1');

  // The switch did apply — for the following operation.
  assert.deepEqual(router.active(), { provider: 'beta', model: 'm2' });
  const next = await router.lease('coding');
  assert.deepEqual(next.selection, { provider: 'beta', model: 'm2' });

  // And the journal says which route the operation actually used.
  const call = router.recentCalls().find((record) => record.operation === 'call');
  assert.equal(call.provider, 'alpha');
  assert.equal(call.model, 'm1');
  assert.deepEqual(call.fallback, null);
});

test('a lease is stable by construction and reports whether it is still current', async () => {
  const { router } = await bootRouter({
    mode: 'auto',
    roles: { default: { provider: 'alpha', model: 'mid' }, coding: { provider: 'alpha', model: 'big' } },
  });
  const lease = await router.lease('coding');
  assert.equal(lease.id, '1');
  assert.equal(lease.released, false);
  assert.ok(lease.isCurrent(router.forRole('coding')));

  await router.switchTo({ provider: 'beta', model: 'other' }, { role: 'coding', force: true });
  assert.equal(lease.isCurrent(router.forRole('coding')), false);
  assert.deepEqual(lease.selection, { provider: 'alpha', model: 'big' });

  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false, 'releasing twice is a no-op');
  assert.equal(router.leases().length, 0);
});

// ------------------------------------------------ 4 & 5. AUTO

test('AUTO resolves every role from the plan, and not from a rule in this code', async () => {
  const { router } = await bootRouter(fullAutoPlan());
  assert.deepEqual(router.forRole('fast'), { provider: 'alpha', model: 'small' });
  assert.deepEqual(router.forRole('coding'), { provider: 'alpha', model: 'big', reasoningEffort: 'high' });
  assert.deepEqual(router.forRole('reasoning'), { provider: 'gamma', model: 'deep' });
  assert.deepEqual(router.forRole('research'), { provider: 'delta', model: 'wide' });
  assert.deepEqual(router.forRole('review'), { provider: 'epsilon', model: 'critic' });
  assert.deepEqual(router.forRole('default'), { provider: 'alpha', model: 'mid' });
  // The mode's active route is the process-wide default, for agents that do not
  // ask for a role.
  assert.deepEqual(router.active(), { provider: 'alpha', model: 'mid' });

  // A different plan is a different answer: nothing here is a built-in default.
  const other = await bootRouter({
    mode: 'auto',
    roles: { default: { provider: 'zeta', model: 'only' }, fast: { provider: 'zeta', model: 'toy' } },
  });
  assert.deepEqual(other.router.forRole('fast'), { provider: 'zeta', model: 'toy' });
  assert.deepEqual(other.router.forRole('coding'), { provider: 'zeta', model: 'only' });
});

test('AUTO falls back to the default role when a role has no mapping', async () => {
  const { router } = await bootRouter({
    mode: 'auto',
    roles: { default: { provider: 'alpha', model: 'mid' } },
  });
  for (const role of ['fast', 'coding', 'reasoning', 'research', 'review']) {
    assert.deepEqual(router.forRole(role), { provider: 'alpha', model: 'mid' });
  }
});

test('a role outside the vocabulary is refused rather than silently defaulted', async () => {
  const { router } = await bootRouter(fullAutoPlan());
  assert.throws(() => router.forRole('wizardry'), (error) => {
    assert.equal(error.code, 'MODEL_ROUTER_UNKNOWN_ROLE');
    assert.ok(error.message.includes('coding'), 'the vocabulary must be named');
    return true;
  });
  assert.equal(assertRole('coding'), 'coding');
});

test('AUTO lets one role be overridden at runtime', async () => {
  const { router } = await bootRouter(fullAutoPlan());
  await router.switchTo({ provider: 'beta', model: 'hotfix' }, { role: 'coding' });
  assert.deepEqual(router.forRole('coding'), { provider: 'beta', model: 'hotfix' });
  // The other roles are untouched.
  assert.deepEqual(router.forRole('fast'), { provider: 'alpha', model: 'small' });
  assert.deepEqual(router.forRole('default'), { provider: 'alpha', model: 'mid' });

  // Overriding the default role also catches the roles that were unmapped.
  const sparse = await bootRouter({ mode: 'auto', roles: { default: { provider: 'alpha', model: 'mid' } } });
  await sparse.router.switchTo({ provider: 'beta', model: 'other' });
  assert.deepEqual(sparse.router.forRole('research'), { provider: 'beta', model: 'other' });
});

// ------------------------------------------------ capabilities

test('AUTO refuses a route that cannot do the work, and prefers a fallback that can', async () => {
  const models = {
    'alpha/text': { inputModalities: ['text'], context: { contextWindow: 8000 } },
    'beta/vision': { inputModalities: ['text', 'image'], context: { contextWindow: 200000 } },
  };
  const { router } = await bootRouter(
    {
      mode: 'auto',
      roles: {
        default: { provider: 'alpha', model: 'text' },
        coding: {
          provider: 'alpha',
          model: 'text',
          fallback: { provider: 'beta', model: 'vision' },
        },
      },
      requirements: { coding: { vision: true, maxContext: 100000 } },
    },
    { models },
  );

  // `forRole` is pure and answers from the plan; `resolve` checks capability.
  assert.deepEqual(router.forRole('coding'), { provider: 'alpha', model: 'text' });
  const resolved = await router.resolve('coding');
  assert.deepEqual(resolved.selection, { provider: 'beta', model: 'vision' });
  assert.equal(resolved.fallback, undefined, 'the fallback was used, not held');
  assert.deepEqual(resolved.checked.length, 2);
  assert.deepEqual([...resolved.checked[0].missing].sort(), ['maxContext', 'vision']);

  // A requirement addressed to a role with no mapping still applies to whatever
  // the role resolves to.
  await assert.rejects(router.resolve('research', { require: { vision: true } }), (error) => {
    assert.equal(error.code, 'MODEL_ROUTER_INCAPABLE');
    assert.ok(error.message.includes('vision'));
    return true;
  });
});

test('an unknown capability is not a failure, but it is reported', async () => {
  // The adapter discloses nothing: a plan that needs `tools` cannot be proven
  // incapable, so it must not be rejected — that would make every route without
  // a capability-aware adapter unusable.
  const { router } = await bootRouter(
    {
      mode: 'auto',
      roles: { default: { provider: 'alpha', model: 'm1' } },
      requirements: { default: { tools: true } },
    },
    { models: () => ({}) },
  );
  const resolved = await router.resolve('default');
  assert.deepEqual(resolved.selection, { provider: 'alpha', model: 'm1' });
  assert.deepEqual(resolved.checked[0].unknown, ['tools']);
  assert.deepEqual(resolved.checked[0].missing, []);
});

test('a declared capability overrides what the adapter disclosed', async () => {
  const { router } = await bootRouter(
    {
      mode: 'auto',
      roles: {
        default: {
          provider: 'alpha',
          model: 'm1',
          capabilities: { vision: true, tools: true },
        },
      },
      requirements: { default: { vision: true, tools: true } },
    },
    { models: { 'alpha/m1': { inputModalities: ['text'] } } },
  );
  const resolved = await router.resolve('default');
  assert.equal(resolved.capabilities.vision, true);
  assert.equal(resolved.capabilities.tools, true);
});

test('a provider that cannot answer a capability query is not a routing failure', async () => {
  const { router } = await bootRouter(
    { mode: 'auto', roles: { default: { provider: 'alpha', model: 'm1' } } },
    { models: () => new Error('metadata endpoint unavailable') },
  );
  const resolved = await router.resolve('default');
  assert.deepEqual(resolved.selection, { provider: 'alpha', model: 'm1' });
  assert.deepEqual(resolved.checked[0].unknown, []);
});

// ------------------------------------------------ 6. fallback

test('a provider failure falls back to the role route, and the fallback is journalled', async () => {
  const { router, llm } = await bootRouter(
    {
      mode: 'auto',
      roles: {
        default: { provider: 'alpha', model: 'mid' },
        coding: {
          provider: 'alpha',
          model: 'big',
          fallback: { provider: 'beta', model: 'm2', reasoningEffort: 'low' },
        },
      },
    },
    {
      scripts: [
        [finishError('NETWORK', { status: 502 })],
        [text('answered by the fallback'), finishOk],
      ],
    },
  );

  const chunks = await collect(
    router.stream('coding', { messages: [] }, { sessionId: 's9', operationId: 'op-9' }),
  );
  assert.deepEqual(chunks, [text('answered by the fallback'), finishOk]);
  assert.equal(llm.calls.length, 2);
  assert.deepEqual([llm.calls[0].provider, llm.calls[0].model], ['alpha', 'big']);
  assert.deepEqual([llm.calls[1].provider, llm.calls[1].model], ['beta', 'm2']);
  assert.equal(llm.calls[1].reasoningEffort, 'low');
  assert.equal(llm.calls[1].sessionId, 's9', 'the session identity survives the fallback');

  const record = router.recentCalls().at(-1);
  assert.equal(record.operation, 'call');
  assert.equal(record.sessionId, 's9');
  assert.equal(record.operationId, 'op-9');
  assert.equal(record.outcome, 'completed');
  assert.deepEqual(record.fallback.from, { provider: 'alpha', model: 'big' });
  assert.deepEqual(record.fallback.to, { provider: 'beta', model: 'm2' });
  assert.equal(record.fallback.reason.code, 'NETWORK');
  assert.equal(record.fallback.reason.status, 502);
});

test('a fallback happens without content, and never after it', async () => {
  // Nothing was emitted: the route may change.
  const early = await bootRouter(
    {
      mode: 'auto',
      roles: {
        default: { provider: 'alpha', model: 'mid' },
        coding: { provider: 'alpha', model: 'big', fallback: { provider: 'beta', model: 'm2' } },
      },
    },
    { scripts: [[finishError('TIMEOUT')], [text('fallback'), finishOk]] },
  );
  const earlyChunks = await collect(early.router.stream('coding', { messages: [] }));
  assert.deepEqual(earlyChunks, [text('fallback'), finishOk]);
  assert.equal(early.llm.calls.length, 2);

  // A chunk already reached the caller: re-dispatching would duplicate output,
  // so the failure is reported as it happened.
  const late = await bootRouter(
    {
      mode: 'auto',
      roles: {
        default: { provider: 'alpha', model: 'mid' },
        coding: { provider: 'alpha', model: 'big', fallback: { provider: 'beta', model: 'm2' } },
      },
    },
    { scripts: [[text('partial answer'), finishError('NETWORK')]] },
  );
  const lateChunks = await collect(late.router.stream('coding', { messages: [] }));
  assert.equal(lateChunks.length, 2);
  assert.equal(lateChunks[1].reason.kind, 'error');
  assert.equal(late.llm.calls.length, 1, 'a fallback after partial output must not happen');

  // And a role with no fallback reports the failure without any second call.
  const none = await bootRouter(
    { mode: 'auto', roles: { default: { provider: 'alpha', model: 'mid' } } },
    { scripts: [[finishError('NETWORK')]] },
  );
  const noneChunks = await collect(none.router.stream('default', { messages: [] }));
  assert.equal(noneChunks[0].reason.kind, 'error');
  assert.equal(none.llm.calls.length, 1);
});

// ------------------------------------------------ 7. no fallback on application errors

test('no fallback happens for a functional or logical failure', async () => {
  const cases = [
    { code: 'INVALID_ARGS' },
    { code: 'CONTEXT_WINDOW_EXCEEDED' },
    { code: 'EMPTY_RESPONSE' },
    { code: 'AUTH' },
    { code: 'MISSING_CREDENTIAL' },
    { code: 'SOMETHING_NEW' },
    { code: 'SOMETHING_NEW', status: 400 },
  ];
  for (const failure of cases) {
    const { router, llm } = await bootRouter(
      {
        mode: 'auto',
        roles: {
          default: { provider: 'alpha', model: 'mid' },
          coding: { provider: 'alpha', model: 'big', fallback: { provider: 'beta', model: 'm2' } },
        },
      },
      { scripts: [[finishError(failure.code, failure)]] },
    );
    const chunks = await collect(router.stream('coding', { messages: [] }));
    assert.equal(chunks.at(-1).reason.kind, 'error', failure.code);
    assert.equal(llm.calls.length, 1, `${failure.code} must not fall back`);
    const record = router.recentCalls().at(-1);
    assert.equal(record.fallback, null, `${failure.code} must be recorded without a fallback`);
    assert.equal(record.outcome, 'error');
  }
});

test('an error thrown at the boundary is rethrown, never turned into a route change', async () => {
  const { router, llm } = await bootRouter(
    {
      mode: 'auto',
      roles: {
        default: { provider: 'alpha', model: 'mid' },
        coding: { provider: 'alpha', model: 'big', fallback: { provider: 'beta', model: 'm2' } },
      },
    },
    { scripts: [new Error('a plugin listener exploded')] },
  );
  await assert.rejects(
    collect(router.stream('coding', { messages: [] })),
    /a plugin listener exploded/,
  );
  assert.equal(llm.calls.length, 1);
  const record = router.recentCalls().at(-1);
  assert.equal(record.outcome, 'threw');
  assert.equal(record.fallback, null);
});

test('an aborted call is reported as aborted and never falls back', async () => {
  const { router, llm } = await bootRouter(
    {
      mode: 'auto',
      roles: {
        default: { provider: 'alpha', model: 'mid' },
        coding: { provider: 'alpha', model: 'big', fallback: { provider: 'beta', model: 'm2' } },
      },
    },
    { scripts: [[finishAborted]] },
  );
  const chunks = await collect(router.stream('coding', { messages: [] }));
  assert.equal(chunks.at(-1).reason.kind, 'aborted');
  assert.equal(llm.calls.length, 1);
  assert.equal(router.recentCalls().at(-1).outcome, 'aborted');
});

test('the fallback classifier is explicit and fails closed', () => {
  for (const code of FALLBACK_CODES) assert.equal(isFallbackEligible({ code }), true, code);
  assert.equal(isFallbackEligible({ code: 'SERVER_ERROR', status: 500 }), true);
  assert.equal(isFallbackEligible({ code: 'OPAQUE', status: 503 }), true, 'a 5xx is a route failure');
  assert.equal(isFallbackEligible({ code: 'OPAQUE', status: 429 }), true);
  assert.equal(isFallbackEligible({ code: 'OPAQUE', status: 400 }), false);
  assert.equal(isFallbackEligible({ code: 'OPAQUE' }), false, 'unknown codes must fail closed');
  assert.equal(isFallbackEligible(undefined), false);
  assert.equal(isFallbackEligible({ code: 'ABORTED' }), false);
});

// ------------------------------------------------ 8. no hardcoded provider/model

test('no provider or model is hardcoded anywhere in the plugin', async () => {
  const files = ['index.js', 'plan.js', 'routing.js'];
  const sources = [];
  for (const file of files) {
    sources.push(await readFile(new URL(`../plugins/model-router/${file}`, import.meta.url), 'utf8'));
  }

  const providers = [
    'deepseek',
    'openai',
    'anthropic',
    'claude',
    'gemini',
    'mistral',
    'qwen',
    'llama',
    'groq',
    'ollama',
    'glm',
    'moonshot',
    'kimi',
    'bedrock',
    'vertex',
  ];
  for (const [index, source] of sources.entries()) {
    // A provider route would appear as an exact quoted token; the harness
    // packages are scoped `@deepseek-ai/...`, which this does not match.
    for (const provider of providers) {
      assert.equal(
        new RegExp(`['"\`]${provider}['"\`]`, 'i').test(source),
        false,
        `${files[index]} names the provider ${provider}`,
      );
    }
    // And no `provider:`/`model:` is ever assigned a literal.
    const literal = /\b(?:provider|model)\s*[:=]\s*['"`][^'"`]+['"`]/g;
    assert.equal(literal.test(source), false, `${files[index]} assigns a provider or model literal`);
  }

  // The only routes that exist are the ones a plan declared.
  const alpha = await bootRouter({ mode: 'manual', manual: { provider: 'alpha', model: 'm1' } });
  assert.deepEqual(alpha.router.forRole('default'), { provider: 'alpha', model: 'm1' });
  const zeta = await bootRouter({ mode: 'manual', manual: { provider: 'zeta', model: 'm9' } });
  assert.deepEqual(zeta.router.forRole('default'), { provider: 'zeta', model: 'm9' });
});

// ------------------------------------------------ 9. invalid configuration

test('an invalid plan fails cleanly, naming the key at fault', () => {
  const invalid = [
    [undefined, /no plan/],
    ['', /empty plan/],
    ['{not json', /not valid JSON/],
    [{}, /mode is required/],
    [{ mode: 'sometimes' }, /is not a mode/],
    [{ mode: 'manual' }, /mode "manual" requires/],
    [{ mode: 'switch' }, /mode "switch" requires/],
    [{ mode: 'auto' }, /mode "auto" requires/],
    [{ mode: 'auto', roles: { wizardry: { provider: 'a', model: 'b' } } }, /wizardry/],
    [{ mode: 'auto', roles: { default: { provider: 'a', model: 'b', nope: 1 } } }, /unknown key/],
    [{ mode: 'auto', roles: { default: { provider: 'a', model: '' } } }, /non-empty string/],
    [
      { mode: 'auto', roles: { default: { provider: 'a', model: 'b', fallback: { provider: 'a', model: 'b' } } } },
      /primary route/,
    ],
    [
      { mode: 'auto', roles: { default: { provider: 'a', model: 'b' } }, requirements: { default: { maxContext: -1 } } },
      /positive whole number/,
    ],
    [
      { mode: 'auto', roles: { default: { provider: 'a', model: 'b' } }, requirements: { default: { tools: 'yes' } } },
      /true or false/,
    ],
  ];
  for (const [plan, pattern] of invalid) {
    assert.throws(() => parsePlan(plan), (error) => {
      assert.ok(error instanceof PlanError, `${JSON.stringify(plan)} must raise a PlanError`);
      assert.match(error.code, /^MODEL_ROUTER_/, `${JSON.stringify(plan)} must name a stable code`);
      assert.match(error.message, pattern);
      return true;
    });
  }

  // A credential placed in the plan is refused and pointed at the settings.
  assert.throws(
    () => parsePlan({ mode: 'manual', manual: { provider: 'a', model: 'b' }, apiKey: 'sk-x' }),
    (error) => {
      assert.match(error.message, /credentials do not belong/);
      assert.match(error.message, /settings\.yaml/);
      return true;
    },
  );
});

test('mounting a plugin row with an unusable plan throws instead of half applying', async () => {
  const { Context } = await import(pathToFileURL(harnessPath('@deepseek-ai/cordis/lib/index.js')));
  const ctx = new Context();
  ctx.provide('llm', fakeLlm());
  const { apply } = await import('../plugins/model-router/index.js');
  assert.throws(() => apply(ctx, { plan: '{"mode":"auto"}' }), PlanError);
  assert.equal(ctx.get('modelRouter'), undefined, 'a refused plan must not register the service');
});

test('the plan contract accepts exactly what the Rust side writes', async () => {
  // The sample patch is produced by `cargo test`, which the `pretest` hook runs
  // before this file. Parsing it with the harness's own YAML reader proves the
  // generated document — including the JSON scalar the plan travels in — is
  // what the harness will read back.
  const sample = new URL('../src-tauri/target/test-tmp/launcher-sample.patch.yml', import.meta.url);
  const text = await readFile(sample, 'utf8');
  const YAML = (await import(pathToFileURL(harnessPath('yaml/dist/index.js')))).default;
  const document = YAML.parse(text);
  const rows = document[0].insert;
  const row = rows.find((entry) => entry.id === 'model-router');
  assert.ok(row, 'the sample patch must carry the model-router row');
  assert.ok(row.name.startsWith('file://'));
  assert.ok(row.name.endsWith('/plugins/model-router/index.js'));

  const plan = parsePlan(row.config.plan);
  assert.equal(plan.mode, 'auto');
  assert.deepEqual(plan.roles.coding, {
    provider: 'alpha',
    model: 'big',
    reasoningEffort: 'high',
    fallback: { provider: 'beta', model: 'other' },
  });
  assert.deepEqual(plan.roles.default, { provider: 'alpha', model: 'mid' });
  assert.deepEqual(plan.requirements.coding, { tools: true, maxContext: 64000 });

  // Booting on it works, and the route is the one the plan declared.
  const { router } = await bootRouter(row.config.plan);
  assert.deepEqual(router.forRole('coding'), {
    provider: 'alpha',
    model: 'big',
    reasoningEffort: 'high',
  });

  // The pre-existing rows are untouched: the router is additive.
  for (const id of ['newpi-brand', 'pocketbase-memory', 'memory-tools', 'memory-console', 'storage-console']) {
    assert.ok(rows.some((entry) => entry.id === id), `${id} must still be mounted`);
  }
});

test('the role vocabulary is the same on both sides of the launcher patch', async () => {
  // The Rust side validates the user's document against its own list before the
  // harness starts; the plugin validates the JSON it is handed against this
  // one. A role added to only one of them is a plan the Rust side accepts and
  // the plugin refuses — at launch, with the window already opening.
  const source = await readFile(new URL('../src-tauri/src/models.rs', import.meta.url), 'utf8');
  const declaration = source.match(/pub const ROLES: \[&str; \d+\] = \[([^\]]+)\]/);
  assert.ok(declaration, 'the Rust role vocabulary must be declared as a const');
  const rustRoles = [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rustRoles, [...ROLES]);
});

test('MODES and ROLES are the documented contract', () => {
  assert.deepEqual(MODES, ['manual', 'switch', 'auto']);
  assert.deepEqual(ROLES, ['fast', 'coding', 'reasoning', 'research', 'review', 'default']);
});

// ------------------------------------------------ observability

test('every call carries the mode, role, route, fallback and identities — and no secret', async () => {
  const secret = 'sk-live-0123456789abcdef0123456789abcdef';
  const { router } = await bootRouter(
    {
      mode: 'auto',
      roles: {
        default: { provider: 'alpha', model: 'mid' },
        coding: { provider: 'alpha', model: 'big', fallback: { provider: 'beta', model: 'm2' } },
      },
    },
    {
      scripts: [
        [finishError('NETWORK', { message: `upstream refused, key ${secret}` })],
        [text('ok'), finishOk],
      ],
    },
  );

  const seen = [];
  const dispose = router.onCall((record) => seen.push(record));
  await collect(
    router.stream('coding', { messages: [] }, { sessionId: 'sess-7', operationId: 'op-7' }),
  );
  dispose();

  const record = router.recentCalls().at(-1);
  for (const key of ['at', 'operation', 'mode', 'role', 'provider', 'model', 'reasoningEffort', 'sessionId', 'operationId', 'outcome', 'from', 'fallback', 'failure']) {
    assert.ok(key in record, `the record is missing ${key}`);
  }
  assert.deepEqual(Object.keys(record).sort(), [...RECORD_KEYS].sort());
  assert.equal(record.mode, 'auto');
  assert.equal(record.role, 'coding');
  assert.equal(record.sessionId, 'sess-7');
  assert.equal(record.operationId, 'op-7');
  assert.equal(record.fallback.reason.code, 'NETWORK');

  // The listener saw the same records, and nothing in them is the key.
  assert.equal(seen.length, router.recentCalls().length);
  for (const entry of router.recentCalls()) {
    const rendered = JSON.stringify(entry);
    assert.equal(rendered.includes(secret), false, 'a credential reached the journal');
    assert.equal(rendered.includes('sk-live'), false);
  }
  assert.match(router.recentCalls()[0].fallback.reason.message, /\[redacted\]/);
});

test('a call the plugin did not originate is observed, and is not rerouted', async () => {
  const { ctx, router, llm } = await bootRouter(
    { mode: 'auto', roles: { default: { provider: 'alpha', model: 'mid' } } },
    { scripts: [[text('external'), finishOk]] },
  );

  // The waterfall is the seam every harness call goes through, whatever built
  // it. Driving it the way the `llm` service does proves two things at once:
  // the router sees a request it did not make, and it hands the chunks back
  // untouched — it records, it does not reroute.
  const options = {
    provider: 'someone-else',
    model: 'their-model',
    messages: [],
    sessionId: 'sess-other',
  };
  const stream = ctx.waterfall('llm/stream', options, () => llm.stream(options));
  const chunks = await collect(stream);
  assert.deepEqual(chunks, [text('external'), finishOk]);

  // The request reached the provider exactly as it was written.
  assert.equal(llm.calls.at(-1).provider, 'someone-else');
  assert.equal(llm.calls.at(-1).model, 'their-model');

  const record = router.recentCalls().at(-1);
  assert.equal(record.operation, 'external');
  assert.equal(record.mode, 'auto');
  assert.equal(record.role, null);
  assert.equal(record.provider, 'someone-else');
  assert.equal(record.model, 'their-model');
  assert.equal(record.sessionId, 'sess-other');
  assert.equal(record.outcome, 'completed');
  assert.equal(record.fallback, null);
});

// ------------------------------------------------ pure decisions

test('the pure decisions behave as the service relies on them', () => {
  assert.equal(redact('key sk-abcdef0123456789 here'), 'key [redacted] here');
  assert.equal(redact('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer [redacted]');
  assert.equal(redact('api_key=abcdefgh'), '[redacted]');
  assert.equal(redact('a'.repeat(40)), '[redacted]');
  assert.equal(redact('deepseek-chat'), 'deepseek-chat', 'a model name is not a secret');

  assert.deepEqual(deriveCapabilities({}), undefined);
  assert.deepEqual(
    deriveCapabilities({
      context: { contextWindow: 128000 },
      inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: 'high', name: 'High' }] },
    }),
    { maxContext: 128000, vision: true, reasoning: true },
  );
  assert.deepEqual(mergeCapabilities({ vision: false }, { vision: true, maxContext: 10 }), {
    vision: false,
    maxContext: 10,
  });
  assert.equal(mergeCapabilities(undefined, undefined), undefined);

  // A requirement is a floor; `false` means "not needed", not "forbidden".
  assert.deepEqual(meetsRequirements({ tools: true }, { tools: true }), {
    capable: true,
    missing: [],
    unknown: [],
  });
  assert.deepEqual(meetsRequirements({ tools: false }, { tools: true }).missing, ['tools']);
  assert.deepEqual(meetsRequirements({ tools: true }, { tools: false }).capable, true);
  assert.deepEqual(meetsRequirements({ maxContext: 10 }, { maxContext: 20 }).missing, ['maxContext']);
  assert.deepEqual(meetsRequirements({}, { tools: true }).unknown, ['tools']);

  assert.deepEqual(normalizeSelection({ provider: ' a ', model: ' b ' }), {
    provider: 'a',
    model: 'b',
  });
  assert.ok(sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' }));
  assert.equal(sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b', reasoningEffort: 'h' }), false);

  assert.ok(new ModelLease({ id: 'x', role: 'fast', selection: { provider: 'a', model: 'b' } }) instanceof ModelLease);
  assert.deepEqual(MODES, ['manual', 'switch', 'auto']);
  assert.deepEqual(ROLES, ['fast', 'coding', 'reasoning', 'research', 'review', 'default']);
});

test('a setMode the plan cannot support is refused, and a supported one is journalled', async () => {
  const manualOnly = await bootRouter({
    mode: 'manual',
    manual: { provider: 'alpha', model: 'm1' },
  });
  assert.throws(() => manualOnly.router.setMode('auto'), (error) => error.code === 'MODEL_ROUTER_MODE');
  assert.throws(() => manualOnly.router.setMode('nonsense'), (error) => error.code === 'MODEL_ROUTER_MODE');
  assert.equal(manualOnly.router.mode(), 'manual');

  const both = await bootRouter({
    mode: 'switch',
    active: { provider: 'alpha', model: 'm1' },
    manual: { provider: 'alpha', model: 'm1' },
  });
  assert.equal(both.router.setMode('manual'), 'manual');
  assert.equal(both.router.mode(), 'manual');
  assert.ok(both.router.recentCalls().some((record) => record.operation === 'mode'));
});

test('a router with no agentDefaultModel to publish to still works', async () => {
  const { router, defaults } = await bootRouter(
    { mode: 'manual', manual: { provider: 'alpha', model: 'm1' } },
    { withoutDefaults: true },
  );
  assert.equal(defaults, undefined);
  assert.deepEqual(router.active(), { provider: 'alpha', model: 'm1' });
  assert.equal(await router.publishDefault(), false);
});

test('a default-model write that fails is reported, never thrown at the mount', async () => {
  const { Context } = await import(pathToFileURL(harnessPath('@deepseek-ai/cordis/lib/index.js')));
  const ctx = new Context();
  ctx.provide('llm', fakeLlm());
  ctx.provide('agentDefaultModel', {
    currentSelection: () => undefined,
    saveSelection: async () => {
      throw new Error('the settings file is read only');
    },
  });
  const { apply } = await import('../plugins/model-router/index.js');
  apply(ctx, {
    plan: JSON.stringify({ mode: 'manual', manual: { provider: 'alpha', model: 'm1' } }),
  });
  // The mount succeeded, and the failure was absorbed.
  assert.ok(ctx.get('modelRouter'));
  assert.equal(await ctx.get('modelRouter').publishDefault(), false);
});

test('errors thrown by a journal listener cannot break a call', async () => {
  const { router } = await bootRouter({ mode: 'manual', manual: { provider: 'alpha', model: 'm1' } });
  router.onCall(() => {
    throw new Error('listener failure');
  });
  const chunks = await collect(router.stream('default', { messages: [] }));
  assert.deepEqual(chunks, []);
  assert.ok(router.recentCalls().length > 0);
  assert.throws(() => router.onCall('not a function'), (error) => error.code === 'MODEL_ROUTER_INVALID_LISTENER');
});

test('the RouterError type is exported for callers that need to branch', () => {
  assert.equal(new RouterError('X', 'y').code, 'X');
  assert.equal(typeof PlanError, 'function');
});

// ------------------------------------------------------- the adaptive route

/** The plan the adaptive tests mount: three roles, one of them with a fallback. */
const adaptivePlan = {
  mode: 'auto',
  roles: {
    fast: { provider: 'alpha', model: 'small' },
    coding: { provider: 'alpha', model: 'big', fallback: { provider: 'beta', model: 'm2' } },
    default: { provider: 'alpha', model: 'mid' },
  },
};

/** Metadata every adaptive test resolves the plan's routes against. */
const adaptiveModels = {
  'alpha/small': {
    provider: 'alpha',
    id: 'small',
    name: 'Small',
    context: { contextWindow: 64000 },
    inputModalities: ['text'],
  },
  'alpha/big': {
    provider: 'alpha',
    id: 'big',
    name: 'Big',
    context: { contextWindow: 200000 },
    inputModalities: ['text', 'image'],
  },
  'alpha/mid': {
    provider: 'alpha',
    id: 'mid',
    name: 'Mid',
    context: { contextWindow: 128000 },
    inputModalities: ['text'],
  },
  'beta/m2': {
    provider: 'beta',
    id: 'm2',
    name: 'M2',
    context: { contextWindow: 128000 },
    inputModalities: ['text'],
  },
};

test('the adaptive role follows the request, never the prompt text', () => {
  const plan = parsePlan(JSON.stringify(adaptivePlan));
  assert.equal(adaptiveRoleFor(plan, { purpose: 'compaction' }), 'fast');
  assert.equal(adaptiveRoleFor(plan, { purpose: 'session-title' }), 'fast');
  assert.equal(adaptiveRoleFor(plan, { tools: [{ name: 'bash' }] }), 'coding');
  assert.equal(adaptiveRoleFor(plan, { messages: [] }), 'default');

  // A plan that does not declare the role skips it: no model name is invented.
  const narrow = parsePlan(
    JSON.stringify({ mode: 'auto', roles: { default: { provider: 'alpha', model: 'mid' } } }),
  );
  assert.equal(adaptiveRoleFor(narrow, { purpose: 'compaction' }), 'default');
  assert.equal(adaptiveRoleFor(narrow, { tools: [{}] }), 'default');
});

test('the adaptive chain is the role route, then its fallback, deduplicated', () => {
  const plan = parsePlan(JSON.stringify(adaptivePlan));
  const render = (chain) => chain.map((selection) => `${selection.provider}/${selection.model}`);

  assert.deepEqual(render(adaptiveChain(plan, { tools: [{}] }, () => undefined)), [
    'alpha/big',
    'beta/m2',
  ]);
  assert.deepEqual(render(adaptiveChain(plan, { purpose: 'compaction' }, () => undefined)), [
    'alpha/small',
  ]);

  // A plan with no role at all still answers with the mode's active selection.
  const empty = parsePlan(JSON.stringify({ mode: 'switch', active: { provider: 'gamma', model: 'g1' } }));
  assert.deepEqual(render(adaptiveChain(empty, {}, () => ({ provider: 'gamma', model: 'g1' }))), [
    'gamma/g1',
  ]);
});

test('the adaptive route is advertised to the picker', async () => {
  const { llm } = await bootRouter(adaptivePlan, { models: adaptiveModels });

  assert.equal(llm.adapters.has(ADAPTIVE_PROVIDER), true, 'the router registered its own route');
  const catalog = await llm.listModels(ADAPTIVE_PROVIDER);
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].provider, ADAPTIVE_PROVIDER);
  assert.equal(catalog[0].id, ADAPTIVE_MODEL);
  assert.equal(catalog[0].name, 'Adaptive');
  assert.match(catalog[0].description, /quality and cost/);

  // The metadata is the *safe* envelope over the plan's routes: any of them may
  // answer, so the smallest window and the shared modalities are what a caller
  // can rely on.
  const info = await llm
    .adapters.get(ADAPTIVE_PROVIDER)
    .resolveModelInfo(ADAPTIVE_PROVIDER, ADAPTIVE_MODEL);
  assert.equal(info.id, ADAPTIVE_MODEL);
  assert.equal(info.context.contextWindow, 64000);
  assert.deepEqual(info.inputModalities, ['text']);
});

test('an adaptive request is rewritten in place onto the route that answers', async () => {
  const { ctx, llm } = await bootRouter(adaptivePlan, {
    scripts: [[text('routed'), finishOk]],
    models: adaptiveModels,
  });

  const options = {
    provider: ADAPTIVE_PROVIDER,
    model: ADAPTIVE_MODEL,
    messages: [],
    tools: [{ name: 'bash' }],
  };
  const chunks = await collect(ctx.waterfall('llm/stream', options, () => llm.stream(options)));

  assert.deepEqual(chunks, [text('routed'), finishOk]);
  assert.equal(`${llm.calls.at(-1).provider}/${llm.calls.at(-1).model}`, 'alpha/big');

  // The harness logs `request.provider`/`request.model` after the stream ends:
  // the in-place rewrite is what makes the record name the model that answered,
  // and what keeps the cost projection's per-route pricing honest.
  assert.equal(options.provider, 'alpha');
  assert.equal(options.model, 'big');
});

test('an adaptive request fails over, and still records the route that answered', async () => {
  const { ctx, llm } = await bootRouter(adaptivePlan, {
    scripts: [[finishError('PROVIDER_UNAVAILABLE')], [text('saved'), finishOk]],
    models: adaptiveModels,
  });

  const options = {
    provider: ADAPTIVE_PROVIDER,
    model: ADAPTIVE_MODEL,
    messages: [],
    tools: [{}],
  };
  const chunks = await collect(ctx.waterfall('llm/stream', options, () => llm.stream(options)));

  assert.deepEqual(chunks, [text('saved'), finishOk], 'the dead attempt emitted nothing');
  assert.equal(`${llm.calls[0].provider}/${llm.calls[0].model}`, 'alpha/big');
  assert.equal(`${llm.calls[1].provider}/${llm.calls[1].model}`, 'beta/m2');
  assert.equal(`${options.provider}/${options.model}`, 'beta/m2', 'the record names the winner');
});

test('an adaptive request does not fail over after visible output', async () => {
  const { ctx, llm } = await bootRouter(adaptivePlan, {
    scripts: [[text('partial answer'), finishError('NETWORK')], [text('second try'), finishOk]],
    models: adaptiveModels,
  });

  const options = {
    provider: ADAPTIVE_PROVIDER,
    model: ADAPTIVE_MODEL,
    messages: [],
    tools: [{}],
  };
  const chunks = await collect(ctx.waterfall('llm/stream', options, () => llm.stream(options)));

  assert.deepEqual(chunks, [text('partial answer'), finishError('NETWORK')]);
  assert.equal(llm.calls.length, 1, 'a committed attempt is never re-dispatched');
});

test('a second mount cannot register a second router: the first one stands', async () => {
  const { ctx, llm } = await bootRouter(adaptivePlan, { models: adaptiveModels });
  const { apply } = await import('../plugins/model-router/index.js');

  // One project declares one plan, so the launcher patch carries one row — and
  // a hand-written overlay next to it, or a profile that kept an old row, must
  // not cost the user the router. Cordis refuses the second service
  // registration outright, and the first mount keeps its route.
  assert.throws(() => apply(ctx, { plan: JSON.stringify(adaptivePlan) }), /modelRouter/);
  assert.ok(ctx.get('modelRouter'));
  assert.equal(llm.adapters.has(ADAPTIVE_PROVIDER), true, 'the first route still owns the name');
});
