#!/usr/bin/env node
/**
 * audit-cache.mjs — what the context manager and the cache discipline actually
 * do, measured on the durable session logs.
 *
 * The harness keeps the model-visible surface APPEND-ONLY so every request
 * reuses the provider's KV/prompt cache; only a surface replace (a compaction,
 * or an in-history system-prompt update) invalidates reuse from the first
 * changed token. This script measures both sides:
 *   - the surface discipline: appends vs replaces, automatic vs `/compact`
 *     condensations, pruner rewrites;
 *   - the cache outcome per session class: root sessions vs spawned subagents
 *     vs forked children (a fork inherits the parent prefix and stays
 *     cache-eligible; a spawn starts cold).
 *
 * Usage: node audit-cache.mjs
 */
import { sessionLogs, readEvents } from './session-logs.mjs';
import { costOf, count, loadPrices, money } from './pricing.mjs';

const prices = loadPrices();

const perClass = new Map();
const surface = { appends: 0, replaces: 0, replacesByType: new Map(), autoCompactions: 0, commandCompactions: 0 };
let sessions = 0;
let firstTime = Number.POSITIVE_INFINITY;
let lastTime = 0;

/** Empty accumulator. */
function emptyRow() {
	return { sessions: 0, requests: 0, cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, total: 0, cost: 0 };
}
/** Add one session's buckets into a row. */
function addInto(row, local) {
	row.sessions += 1;
	for (const field of ['requests', 'cacheMiss', 'cacheHit', 'cacheWrite', 'output', 'total', 'cost']) {
		row[field] += local[field];
	}
}

for (const log of sessionLogs()) {
	const meta = { origin: 'root', provider: undefined };
	const local = emptyRow();
	for await (const event of readEvents(log)) {
		if (event.type === 'session') meta.origin = event.origin ?? 'root';
		if (event.type === 'subagent/descriptor') meta.provider = event.data?.provider;

		// `append` rides as a bare string; a replace rides as an object.
		const op = typeof event.surfaceOp === 'string' ? event.surfaceOp : event.surfaceOp?.op;
		if (op === 'append') surface.appends += 1;
		if (op === 'replace') {
			surface.replaces += 1;
			const kind = event.type === 'system/message' ? 'system prompt (in-history)' : event.type === 'user/message' ? 'compaction summary' : `rewrite (${event.type})`;
			surface.replacesByType.set(kind, (surface.replacesByType.get(kind) ?? 0) + 1);
		}
		if (event.type === 'compaction/start') {
			if (event.data?.sourceCommandId === undefined) surface.autoCompactions += 1;
			else surface.commandCompactions += 1;
		}

		if (event.type !== 'assistant/message') continue;
		const usage = event.data?.usage;
		if (usage === undefined) continue;
		const source = event.data?.message?.source ?? {};
		const buckets = {
			cacheMiss: usage.inputTokens ?? 0,
			cacheHit: usage.cacheReadTokens ?? 0,
			cacheWrite: usage.cacheWriteTokens ?? 0,
			output: usage.outputTokens ?? 0,
			total: usage.totalTokens ?? 0,
		};
		local.requests += 1;
		for (const [name, value] of Object.entries(buckets)) local[name] += value;
		local.cost += costOf(prices, `${source.provider ?? 'unknown'}/${source.model ?? 'unknown'}`, buckets);
		firstTime = Math.min(firstTime, event.time ?? Number.POSITIVE_INFINITY);
		lastTime = Math.max(lastTime, event.time ?? 0);
	}
	sessions += 1;
	const key = meta.origin === 'root' ? 'root' : (meta.provider ?? 'subagent');
	const row = perClass.get(key) ?? emptyRow();
	addInto(row, local);
	perClass.set(key, row);
}

const rows = [...perClass.entries()];
const totalCost = rows.reduce((sum, [, row]) => sum + row.cost, 0);
const totalMiss = rows.reduce((sum, [, row]) => sum + row.cacheMiss, 0);

console.log(`\nSession logs: ${String(sessions)} file(s)`);
if (Number.isFinite(firstTime) && lastTime > 0) {
	console.log(`Window: ${new Date(firstTime).toISOString().slice(0, 10)} → ${new Date(lastTime).toISOString().slice(0, 10)}`);
}

console.log('\nSurface discipline (what keeps the cache reusable):');
console.log(`  appends                            ${count(surface.appends)}`);
console.log(`  replaces                           ${count(surface.replaces)}   ${[...surface.replacesByType].map(([kind, n]) => `${kind}: ${String(n)}`).join(', ') || '(none)'}`);
console.log(`  condensations (automatic)          ${count(surface.autoCompactions)}`);
console.log(`  condensations (/compact)           ${count(surface.commandCompactions)}`);
console.log(`  append share                       ${((surface.appends / Math.max(1, surface.appends + surface.replaces)) * 100).toFixed(2)}%`);

console.log('\nCache outcome and cost by session class:');
console.log('  class      sessions  requests    cache-miss     cache-hit   hit-share      miss-cost     hit-cost     out-cost       total');
for (const [key, row] of rows.sort((a, b) => b[1].total - a[1].total)) {
	const share = row.cacheHit / Math.max(1, row.cacheHit + row.cacheMiss);
	const missCost = costOf(prices, undefined, { cacheMiss: row.cacheMiss, cacheHit: 0, cacheWrite: 0, output: 0 });
	const hitCost = costOf(prices, undefined, { cacheMiss: 0, cacheHit: row.cacheHit, cacheWrite: 0, output: 0 });
	const outCost = costOf(prices, undefined, { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: row.output });
	console.log(
		`  ${key.padEnd(9)} ${String(row.sessions).padStart(8)}  ${String(row.requests).padStart(8)}  ${count(row.cacheMiss).padStart(12)}  ${count(row.cacheHit).padStart(13)}  ${(share * 100).toFixed(1).padStart(8)}%  ${money(prices, missCost).padStart(11)}  ${money(prices, hitCost).padStart(11)}  ${money(prices, outCost).padStart(10)}  ${money(prices, row.cost).padStart(10)}`,
	);
}

console.log('\nReading:');
for (const [key, row] of rows) {
	const missShare = row.cacheMiss / Math.max(1, totalMiss);
	const costShare = row.cost / Math.max(1e-9, totalCost);
	console.log(
		`  ${key}: ${(missShare * 100).toFixed(1)}% of all cache-miss tokens for ${(costShare * 100).toFixed(1)}% of the cost (${money(prices, row.cost)})`,
	);
}

const totalHit = rows.reduce((sum, [, row]) => sum + row.cacheHit, 0);
const totalOutput = rows.reduce((sum, [, row]) => sum + row.output, 0);
const asHits = costOf(prices, undefined, { cacheMiss: 0, cacheHit: totalHit, cacheWrite: 0, output: totalOutput });
const asMisses = costOf(prices, undefined, { cacheMiss: totalHit, cacheHit: 0, cacheWrite: 0, output: totalOutput });
console.log('\nCounterfactual:');
console.log(`  the ${count(totalHit)} re-read tokens billed at the cache-hit rate  ${money(prices, asHits)}`);
console.log(`  the same volume billed at the cache-miss rate                   ${money(prices, asMisses)}  (${(asMisses / Math.max(1e-9, asHits)).toFixed(1)}x)`);
console.log('\nA spawned child starts cold: its own prompt is cache-miss at the miss rate.');
console.log('A forked child inherits the parent prefix, so that history stays cache-eligible.\n');
