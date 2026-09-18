#!/usr/bin/env node
/**
 * audit-usage.mjs — cross-check the DeepSeek API dashboard against the durable
 * session logs on this machine, and derive the effective token price.
 *
 * Reads every `~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl[.zstd]`
 * through the `zstd` CLI (the logs are multi-frame), folds each
 * `assistant/message` event's provider-reported usage, and prints:
 *   - per-model requests / cache-hit / cache-miss / output tokens,
 *   - the cache-hit share (the real cost driver),
 *   - the cost at prices.json rates,
 *   - the blended $/M and the uniform scale factor the dashboard implies.
 *
 * Usage:
 *   node audit-usage.mjs
 *   node audit-usage.mjs --spent 8.06 --requests 5869 --tokens 1267739345
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionLogs, readEvents } from './session-logs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Parse `--flag value` pairs. */
function flag(name, fallback) {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? fallback : Number(process.argv[index + 1]);
}

const DASHBOARD = {
	spent: flag('spent', 8.06),
	requests: flag('requests', 5869),
	tokens: flag('tokens', 1267739345),
};

const prices = JSON.parse(readFileSync(join(HERE, 'prices.json'), 'utf8'));
const currency = prices.currency ?? '$';

const perModel = new Map();
const perWorkspace = new Map();
const perDay = new Map();
const totals = { requests: 0, cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
let logs = 0;
let firstTime = Number.POSITIVE_INFINITY;
let lastTime = 0;

/** Money for one route's buckets under prices.json. */
function costOf(key, buckets) {
	const rate = prices.models[key] ?? prices.fallback;
	return (
		(buckets.cacheMiss * rate.cacheMiss +
			buckets.cacheHit * rate.cacheHit +
			buckets.cacheWrite * (rate.cacheWrite ?? rate.cacheMiss) +
			buckets.output * rate.output) /
		1e6
	);
}

for (const log of sessionLogs()) {
	logs += 1;
	for await (const event of await readEvents(log)) {
		if (event.type !== 'assistant/message') continue;
		const usage = event.data?.usage;
		if (usage === undefined) continue;
		const source = event.data?.message?.source ?? {};
		const model = source.model ?? 'unknown';
		const provider = source.provider ?? 'unknown';
		const key = `${provider}/${model}`;
		const row = perModel.get(key) ?? { requests: 0, cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 };
		const buckets = {
			cacheMiss: usage.inputTokens ?? 0,
			cacheHit: usage.cacheReadTokens ?? 0,
			cacheWrite: usage.cacheWriteTokens ?? 0,
			output: usage.outputTokens ?? 0,
			reasoning: usage.reasoningTokens ?? 0,
			total: usage.totalTokens ?? 0,
		};
		row.requests += 1;
		for (const [name, value] of Object.entries(buckets)) row[name] += value;
		perModel.set(key, row);
		const workspaceRow = perWorkspace.get(log.workspace) ?? { requests: 0, total: 0, cost: 0 };
		workspaceRow.requests += 1;
		workspaceRow.total += buckets.total;
		perWorkspace.set(log.workspace, workspaceRow);
		const day = new Date(event.time ?? 0).toISOString().slice(0, 10);
		const dayRow = perDay.get(day) ?? { requests: 0, cacheMiss: 0, cacheHit: 0, output: 0, total: 0, cost: 0 };
		dayRow.requests += 1;
		dayRow.cacheMiss += buckets.cacheMiss;
		dayRow.cacheHit += buckets.cacheHit;
		dayRow.output += buckets.output;
		dayRow.total += buckets.total;
		dayRow.cost += costOf(key, buckets);
		perDay.set(day, dayRow);
		totals.requests += 1;
		for (const [name, value] of Object.entries(buckets)) totals[name] += value;
		firstTime = Math.min(firstTime, event.time ?? Number.POSITIVE_INFINITY);
		lastTime = Math.max(lastTime, event.time ?? 0);
	}
}

const table = [];
for (const [key, row] of perModel) {
	row.key = key;
	row.cost = costOf(key, row);
	table.push(row);
}
const localCost = table.reduce((sum, row) => sum + row.cost, 0);

/** Money text. */
function money(value) {
	return `${currency}${value.toFixed(value >= 1 ? 2 : 4)}`;
}
/** Compact integer. */
function count(value) {
	return value.toLocaleString('en-US');
}

console.log(`\nSession logs read: ${String(logs)} file(s) in ${String(perWorkspace.size)} workspace(s)`);
if (Number.isFinite(firstTime) && lastTime > 0) {
	console.log(`Window: ${new Date(firstTime).toISOString().slice(0, 10)} → ${new Date(lastTime).toISOString().slice(0, 10)}`);
}

console.log('\nPer route (provider/model):');
console.log('  requests   cache-miss      cache-hit       output          total           cost');
for (const row of table.sort((a, b) => b.total - a.total)) {
	console.log(
		`  ${String(row.requests).padStart(8)}   ${count(row.cacheMiss).padStart(12)}  ${count(row.cacheHit).padStart(13)}  ${count(row.output).padStart(12)}  ${count(row.total).padStart(14)}  ${money(row.cost).padStart(10)}  ${row.key}`,
	);
}

const hitShare = totals.cacheHit / Math.max(1, totals.cacheHit + totals.cacheMiss);
console.log('\nPer day:');
console.log('  day          requests      cache-hit       output          total           cost');
for (const [day, row] of [...perDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
	console.log(
		`  ${day}   ${String(row.requests).padStart(8)}  ${count(row.cacheHit).padStart(13)}  ${count(row.output).padStart(12)}  ${count(row.total).padStart(14)}  ${money(row.cost).padStart(10)}`,
	);
}

console.log('\nLocal totals:');
console.log(`  requests        ${count(totals.requests)}`);
console.log(`  cache-miss in   ${count(totals.cacheMiss)}`);
console.log(`  cache-hit in    ${count(totals.cacheHit)}`);
console.log(`  cache-write in  ${count(totals.cacheWrite)}`);
console.log(`  output          ${count(totals.output)}${totals.reasoning > 0 ? ` (dont ${count(totals.reasoning)} de raisonnement)` : ''}`);
console.log(`  total tokens    ${count(totals.total)}`);
console.log(`  cache-hit share ${(hitShare * 100).toFixed(1)}% of prompt tokens`);
console.log(`  tokens/request  ${Math.round(totals.total / Math.max(1, totals.requests)).toLocaleString('en-US')}`);

console.log('\nDashboard comparison:');
console.log(`  requests        local ${count(totals.requests)}  vs  dashboard ${count(DASHBOARD.requests)}  (${((totals.requests / DASHBOARD.requests) * 100).toFixed(0)}%)`);
console.log(`  total tokens    local ${count(totals.total)}  vs  dashboard ${count(DASHBOARD.tokens)}  (${((totals.total / DASHBOARD.tokens) * 100).toFixed(0)}%)`);
console.log(`  tokens/request  local ${Math.round(totals.total / Math.max(1, totals.requests)).toLocaleString('en-US')}  vs  dashboard ${Math.round(DASHBOARD.tokens / DASHBOARD.requests).toLocaleString('en-US')}`);

const impliedBlended = (DASHBOARD.spent / Math.max(1, totals.total)) * 1e6;
const scale = DASHBOARD.spent / Math.max(1e-9, localCost);
console.log('\nPricing:');
console.log(`  cost at prices.json        ${money(localCost)}`);
console.log(`  dashboard spend            ${money(DASHBOARD.spent)}`);
console.log(`  implied blended rate       ${currency}${impliedBlended.toFixed(5)} / M tokens`);
console.log(`  uniform scale factor       ${scale.toFixed(3)}x applied to every rate in prices.json`);
console.log(`  → cache-hit @ ${currency}${(prices.fallback.cacheHit * scale).toFixed(5)} / M, cache-miss @ ${currency}${(prices.fallback.cacheMiss * scale).toFixed(5)} / M, output @ ${currency}${(prices.fallback.output * scale).toFixed(5)} / M`);
console.log('\nNote: the scale factor is only valid if prices.json rates keep their relative');
console.log('shape (the dashboard does not break spend down per bucket).\n');
