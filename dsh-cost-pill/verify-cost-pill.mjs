#!/usr/bin/env node
/**
 * verify-cost-pill.mjs — prove the two client patches are wired and correct.
 *
 * Chat bundle:
 *   1. the money helpers exist and carry NO price table (the host projection is
 *      the only price source);
 *   2. the pure helpers price a synthetic host `cost` view correctly;
 *   3. the composer pill is gated on the projection, and the per-Turn dialog has
 *      its cost row (with the comma that keeps the JSX array valid);
 *   4. both locale dictionaries carry the new keys.
 *
 * Workspace bundle:
 *   5. `deriveProjectCosts` is folded once per derivation and hung on each group;
 *   6. the badge renders after the project name, with its tooltip key;
 *   7. the project fold includes subagent Sessions, excludes archived ones, and
 *      falls back to the token projection only when a `cost` row is missing.
 *
 * Both bundles must still parse, and the pre-patch backups must exist.
 *
 * Usage: node verify-cost-pill.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costOf, loadPrices, money } from './pricing.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALL = join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai');
const CHAT_BUNDLE = join(INSTALL, 'dsh-client-ui-chat/lib/client.js');
const WORKSPACE_BUNDLE = join(INSTALL, 'dsh-client-ui-workspace/lib/client.js');
const PRICES = loadPrices();

const checks = [];
/** Record one named check. */
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
/** Lines of one bundle. */
function readBundle(path) {
	assert(existsSync(path), `bundle missing: ${path}`);
	return readFileSync(path, 'utf8');
}
/** The source between a `//#region <marker>` and its first `//#endregion`. */
function regionOf(source, marker) {
	const lines = source.split('\n');
	const start = lines.findIndex((line) => line.includes(`//#region ${marker}`));
	assert(start !== -1, `region ${marker} missing — run apply-cost-pill.mjs`);
	const end = lines.findIndex((line, index) => index > start && line.includes('//#endregion'));
	assert(end > start, `region ${marker} is not closed`);
	return lines.slice(start, end + 1).join('\n');
}

const chat = readBundle(CHAT_BUNDLE);
const chatLines = chat.split('\n');
const workspace = readBundle(WORKSPACE_BUNDLE);
const workspaceLines = workspace.split('\n');

/* ---------------------------------------------------------------- chat ---- */

const chatPricing = regionOf(chat, 'dsh-cost-pill/pricing');
const react_jsx_runtime = { jsx: () => ({}), jsxs: () => ({}), Fragment: {} };
// eslint-disable-next-line no-new-func -- deliberate evaluation of the injected region
const pill = new Function(
	'react_jsx_runtime',
	`${chatPricing}\nreturn { costPillFormat, costPillRate, costPillRouteKey, costPillOfUsage, costPillSplit, costPillRateLabel };`,
)(react_jsx_runtime);

/** A synthetic host view: two routes, priced per route. */
const VIEW = {
	currency: '$',
	rates: { cacheHit: 1, cacheMiss: 10, cacheWrite: 10, output: 100 },
	models: { 'p/a': { cacheHit: 1, cacheMiss: 10, cacheWrite: 10, output: 100 } },
	total: 0,
	buckets: { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 },
	routes: [
		{ route: 'p/a', buckets: { cacheMiss: 0, cacheHit: 1_000_000, cacheWrite: 0, output: 0 }, cost: 1 },
		{ route: 'p/b', buckets: { cacheMiss: 1_000_000, cacheWrite: 0, cacheHit: 0, output: 0 }, cost: 10 },
	],
};

await check('chat: no price table in the bundle', () => {
	assert(!chat.includes('const COST_PILL ='), 'the bundle still carries an injected price table');
	assert(!chat.includes('"models": {'), 'the bundle still inlines a model price table');
	return 'rates come from the host projection';
});

await check('chat: money formatting scales', () => {
	assert(pill.costPillFormat(0.0042, '$') === '$0.0042', `small => ${pill.costPillFormat(0.0042, '$')}`);
	assert(pill.costPillFormat(0.728, '$') === '$0.728', `mid => ${pill.costPillFormat(0.728, '$')}`);
	assert(pill.costPillFormat(2.5, '$') === '$2.50', `large => ${pill.costPillFormat(2.5, '$')}`);
	return '$0.0042 / $0.728 / $2.50';
});

await check('chat: route lookup falls back to the host fallback row', () => {
	assert(pill.costPillRate(VIEW, 'p/a') === VIEW.models['p/a'], 'known route must use its own row');
	assert(pill.costPillRate(VIEW, 'p/z') === VIEW.rates, 'unknown route must use the fallback row');
	assert(pill.costPillRouteKey({ provider: 'p', model: 'a' }) === 'p/a', 'route key must be provider/model');
	assert(pill.costPillRate(undefined, 'p/a') === undefined, 'an absent projection must price nothing');
	return 'host rows, no local table';
});

await check('chat: per-Turn buckets price with the host rate', () => {
	const usage = { uncachedInputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 };
	assert(pill.costPillOfUsage(usage, VIEW.rates) === 10, `expected 10, got ${String(pill.costPillOfUsage(usage, VIEW.rates))}`);
	assert(pill.costPillOfUsage({ totals: usage }, VIEW.rates) === 10, 'a nested {totals} projection value must work too');
	return pill.costPillRateLabel(VIEW.rates, '$');
});

await check('chat: session split prices each route with its own row', () => {
	const split = pill.costPillSplit(VIEW);
	assert(Math.abs(split.reread - 1) < 1e-9, `reread => ${String(split.reread)}`);
	assert(Math.abs(split.newInput - 10) < 1e-9, `newInput => ${String(split.newInput)}`);
	assert(Math.abs(split.output) < 1e-9, `output => ${String(split.output)}`);
	return `re-reads ${pill.costPillFormat(split.reread, '$')}, new input ${pill.costPillFormat(split.newInput, '$')}`;
});

await check('chat: pill and per-Turn row are wired', () => {
	assert(chat.includes('function CostPill({ cost, routeKey, t })'), 'CostPill does not take the projection');
	assert(chat.includes('const totalText = costPillFormat(cost.total, cost.currency);'), 'CostPill does not show the host total');
	assert(chat.includes('hasTokens && cost !== void 0 && (0, react_jsx_runtime.jsx)(CostPill, {'), 'the pill is not gated on the projection');
	assert(chat.includes('const cost = useProjection("cost");'), 'StatsPills does not read the projection');
	assert(chat.includes('function TurnUsagePanel({ usage, cost, t })'), 'the Turn dialog is not given the projection');
	const costRow = chatLines.findIndex((line) => line.includes('"dt"') && line.includes('t("message.turnUsage.cost")'));
	assert(costRow !== -1, 'the per-Turn cost row is missing');
	assert(chatLines[costRow - 1].trimEnd().endsWith(','), 'the line before the cost row lacks a comma');
	return `per-Turn row at line ${String(costRow + 1)}`;
});

await check('chat: locale keys', () => {
	const keys = [
		'stats.cost',
		'stats.dialog.costTitle',
		'stats.dialog.costModel',
		'stats.dialog.costRate',
		'stats.dialog.costReread',
		'stats.dialog.costNewInput',
		'stats.dialog.costOutput',
		'message.turnUsage.cost',
	];
	for (const key of keys) {
		const hits = chatLines.filter((line) => line.includes(`"${key}":`)).length;
		assert(hits === 2, `key ${key} found ${String(hits)} time(s), expected en + zh`);
	}
	return `${String(keys.length)} keys x 2 dictionaries`;
});

/* ----------------------------------------------------------- workspace ---- */

const workspaceRegion = regionOf(workspace, 'dsh-cost-pill/project-cost');
/** The derivation helpers, with the bundle-scoped grouping helper stubbed in. */
const projects = new Function(
	'owningGroupKey',
	`${workspaceRegion}\nreturn { deriveProjectCosts, projectCostMoney, projectCostOfBuckets };`,
)((workspaces, id) => workspaces.find((workspace) => workspace.sessionIds.includes(id))?.workspaceId ?? '');

await check('workspace: badge wired into the project row', () => {
	assert(workspace.includes('const projectCosts = deriveProjectCosts(list, workspaces, archived);'), 'deriveGroups does not fold project costs');
	assert(workspace.includes('cost: projectCosts.get(g.key),'), 'the group node carries no cost');
	assert(workspace.includes('children: (group.cost.complete ? "" : "≈ ") + projectCostMoney(group.cost.total, group.cost.currency)'), 'the badge does not render the total');
	assert(workspace.includes('title: t("cost.title"),'), 'the badge tooltip key is missing');
	const key = workspaceLines.findIndex((line) => line.includes('"cost.title":'));
	assert(key !== -1, 'the cost.title locale key is missing');
	assert(workspaceLines.filter((line) => line.includes('"cost.title":')).length === 2, 'cost.title must exist in en and zh');
	return 'badge after the project name';
});

await check('workspace: project fold counts subagents, skips archived', () => {
	const list = {
		ids: ['root-1', 'sub-1', 'archived-1', 'other-1'],
		byId: {
			'root-1': { id: 'root-1', projectionValues: { cost: { total: 5, currency: '$', models: {}, rates: {} } } },
			'sub-1': { id: 'sub-1', origin: 'subagent', projectionValues: { cost: { total: 2, currency: '$', models: {}, rates: {} } } },
			'archived-1': { id: 'archived-1', projectionValues: { cost: { total: 99, currency: '$', models: {}, rates: {} } } },
			'other-1': { id: 'other-1', projectionValues: { cost: { total: 1, currency: '$', models: {}, rates: {} } } },
		},
	};
	const workspaces = [
		{ workspaceId: 'w1', sessionIds: ['root-1', 'sub-1', 'archived-1'] },
		{ workspaceId: 'w2', sessionIds: ['other-1'] },
	];
	const costs = projects.deriveProjectCosts(list, workspaces, new Set(['archived-1']));
	assert(costs.get('w1').total === 7, `w1 total => ${String(costs.get('w1').total)} (subagent included, archived excluded)`);
	assert(costs.get('w1').sessions === 2, `w1 sessions => ${String(costs.get('w1').sessions)}`);
	assert(costs.get('w1').complete === true, 'a host-priced group is complete');
	assert(costs.get('w2').total === 1, `w2 total => ${String(costs.get('w2').total)}`);
	return 'subagent spend included, archived spend excluded';
});

await check('workspace: missing cost rows fall back and mark the total', () => {
	const models = { 'p/a': PRICES.models['deepseek-official/deepseek-flash'] ?? PRICES.fallback };
	const rates = PRICES.fallback;
	const list = {
		ids: ['priced', 'legacy'],
		byId: {
			priced: { id: 'priced', projectionValues: { cost: { total: 3, currency: '$', models, rates } } },
			legacy: {
				id: 'legacy',
				projectionValues: { tokenUsage: { cacheMiss: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0, outputTokens: 0 } },
			},
		},
	};
	const costs = projects.deriveProjectCosts(list, [{ workspaceId: 'w', sessionIds: ['priced', 'legacy'] }], new Set());
	const expectedFallback = projects.projectCostOfBuckets(list.byId.legacy.projectionValues.tokenUsage, models['p/a']);
	assert(Math.abs(costs.get('w').total - (3 + expectedFallback)) < 1e-9, `total => ${String(costs.get('w').total)}`);
	assert(costs.get('w').complete === false, 'a group with an unpriced Session must be marked incomplete');
	return `priced 3 + legacy ${projects.projectCostMoney(expectedFallback, '$')} (≈), rates from the host view`;
});

await check('workspace: no host view means no badge', () => {
	const list = { ids: ['a'], byId: { a: { id: 'a', projectionValues: { tokenUsage: { cacheMiss: 5 } } } } };
	const costs = projects.deriveProjectCosts(list, [{ workspaceId: 'w', sessionIds: ['a'] }], new Set());
	assert(costs.size === 0, 'without a cost view nothing may be priced');
	return 'capability absence renders no money';
});

/* ---------------------------------------------------------- integrity ---- */

await check('bundles still parse', () => {
	for (const path of [CHAT_BUNDLE, WORKSPACE_BUNDLE]) execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
	return 'node --check x2';
});

await check('pre-patch backups exist', () => {
	for (const path of [CHAT_BUNDLE, WORKSPACE_BUNDLE]) {
		assert(existsSync(`${path}.cost-pill.orig`), `backup missing for ${path.split('/').pop()}`);
	}
	return 'revert stays possible';
});

/* report ------------------------------------------------------------------ */

for (const entry of checks) {
	console.log(`${entry.ok ? 'ok  ' : 'FAIL'}  ${entry.name}${entry.detail === '' ? '' : ` — ${entry.detail}`}`);
}
const failed = checks.filter((entry) => !entry.ok).length;
console.log(`\n${String(checks.length - failed)}/${String(checks.length)} checks passed`);
if (failed === 0) console.log(`prices in play: ${money(PRICES, 1)} scale — ${String(Object.keys(PRICES.models).length)} routes, e.g. ${money(PRICES, costOf(PRICES, undefined, { cacheMiss: 1e6, cacheHit: 0, cacheWrite: 0, output: 0 }))} per 1M cache-miss (host-owned)`);
process.exit(failed === 0 ? 0 : 1);
