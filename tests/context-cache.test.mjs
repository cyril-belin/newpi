/**
 * The Context & Cache Manager: layers, versions, handoffs, cache telemetry and
 * the API a later cache-aware Model Router policy would consume.
 *
 * The tests that matter most are the refusals and the absences. A manager is
 * only trustworthy if "the provider did not report a cache" is visibly
 * different from "the cache missed", if a handoff cannot move between two
 * compactions, and if a context version can only advance when the cacheable
 * prefix actually changed. So this suite proves an absence of data is not an
 * error, that no layer ever retains prompt text, that a failed compaction
 * commits nothing, and that observing a call never changes the call.
 *
 * The manager is booted on a real Cordis context, the same way the model router
 * is tested, so what runs is the service the harness would run.
 *
 * @module newpi/tests/context-cache
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LAYERS,
  SessionContext,
  canonical,
  contextLabel,
  digest,
  handoffLabel,
  isHumanMessage,
  isToolResult,
  splitMessages,
  textLayer,
} from '../plugins/context-cache-manager/context.js';
import {
  cacheFromUsage,
  describeFailure,
  estimateTemperature,
  normalizeUsage,
  redact,
  temperaturesByRoute,
} from '../plugins/context-cache-manager/cache.js';
import {
  RECORD_KEYS,
  RECORDED_LAYERS,
  apply,
} from '../plugins/context-cache-manager/index.js';

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
    process.env.DSH_PROFILE_MODULES ?? join(process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules');
  return join(tree, name);
}

/** One delta of visible text. */
const text = (value) => ({ type: 'text-delta', index: 0, text: value });

/** A successful terminal chunk. */
const finishOk = Object.freeze({ type: 'finish', reason: { kind: 'stop' } });

/** A usage chunk, the way an adapter emits one before the finish. */
const usageChunk = (usage) => ({ type: 'usage', usage });

/** A failed terminal chunk. */
const finishError = (code, message = `the provider reported ${code}`) => ({
  type: 'finish',
  reason: { kind: 'error', failure: { message, code } },
});

/**
 * Turn one scripted response into a chunk stream.
 *
 * @param script - the chunks and errors to produce.
 * @returns the chunks.
 */
async function* generate(script) {
  for (const entry of script ?? []) {
    if (entry instanceof Error) throw entry;
    yield entry;
  }
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

/**
 * Boot the plugin on a real Cordis context.
 *
 * @param options - the test's seams.
 * @param options.config - extra plugin configuration.
 * @returns the context and the service.
 */
async function boot(options = {}) {
  const { Context } = await import(pathToFileURL(harnessPath('@deepseek-ai/cordis/lib/index.js')));
  const ctx = new Context();
  apply(ctx, options.config ?? {});
  return { ctx, manager: ctx.get('contextCache') };
}

/**
 * Drive one model call through the `llm/stream` waterfall, the way the harness
 * does.
 *
 * @param ctx - the booted context.
 * @param options - the request.
 * @param script - the chunks the adapter would emit.
 * @returns the chunks the caller received.
 */
async function call(ctx, options, script) {
  const request = { messages: [], ...options };
  const stream = ctx.waterfall('llm/stream', request, () => generate(script));
  return { request, chunks: await collect(stream) };
}

/**
 * Drive one prompt assembly through the `system-prompt/assemble` waterfall.
 *
 * @param ctx - the booted context.
 * @param assembly - the assembly the harness resolved.
 * @param sessionId - the session the assembling agent belongs to.
 * @returns the resolved assembly.
 */
async function assemble(ctx, assembly, sessionId) {
  const context = { agent: { session: { id: sessionId } }, scope: { session: { id: sessionId } } };
  return ctx.waterfall('system-prompt/assemble', assembly, context, () => Promise.resolve(assembly));
}

/**
 * Emit one session event, the way the session store does.
 *
 * @param ctx - the booted context.
 * @param sessionId - the session the event belongs to.
 * @param event - the session event.
 * @returns nothing.
 */
function sessionEvent(ctx, sessionId, event) {
  ctx.emit('session/event', { id: sessionId }, event);
}

/** A minimal resolved prompt assembly. */
function assemblyOf(sectionText, contextText) {
  return {
    sections: [{ name: 'deployment:persona-prefix', text: sectionText }],
    contexts: [{ name: 'workspace', text: contextText }],
    tools: [],
    variables: {},
  };
}

// ============================================================ pure: layers

test('a text layer keeps the names and the digest, never the text', () => {
  const layer = textLayer('core', [
    { name: 'rules', text: 'do not leak this sentence' },
    { name: 'persona', text: 'be concise' },
  ]);
  assert.equal(layer.layer, 'core');
  assert.equal(layer.stability, 'stable');
  assert.deepEqual(layer.names, ['rules', 'persona']);
  assert.equal(layer.count, 2);
  assert.equal(typeof layer.digest, 'string');
  assert.ok(!JSON.stringify(layer).includes('do not leak'), 'the text must not survive');

  // Same text, same digest; different text, different digest.
  assert.equal(textLayer('core', [{ name: 'rules', text: 'x' }]).digest, textLayer('core', [{ name: 'rules', text: 'x' }]).digest);
  assert.notEqual(textLayer('core', [{ name: 'rules', text: 'x' }]).digest, textLayer('core', [{ name: 'rules', text: 'y' }]).digest);
  // An empty layer has no digest at all: unknown is not the same as empty.
  assert.equal(textLayer('core', []).digest, null);
});

test('tool results are told apart from human turns', () => {
  const human = { role: 'user', content: 'hello' };
  const tool = { role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [] };
  assert.equal(isHumanMessage(human), true);
  assert.equal(isHumanMessage(tool), false);
  assert.equal(isToolResult(tool), true);
  assert.equal(isToolResult(human), false);
});

test('the session/live cut is the last human message, trailing tools included', () => {
  const split = splitMessages([
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'calling a tool' },
    { role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [] },
  ]);
  assert.equal(split.systems.length, 1);
  // History is everything before the current message.
  assert.deepEqual(
    split.history.map((message) => message.content),
    ['first', 'answer'],
  );
  // Live is the current message plus the assistant step and its tool output.
  assert.equal(split.live.length, 3);
  assert.equal(split.live[0].content, 'second');

  // No human message at all: everything is history, live is empty.
  const oneShot = splitMessages([{ role: 'system', content: 's' }, { role: 'assistant', content: 'a' }]);
  assert.equal(oneShot.live.length, 0);
  assert.equal(oneShot.history.length, 1);
});

test('a context version advances only when the cacheable prefix moves', () => {
  const state = new SessionContext('s1');
  state.observeAssembly(assemblyOf('rules', 'project'));
  assert.equal(state.contextVersion, 1);
  assert.equal(contextLabel(state.contextVersion), 'ctx_v1');

  // Observing a request changes session/live, not the prefix.
  state.observeRequest([{ role: 'user', content: 'one' }]);
  assert.equal(state.contextVersion, 1, 'a changing tail must not mint a prefix version');
  state.observeRequest([{ role: 'user', content: 'two' }]);
  assert.equal(state.contextVersion, 1);

  // Changing the stable section mints a new version.
  state.observeAssembly(assemblyOf('rules v2', 'project'));
  assert.equal(state.contextVersion, 2);
  // Changing the semi-stable project context does too.
  state.observeAssembly(assemblyOf('rules v2', 'project v2'));
  assert.equal(state.contextVersion, 3);
  // Re-observing the same assembly does not.
  state.observeAssembly(assemblyOf('rules v2', 'project v2'));
  assert.equal(state.contextVersion, 3);
});

test('a handoff is frozen between two compactions, and a failure commits nothing', () => {
  const state = new SessionContext('s1');
  assert.equal(state.handoffVersion, 0);
  assert.equal(handoffLabel(0), 'handoff_v0');

  // Opening a compaction changes nothing yet.
  state.beginCompaction({ compactionId: 'c1', turn: 3 });
  assert.equal(state.handoffVersion, 0);
  state.noteSummary({ summary: [{ type: 'text', text: 'a summary' }], shadowedTokens: 1200, provider: 'alpha', model: 'big' });
  assert.equal(state.handoffVersion, 0, 'a summary is not a handoff until the compaction ends');

  state.finishCompaction({ error: null });
  assert.equal(state.handoffVersion, 1);
  assert.equal(state.handoff.label, 'handoff_v1');
  assert.equal(state.handoff.kind, 'summary');
  assert.equal(state.handoff.shadowedTokens, 1200);
  assert.equal(state.handoff.provider, 'alpha');
  // The summary text is a digest, not the text.
  assert.ok(!JSON.stringify(state.handoff).includes('a summary'));

  // Between two compactions the handoff is frozen, even as requests arrive.
  state.observeRequest([{ role: 'user', content: 'more work' }]);
  state.beginCompaction({ compactionId: 'c2' });
  assert.equal(state.handoffVersion, 1, 'a handoff must not move between compactions');
  assert.equal(state.handoff.label, 'handoff_v1');

  // A failed compaction commits no new version.
  state.finishCompaction({ error: 'summarizer unavailable' });
  assert.equal(state.handoffVersion, 1);

  // The next successful compaction mints the next version.
  state.beginCompaction({ compactionId: 'c3' });
  state.noteSummary({ summary: [{ type: 'text', text: 'second' }], shadowedTokens: 900, provider: 'alpha', model: 'big' });
  state.finishCompaction({});
  assert.equal(state.handoffVersion, 2);
  assert.equal(state.handoff.label, 'handoff_v2');

  // A model-free prune is a compaction boundary too, but with no summary.
  state.beginCompaction({ compactionId: 'c4' });
  state.notePrune({ shadowedTokens: 300 });
  state.finishCompaction({});
  assert.equal(state.handoffVersion, 3);
  assert.equal(state.handoff.kind, 'prune');
  assert.equal(state.handoff.digest, null);
});

// ============================================================ pure: cache

test('cache counters are read as disjoint buckets, never fabricated', () => {
  // DeepSeek: prompt_tokens folds the hits in, its adapter subtracts them out.
  const deepseek = cacheFromUsage({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 });
  assert.deepEqual(deepseek, {
    available: true,
    reason: null,
    hitTokens: 900,
    missTokens: 100,
    writeTokens: 0,
    promptTokens: 1000,
    hitRatio: 0.9,
  });

  // A write is reported separately and is not counted as a miss.
  const anthropic = cacheFromUsage({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 30 });
  assert.equal(anthropic.hitTokens, 20);
  assert.equal(anthropic.missTokens, 50);
  assert.equal(anthropic.writeTokens, 30);
  assert.equal(anthropic.promptTokens, 100);
  assert.equal(anthropic.hitRatio, 0.2);

  // A provider that reports usage but no cache is an absence, not an error.
  const plain = cacheFromUsage({ inputTokens: 100, outputTokens: 10 });
  assert.equal(plain.available, false);
  assert.match(plain.reason, /without cache counters/);
  assert.equal(plain.hitRatio, null);

  // No usage at all is a different absence.
  const none = cacheFromUsage(null);
  assert.equal(none.available, false);
  assert.match(none.reason, /no token usage/);

  // A zero read is a real measurement: a genuine miss.
  const zero = cacheFromUsage({ inputTokens: 100, outputTokens: 1, cacheReadTokens: 0 });
  assert.equal(zero.available, true);
  assert.equal(zero.hitRatio, 0);
});

test('usage normalization refuses counters that are not whole numbers', () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({ inputTokens: -1, outputTokens: 2 }), null);
  assert.equal(normalizeUsage({ inputTokens: 1 }), null);
  assert.deepEqual(normalizeUsage({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3.5 }), {
    inputTokens: 1,
    outputTokens: 2,
  });
});

test('the temperature estimate is time aware and honest about missing data', () => {
  const now = 1_000_000;
  const records = [
    { at: now - 3000, cache: { available: true, hitRatio: 0.9 } },
    { at: now - 2000, cache: { available: true, hitRatio: 0.8 } },
  ];
  const hot = estimateTemperature(records, { now });
  assert.equal(hot.state, 'hot');
  assert.equal(hot.samples, 2);
  assert.ok(hot.averageHitRatio > 0.8);

  // Partial reuse is warm, not hot.
  const warm = estimateTemperature([{ at: now - 100, cache: { available: true, hitRatio: 0.2 } }], { now });
  assert.equal(warm.state, 'warm');

  // No hits at all is cold.
  const cold = estimateTemperature([{ at: now - 100, cache: { available: true, hitRatio: 0 } }], { now });
  assert.equal(cold.state, 'cold');

  // A provider that reported nothing is unknown, and says so.
  const unknown = estimateTemperature([{ at: now, cache: { available: false, hitRatio: null } }], { now });
  assert.equal(unknown.state, 'unknown');
  assert.match(unknown.reason, /no provider cache counters/);

  // A hit ratio measured long ago does not make the next call hot: it is warm
  // while the history is still meaningful, and cold once it is not.
  const recentEnough = estimateTemperature(records, { now: now + 10 * 60 * 1000 });
  assert.equal(recentEnough.state, 'warm');
  const stale = estimateTemperature(records, { now: now + 60 * 60 * 1000 });
  assert.equal(stale.state, 'cold');

  // Per-route grouping keeps routes apart.
  const byRoute = temperaturesByRoute(
    [
      { provider: 'a', model: 'm', at: now - 1, cache: { available: true, hitRatio: 0.9 } },
      { provider: 'b', model: 'm', at: now - 1, cache: { available: false, hitRatio: null } },
    ],
    { now },
  );
  assert.equal(byRoute['a/m'].state, 'hot');
  assert.equal(byRoute['b/m'].state, 'unknown');
});

test('diagnostics are scrubbed of anything credential shaped', () => {
  assert.equal(redact('key sk-abcdef0123456789 here'), 'key [redacted] here');
  assert.equal(redact('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer [redacted]');
  assert.equal(redact('api_key=abcdefgh'), '[redacted]');
  assert.equal(redact('g'.repeat(40)), '[redacted]');
  assert.equal(redact('deepseek-chat'), 'deepseek-chat', 'a model name is not a secret');
  assert.deepEqual(describeFailure({ code: 'RATE_LIMIT', message: 'token=abcdef123' }), {
    code: 'RATE_LIMIT',
    message: '[redacted]',
  });
  assert.equal(describeFailure(null), null);
});

// ============================================================ the service

test('the manager mounts on an empty configuration and exposes its API', async () => {
  const { manager } = await boot();
  assert.ok(manager, 'ctx.contextCache must be registered');
  assert.equal(manager.current(), null);
  assert.equal(manager.versions(), null);
  assert.deepEqual(manager.snapshots(), []);
  assert.deepEqual(manager.recentCalls(), []);
  assert.equal(manager.cacheStats().available, false);
  assert.equal(manager.temperature('a', 'm').state, 'unknown');
  assert.equal(typeof manager.describe(), 'object');
});

test('RECORD_KEYS is the whole contract a record may carry', async () => {
  const { ctx, manager } = await boot();
  await call(ctx, { provider: 'alpha', model: 'm1', sessionId: 's1' }, [
    usageChunk({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 30 }),
    finishOk,
  ]);
  const record = manager.recentCalls().at(-1);
  assert.deepEqual(Object.keys(record).sort(), [...RECORD_KEYS].sort());
  assert.deepEqual(RECORD_KEYS.filter((key) => ['usage', 'cache', 'layers'].includes(key)).sort(), ['cache', 'layers', 'usage']);
  assert.deepEqual([...RECORDED_LAYERS], [...LAYERS]);
  // The record can never grow a field carrying prompt text.
  for (const forbidden of ['messages', 'content', 'prompt', 'request', 'apiKey']) {
    assert.ok(!RECORD_KEYS.includes(forbidden), `a record must not carry ${forbidden}`);
  }
});

test('the manager is bound to one project, and a cache window reads per project', async () => {
  const { ctx, manager } = await boot();

  // Unbound, a call is recorded with no project.
  await call(ctx, { provider: 'alpha', model: 'm1', sessionId: 's1' }, [
    usageChunk({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 }),
    finishOk,
  ]);
  assert.equal(manager.project(), null);
  assert.equal(manager.recentCalls().at(-1).projectId, null);

  // Bound, every later record carries the project and its memory namespace.
  const bound = manager.bindProject({ id: 'twin', namespace: 'twin-memory' });
  assert.deepEqual(bound, { id: 'twin', namespace: 'twin-memory' });
  assert.deepEqual(manager.project(), bound);
  await call(ctx, { provider: 'alpha', model: 'm1', sessionId: 's1' }, [
    usageChunk({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 9 }),
    finishOk,
  ]);
  const record = manager.recentCalls().at(-1);
  assert.equal(record.projectId, 'twin');
  assert.equal(record.projectNamespace, 'twin-memory');
  assert.equal(manager.describe().project.id, 'twin');

  // A per-project window never counts another project's calls, and the default
  // view (unbound) still counts everything.
  const scoped = manager.cacheStats({ projectId: 'twin' });
  assert.equal(scoped.calls, 1);
  assert.equal(scoped.hitTokens, 9);
  assert.equal(manager.cacheStats({ projectId: 'other' }).calls, 0);
  assert.equal(manager.cacheStats().calls, 2);

  // Releasing the binding leaves history alone: the bound call keeps its
  // project, and a later call is unattributed.
  manager.unbindProject();
  await call(ctx, { provider: 'alpha', model: 'm1', sessionId: 's1' }, [finishOk]);
  assert.equal(manager.recentCalls().at(-1).projectId, null);
  assert.equal(manager.recentCalls().at(-2).projectId, 'twin');
});

test('binding a project that names no id is refused, and null releases it', async () => {
  const { manager } = await boot();
  assert.throws(() => manager.bindProject({ namespace: 'x' }), TypeError);
  assert.equal(manager.bindProject(null), null);
  assert.equal(manager.project(), null);
});

test('a call is observed with its route, versions and reported cache counters', async () => {
  const { ctx, manager } = await boot();
  await assemble(ctx, assemblyOf('rules', 'project'), 's1');
  const { chunks } = await call(
    ctx,
    { provider: 'alpha', model: 'big', reasoningEffort: 'high', sessionId: 's1', operationId: 'op-42' },
    [text('hello'), usageChunk({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, totalTokens: 1020 }), finishOk],
  );
  // The chunks reached the caller exactly as the adapter produced them.
  assert.deepEqual(chunks, [text('hello'), usageChunk({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, totalTokens: 1020 }), finishOk]);

  const record = manager.recentCalls().at(-1);
  assert.equal(record.provider, 'alpha');
  assert.equal(record.model, 'big');
  assert.equal(record.reasoningEffort, 'high');
  assert.equal(record.sessionId, 's1');
  assert.equal(record.operationId, 'op-42');
  assert.equal(record.outcome, 'completed');
  assert.equal(record.contextVersion, 1);
  assert.equal(record.contextLabel, 'ctx_v1');
  assert.equal(record.handoffVersion, 0);
  assert.equal(record.handoffLabel, 'handoff_v0');
  assert.equal(record.usage.cacheReadTokens, 900);
  assert.equal(record.cache.available, true);
  assert.equal(record.cache.hitTokens, 900);
  assert.equal(record.cache.missTokens, 100);
  assert.equal(record.cache.hitRatio, 0.9);
  // The layer digests are present, and no layer text.
  assert.deepEqual(Object.keys(record.layers).sort(), [...LAYERS].sort());
  assert.equal(typeof record.layers.core, 'string');
});

test('a provider that reports no cache counters yields an absence, never an error', async () => {
  const { ctx, manager } = await boot();
  const { chunks } = await call(
    ctx,
    { provider: 'silent', model: 'm', sessionId: 's' },
    [usageChunk({ inputTokens: 500, outputTokens: 10 }), finishOk],
  );
  // The call is untouched by the observation.
  assert.equal(chunks.length, 2);
  const record = manager.recentCalls().at(-1);
  assert.equal(record.outcome, 'completed');
  assert.equal(record.cache.available, false);
  assert.match(record.cache.reason, /without cache counters/);
  assert.equal(manager.cacheStats({ provider: 'silent' }).available, false);
  assert.equal(manager.temperature('silent', 'm').state, 'unknown');
  assert.equal(manager.hintsFor('silent', 'm').cacheObservable, false);
});

test('a call with no usage chunk at all is recorded as unmeasured', async () => {
  const { ctx, manager } = await boot();
  await call(ctx, { provider: 'mock', model: 'm', sessionId: 's' }, [text('done'), finishOk]);
  const record = manager.recentCalls().at(-1);
  assert.equal(record.usage, null);
  assert.equal(record.cache.available, false);
  assert.match(record.cache.reason, /no token usage/);
});

test('a failed call is recorded with its scrubbed reason and its route', async () => {
  const { ctx, manager } = await boot();
  await call(ctx, { provider: 'alpha', model: 'm', sessionId: 's' }, [
    usageChunk({ inputTokens: 5, outputTokens: 0, cacheReadTokens: 0 }),
    finishError('RATE_LIMIT', 'rate limited for token=supersecretvalue'),
  ]);
  const record = manager.recentCalls().at(-1);
  assert.equal(record.outcome, 'error');
  assert.equal(record.failure.code, 'RATE_LIMIT');
  assert.ok(!JSON.stringify(record).includes('supersecretvalue'), 'the failure must be scrubbed');
  // Usage reported before an error is still attributed.
  assert.equal(record.cache.available, true);
  // A thrown consumer error is rethrown, and still recorded.
  await assert.rejects(
    collect(ctx.waterfall('llm/stream', { provider: 'alpha', model: 'm', messages: [] }, () => generate([new Error('consumer failure token=abcdef123456')]))),
    /consumer failure/,
  );
  const thrown = manager.recentCalls().at(-1);
  assert.equal(thrown.outcome, 'threw');
  assert.ok(!JSON.stringify(thrown).includes('abcdef123456'));
});

test('an assembly names the core and project layers, and a change mints a version', async () => {
  const { ctx, manager } = await boot();
  await assemble(ctx, assemblyOf('rules v1', 'project v1'), 's1');
  const first = manager.current('s1');
  assert.equal(first.contextVersion, 1);
  assert.equal(first.contextLabel, 'ctx_v1');
  assert.equal(first.layers.core.count, 1);
  assert.deepEqual(first.layers.core.names, ['deployment:persona-prefix']);
  assert.equal(first.layers.project.count, 1);
  assert.deepEqual(first.layers.project.names, ['workspace']);

  // A call under that assembly is attributed to ctx_v1.
  await call(ctx, { provider: 'a', model: 'm', sessionId: 's1' }, [finishOk]);
  assert.equal(manager.recentCalls().at(-1).contextVersion, 1);

  // The project context changed: the next call is attributed to ctx_v2.
  await assemble(ctx, assemblyOf('rules v1', 'project v2'), 's1');
  await call(ctx, { provider: 'a', model: 'm', sessionId: 's1' }, [finishOk]);
  assert.equal(manager.recentCalls().at(-1).contextVersion, 2);
  assert.equal(manager.versions('s1').contextLabel, 'ctx_v2');
});

test('a request with no assembly still gets a core layer from its own system message', async () => {
  const { ctx, manager } = await boot();
  await call(
    ctx,
    {
      provider: 'a',
      model: 'm',
      sessionId: 's',
      messages: [{ role: 'system', content: 'you are a harness' }, { role: 'user', content: 'hi' }],
    },
    [finishOk],
  );
  const snapshot = manager.current('s');
  assert.equal(snapshot.layers.core.count, 1);
  assert.equal(typeof snapshot.layers.core.digest, 'string');
  // The system message is not counted as history.
  assert.equal(snapshot.layers.session.count, 0);
  assert.equal(snapshot.layers.live.count, 1);
  assert.equal(snapshot.layers.live.toolOutputs, 0);
});

test('the compaction lifecycle mints and freezes handoffs', async () => {
  const { ctx, manager } = await boot();
  await assemble(ctx, assemblyOf('rules', 'project'), 's1');
  await call(ctx, { provider: 'a', model: 'm', sessionId: 's1' }, [finishOk]);
  assert.equal(manager.versions('s1').handoffLabel, 'handoff_v0');

  sessionEvent(ctx, 's1', { type: 'compaction/start', compactionId: 'c1', turn: 4 });
  await call(ctx, { provider: 'a', model: 'm', sessionId: 's1' }, [finishOk]);
  assert.equal(manager.recentCalls().at(-1).handoffVersion, 0, 'an open compaction is not a handoff');

  sessionEvent(ctx, 's1', {
    type: 'compaction/summary',
    compactionId: 'c1',
    summary: [{ type: 'text', text: 'the compacted history' }],
    shadowedTokenCount: 4200,
    provider: 'alpha',
    model: 'big',
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 3800 },
  });
  await call(ctx, { provider: 'a', model: 'm', sessionId: 's1' }, [finishOk]);
  assert.equal(manager.recentCalls().at(-1).handoffVersion, 0, 'a summary alone is not a handoff');

  sessionEvent(ctx, 's1', { type: 'compaction/end', compactionId: 'c1', turn: 4 });
  const commit = manager.versions('s1');
  assert.equal(commit.handoffLabel, 'handoff_v1');
  assert.equal(commit.handoff.kind, 'summary');
  assert.equal(commit.handoff.shadowedTokens, 4200);
  assert.equal(commit.handoff.provider, 'alpha');
  assert.ok(!JSON.stringify(commit.handoff).includes('the compacted history'), 'the summary text must not survive');
  // The prefix moved, so the context version advanced too.
  assert.equal(commit.contextLabel, 'ctx_v2');

  // Frozen between two compactions: many calls, one version.
  for (let index = 0; index < 3; index += 1) {
    await call(ctx, { provider: 'a', model: 'm', sessionId: 's1' }, [finishOk]);
  }
  assert.equal(manager.versions('s1').handoffLabel, 'handoff_v1');

  // A failed compaction commits nothing.
  sessionEvent(ctx, 's1', { type: 'compaction/start', compactionId: 'c2', turn: 5 });
  sessionEvent(ctx, 's1', { type: 'compaction/summary', compactionId: 'c2', summary: [{ type: 'text', text: 'x' }], shadowedTokenCount: 10, provider: 'a', model: 'm' });
  sessionEvent(ctx, 's1', { type: 'compaction/end', compactionId: 'c2', turn: 5, error: 'summarizer failed' });
  assert.equal(manager.versions('s1').handoffLabel, 'handoff_v1');

  // The next success mints handoff_v2.
  sessionEvent(ctx, 's1', { type: 'compaction/start', compactionId: 'c3', turn: 6 });
  sessionEvent(ctx, 's1', { type: 'compaction/summary', compactionId: 'c3', summary: [{ type: 'text', text: 'y' }], shadowedTokenCount: 20, provider: 'a', model: 'm' });
  sessionEvent(ctx, 's1', { type: 'compaction/end', compactionId: 'c3', turn: 6 });
  assert.equal(manager.versions('s1').handoffLabel, 'handoff_v2');
});

test('sessions are kept apart', async () => {
  const { ctx, manager } = await boot();
  await assemble(ctx, assemblyOf('rules one', 'p'), 's1');
  await assemble(ctx, assemblyOf('rules two', 'p'), 's2');
  assert.equal(manager.versions('s1').contextLabel, 'ctx_v1');
  assert.equal(manager.versions('s2').contextLabel, 'ctx_v1');
  // Different prefixes: each session has its own chain.
  assert.notEqual(manager.versions('s1').prefix, manager.versions('s2').prefix);
  assert.equal(manager.snapshots().length, 2);
});

test('the Router-facing hints aggregate the journal without deciding anything', async () => {
  const { ctx, manager } = await boot();
  const usage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 900 };
  await call(ctx, { provider: 'alpha', model: 'big', sessionId: 's1' }, [usageChunk(usage), finishOk]);
  await call(ctx, { provider: 'alpha', model: 'big', sessionId: 's1' }, [usageChunk(usage), finishOk]);

  const hints = manager.hintsFor('alpha', 'big');
  assert.equal(hints.provider, 'alpha');
  assert.equal(hints.model, 'big');
  assert.equal(hints.cacheObservable, true);
  assert.equal(hints.temperature.state, 'hot');
  assert.equal(hints.stats.calls, 2);
  assert.equal(hints.stats.callsWithCache, 2);
  assert.equal(hints.stats.hitTokens, 1800);
  assert.equal(hints.stats.missTokens, 200);
  assert.equal(hints.stats.averageHitRatio, 0.9);
  assert.equal(hints.contextLabel, 'ctx_v1');
  assert.equal(hints.handoffLabel, 'handoff_v0');

  const stats = manager.cacheStats();
  assert.equal(stats.calls, 2);
  assert.equal(stats.available, true);
  assert.equal(stats.averageHitRatio, 0.9);

  const all = manager.allHints();
  assert.equal(all.length, 1);
  assert.equal(all[0].provider, 'alpha');

  // The describe() snapshot is frozen and carries the same facts.
  const described = manager.describe();
  assert.ok(Object.isFrozen(described));
  assert.equal(described.journalLength, 2);
  assert.equal(described.stats.calls, 2);
});

test('a listener is called once per record, and a throwing listener is contained', async () => {
  const { ctx, manager } = await boot();
  const seen = [];
  const dispose = manager.onCall((record) => seen.push(record));
  manager.onCall(() => {
    throw new Error('listener failure');
  });
  await call(ctx, { provider: 'a', model: 'm', sessionId: 's' }, [finishOk]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, 'a');
  dispose();
  await call(ctx, { provider: 'a', model: 'm', sessionId: 's' }, [finishOk]);
  assert.equal(seen.length, 1, 'the disposer must unregister the listener');
  assert.throws(() => manager.onCall('not a function'), TypeError);
});

test('the journal is bounded, oldest first', async () => {
  const { ctx, manager } = await boot({ config: { journalLimit: 2 } });
  for (let index = 0; index < 4; index += 1) {
    await call(ctx, { provider: 'a', model: `m${index}`, sessionId: 's' }, [finishOk]);
  }
  const records = manager.recentCalls();
  assert.equal(records.length, 2);
  assert.equal(records[0].model, 'm2');
  assert.equal(records[1].model, 'm3');
  assert.equal(manager.recentCalls(1).length, 1);
  assert.equal(manager.recentCalls(0).length, 0);
  assert.deepEqual(manager.recentCalls(-1), []);
});

test('the manager seats nothing in the call path: the request is not mutated', async () => {
  const { ctx } = await boot();
  const request = { provider: 'a', model: 'm', messages: [{ role: 'user', content: 'hi' }], sessionId: 's' };
  const before = JSON.stringify(request);
  const stream = ctx.waterfall('llm/stream', request, () => generate([finishOk]));
  await collect(stream);
  assert.equal(JSON.stringify(request), before);
});

test('the plugin declares its identity and needs no service to mount', async () => {
  const module = await import('../plugins/context-cache-manager/index.js');
  assert.equal(module.name, 'context-cache-manager');
  assert.deepEqual(module.inject, [], 'the manager must mount without waiting for a service');
  assert.equal(module.default, undefined, 'a default export would discard name and inject');
  // apply() must not throw on a context that has no llm, no systemPrompt and no
  // sessions: the manager reads every seam through an optional subscription.
  const { Context } = await import(pathToFileURL(harnessPath('@deepseek-ai/cordis/lib/index.js')));
  const ctx = new Context();
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.ok(ctx.get('contextCache'));
});

// ============================================================ the launcher patch

test('the sample launcher patch Rust writes mounts the manager with no config', async () => {
  // The Rust suite writes this sample; `pnpm test` runs it first. Parsing it
  // with the harness's own YAML reader is the only check that the *document* —
  // not the strings — is what the loader will hand the plugin.
  let load;
  let text;
  try {
    ({ load } = await import(pathToFileURL(harnessPath('js-yaml/index.js'))));
    text = readFileSync(new URL('../src-tauri/target/test-tmp/launcher-sample.patch.yml', import.meta.url), 'utf8');
  } catch {
    // `cargo test` has not run yet; `pnpm test` runs it first.
    return;
  }
  const document = load(text);
  const rows = document[0].insert;
  const row = rows.find((entry) => entry.id === 'context-cache-manager');
  assert.ok(row, 'the sample patch must carry the context-cache-manager row');
  assert.match(row.name, /context-cache-manager\/index\.js$/);
  assert.equal(row.disabled, undefined);
  assert.equal(row.config, undefined, 'the manager has nothing to configure');

  // Mounting it from the row alone works: an empty configuration is a working
  // manager, which is what "unconfigured changes nothing" has to mean.
  const { Context } = await import(pathToFileURL(harnessPath('@deepseek-ai/cordis/lib/index.js')));
  const ctx = new Context();
  assert.doesNotThrow(() => apply(ctx, row.config ?? {}));
  assert.ok(ctx.get('contextCache'));
});

// ============================================================ no leaks
test('no layer, record or snapshot ever retains prompt text', async () => {
  // The whole privacy contract: a manager that logged the prompt would put a
  // project's own secrets in a file. Every representation the manager exposes
  // is searched for the sentinel the request carried.
  const secret = 'PROJECT-SECRET-DO-NOT-LOG-1234567890';
  const { ctx, manager } = await boot();
  await assemble(ctx, assemblyOf(`system rules ${secret}`, `project ${secret}`), 's1');
  await call(
    ctx,
    {
      provider: 'alpha',
      model: 'm',
      sessionId: 's1',
      messages: [
        { role: 'system', content: secret },
        { role: 'user', content: secret },
        { role: 'assistant', content: secret },
        { role: 'user', source: { kind: 'tool', callId: 'c' }, content: secret },
      ],
    },
    [usageChunk({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 5 }), finishOk],
  );

  const serialized = JSON.stringify({
    record: manager.recentCalls().at(-1),
    snapshot: manager.current('s1'),
    describe: manager.describe(),
    hints: manager.allHints(),
  });
  assert.ok(!serialized.includes(secret), 'prompt text reached a manager representation');
  assert.ok(!serialized.includes('1234567890'), 'a secret-shaped run reached a manager representation');
  // The layers are still described, by digest and by name.
  const record = manager.recentCalls().at(-1);
  assert.equal(typeof record.layers.core, 'string');
  assert.equal(typeof record.layers.live, 'string');
});

test('canonical serialization does not depend on key order', () => {
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.equal(digest('abc'), digest('abc'));
  assert.notEqual(digest('abc'), digest('abd'));
  assert.equal(digest('abc').length, 16);
});
