#!/usr/bin/env node
/**
 * verify-host-plugin.mjs — prove the deployed `cost` projection is correct.
 *
 * It imports the DEPLOYED plugin (so `zod` resolves the way the Loader resolves
 * it), captures the definition its `apply` registers against a fake registry,
 * and then checks:
 *   1. the registered schemas accept a real folded state and view;
 *   2. synthetic cases: per-route pricing, and the fork prefix (events before
 *      `inheritedEventCount`) contributing nothing — a parent's spend must not
 *      be billed twice;
 *   3. the view object is reference-stable per state (a registry contract);
 *   4. replaying every durable session log through the fold reproduces, session
 *      by session, the money an independent event-by-event fold computes.
 *
 * Usage: node verify-host-plugin.mjs
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costOf, loadPrices, money } from './pricing.mjs';
import { readEvents, sessionLogs } from './session-logs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(homedir(), '.dsh/profiles/web/plugins/dsh-cost-projection/lib/index.js');
const PRICES_PATH = join(HERE, 'prices.json');

const checks = [];
/** Record one named check (async results are awaited). */
async function check(name, run) {
	try {
		const detail = await run();
		checks.push({ name, ok: true, detail: detail ?? '' });
	} catch (error) {
		checks.push({ name, ok: false, detail: error.message });
	}
}
/** Assert a condition or throw with a message. */
function assert(condition, message) {
	if (!condition) throw new Error(message);
}

if (!existsSync(PLUGIN)) {
	console.error(`deployed plugin missing: ${PLUGIN}\nrun: node install-host-plugin.mjs`);
	process.exit(1);
}

/* the registered definition, captured against a fake registry -------------- */

const registry = { definitions: [] };
const mod = await import(PLUGIN);
await check('plugin: module shape', () => {
	assert(typeof mod.apply === 'function', 'apply is not a function');
	assert(mod.name === 'cost-projection', `name is ${String(mod.name)}`);
	assert(Array.isArray(mod.inject) && mod.inject.includes('sessionProjections'), 'inject does not declare sessionProjections');
	return `name=${mod.name}, inject=[${mod.inject.join(', ')}]`;
});

mod.apply(
	{ sessionProjections: { register: (definition) => registry.definitions.push(definition) } },
	{ pricesPath: PRICES_PATH },
);
const definition = registry.definitions[0];
await check('plugin: registers exactly one unit', () => {
	assert(registry.definitions.length === 1, `registered ${String(registry.definitions.length)} units`);
	assert(definition.key === 'cost', `key is ${String(definition.key)}`);
	assert(definition.stateVersion === 1, `stateVersion is ${String(definition.stateVersion)}`);
	assert(typeof definition.wire?.view === 'function', 'no client view');
	return `key=cost, stateVersion=1`;
});

/* synthetic folds ----------------------------------------------------------- */

/** One settled assistant message for a route. */
function message(seq, provider, model, usage) {
	return { type: 'assistant/message', seq, data: { usage, message: { source: { kind: 'model', provider, model } } } };
}

const PRICES = loadPrices();

await check('fold: prices each route with its own row', () => {
	let state = definition.init({}, 0);
	state = definition.apply(state, message(1, 'deepseek-official', 'deepseek-flash', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }));
	state = definition.apply(state, message(2, 'deepseek-official', 'deepseek-v4-pro', { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0 }));
	state = definition.stateSchema.parse(state);
	const view = definition.wire.viewSchema.parse(definition.wire.view(state));
	const flash = PRICES.models['deepseek-official/deepseek-flash'] ?? PRICES.fallback;
	const pro = PRICES.models['deepseek-official/deepseek-v4-pro'] ?? PRICES.fallback;
	const expected = (1_000_000 * flash.cacheMiss + 1_000_000 * pro.output) / 1e6;
	assert(Math.abs(view.total - expected) < 1e-9, `expected ${String(expected)}, got ${String(view.total)}`);
	assert(view.routes.length === 2, `expected 2 route rows, got ${String(view.routes.length)}`);
	assert(view.buckets.cacheMiss === 1_000_000 && view.buckets.output === 1_000_000, 'totals do not match the deltas');
	return `${money(PRICES, view.total)} over ${String(view.routes.length)} routes`;
});

await check('fold: ignores non-usage and non-settled events', () => {
	let state = definition.init({}, 0);
	const before = state;
	state = definition.apply(state, { type: 'tool/call', seq: 1, data: {} });
	state = definition.apply(state, { type: 'assistant/message', seq: 2, data: {} });
	state = definition.apply(state, { type: 'assistant/attempt', seq: 3, data: { stream: [] } });
	assert(state === before, 'an uninteresting event must return the same state reference');
	return 'same reference for tool calls and stream-only attempts';
});

await check('fold: skips the inherited fork prefix', () => {
	let state = definition.init({}, 5);
	state = definition.apply(state, message(3, 'deepseek-official', 'deepseek-flash', { inputTokens: 999, outputTokens: 999, cacheReadTokens: 999 }));
	assert(state.totals.cacheMiss === 0 && state.totals.output === 0, 'inherited events must not be counted');
	state = definition.apply(state, message(6, 'deepseek-official', 'deepseek-flash', { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0 }));
	assert(state.totals.cacheMiss === 10, "the child own events must be counted");
	return 'seq < inheritedEventCount contributes nothing';
});

await check('view: reference-stable per state', () => {
	const state = definition.init({}, 0);
	const first = definition.wire.view(state);
	const second = definition.wire.view(state);
	assert(first === second, 'the view must reuse its reference while the state is unchanged');
	const next = definition.apply(state, message(1, 'p', 'm', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1 }));
	assert(definition.wire.view(next) !== first, 'a new state must publish a new view');
	return 'Object.is contract holds';
});

await check('view: malformed prices never break the view', () => {
	const local = [];
	mod.apply({ sessionProjections: { register: (d) => local.push(d) } }, { pricesPath: '/nonexistent/prices.json' });
	const fallbackDefinition = local[0];
	const state = fallbackDefinition.apply(fallbackDefinition.init({}, 0), message(1, 'p', 'm', { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }));
	const view = fallbackDefinition.wire.viewSchema.parse(fallbackDefinition.wire.view(state));
	assert(view.total > 0 && view.currency === '$', 'the built-in fallback row must still price tokens');
	return `built-in fallback prices ${money(PRICES, view.total)}`;
});

/* real logs ---------------------------------------------------------------- */

await check('fold: reproduces an independent fold over every session log', async () => {
	let sessions = 0;
	let mismatches = 0;
	let pluginTotal = 0;
	let plainTotal = 0;
	for (const log of sessionLogs()) {
		let state = definition.init({}, 0);
		let plain = 0;
		for await (const event of await readEvents(log)) {
			state = definition.apply(state, event);
			if (event.type !== 'assistant/message') continue;
			const usage = event.data?.usage;
			if (usage === undefined) continue;
			const source = event.data?.message?.source ?? {};
			plain += costOf(PRICES, `${source.provider}/${source.model}`, {
				cacheMiss: usage.inputTokens ?? 0,
				cacheHit: usage.cacheReadTokens ?? 0,
				cacheWrite: usage.cacheWriteTokens ?? 0,
				output: usage.outputTokens ?? 0,
			});
		}
		const view = definition.wire.view(state);
		pluginTotal += view.total;
		plainTotal += plain;
		sessions += 1;
		if (Math.abs(view.total - plain) > 1e-9) mismatches += 1;
	}
	assert(mismatches === 0, `${String(mismatches)}/${String(sessions)} sessions disagree with the plain fold`);
	return `${String(sessions)} sessions, ${money(PRICES, pluginTotal)} both ways`;
});

/* report ------------------------------------------------------------------ */

for (const entry of checks) {
	console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : ` — ${entry.detail}`}`);
}
const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${String(checks.length - failed)}/${String(checks.length)} checks passed`);
process.exit(failed === 0 ? 0 : 1);
