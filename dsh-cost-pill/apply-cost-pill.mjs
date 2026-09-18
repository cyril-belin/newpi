#!/usr/bin/env node
/**
 * apply-cost-pill.mjs — render the host `cost` projection in the DSH web GUI.
 *
 * Two client bundles are patched (text-level, marker-guarded, idempotent):
 *
 *   1. `@deepseek-ai/dsh-client-ui-chat` — the composer cost pill next to the
 *      token/time pills, with a dialog that names the priced route, the rates,
 *      and the re-read / new-input / output split, plus one "Est. cost" row in
 *      every per-Turn usage dialog;
 *   2. `@deepseek-ai/dsh-client-ui-workspace` — one money badge per project row
 *      in the sidebar, summed over every Session of that Workspace (subagent
 *      Sessions included; archived ones excluded).
 *
 * Neither patch carries a price table: the rates and the money ride the `cost`
 * session projection registered by the host plugin (`host-plugin/`, deployed by
 * `install-host-plugin.mjs`). That keeps ONE price source — `prices.json` —
 * which is why an absent projection renders no money at all instead of a wrong
 * number.
 *
 * Usage:
 *   node apply-cost-pill.mjs            # patch every discovered bundle copy
 *   node apply-cost-pill.mjs --dry-run  # report only, write nothing
 *   node apply-cost-pill.mjs --revert   # restore the .cost-pill.orig backups
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'dsh-cost-pill';
const BACKUP_SUFFIX = '.cost-pill.orig';
const DRY_RUN = process.argv.includes('--dry-run');
const REVERT = process.argv.includes('--revert');

const CHAT = '@deepseek-ai/dsh-client-ui-chat';
const WORKSPACE = '@deepseek-ai/dsh-client-ui-workspace';

/* ----------------------------------------------------------- bundle lookup */

/** Candidate node_modules roots that can hold the client bundles. */
const ROOTS = [
	join(homedir(), '.local/lib/node_modules/@deepseek-ai/dsh/node_modules'),
	join(homedir(), '.local/lib/node_modules'),
	join(homedir(), '.dsh/profiles/node_modules'),
	join(homedir(), '.dsh/profiles/web/node_modules'),
];

/**
 * Recursively collect `<root>[/...]/@deepseek-ai/<package>/lib/client.js`,
 * descending only through `node_modules` / `@deepseek-ai` levels.
 */
function scan(root, packageName, depth = 0, found = []) {
	if (depth > 5) return found;
	for (const candidate of [join(root, packageName, 'lib', 'client.js'), join(root, '@deepseek-ai', packageName, 'lib', 'client.js')]) {
		if (existsSync(candidate)) found.push(candidate);
	}
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		if (entry.name !== 'node_modules' && entry.name !== '@deepseek-ai') continue;
		scan(join(root, entry.name), packageName, depth + 1, found);
	}
	return found;
}

/** Every real bundle file to patch, with the patcher that owns it. */
function targets() {
	const found = [];
	const seen = new Set();
	for (const [packageName, patch] of [
		[CHAT, patchChat],
		[WORKSPACE, patchWorkspace],
	]) {
		for (const root of ROOTS) {
			for (const candidate of scan(root, packageName)) {
				let key;
				try {
					key = realpathSync(candidate);
				} catch {
					continue;
				}
				if (seen.has(key)) continue;
				seen.add(key);
				found.push({ path: key, packageName, patch });
			}
		}
	}
	return found;
}

/* --------------------------------------------------------- edit primitives */

/** Leading whitespace of one line. */
function indentOf(line) {
	return /^[\t ]*/.exec(line)[0];
}

/** Prefix every non-empty line with `indent`. */
function indentLines(lines, indent) {
	return lines.map((line) => (line.length === 0 ? line : indent + line));
}

/** Index of the single line containing `needle`, or throw. */
function uniqueLine(lines, needle, label) {
	const hits = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index].includes(needle)) hits.push(index);
	}
	if (hits.length !== 1) {
		throw new Error(`${label}: expected 1 line containing ${JSON.stringify(needle)}, found ${hits.length}`);
	}
	return hits[0];
}

/** Index of the first line after `from` whose trimmed text is `closer`. */
function closeLine(lines, from, closer, label) {
	for (let index = from + 1; index < lines.length; index += 1) {
		if (lines[index].trim() === closer) return index;
	}
	throw new Error(`${label}: closing ${JSON.stringify(closer)} not found`);
}

/** Apply queued edits (replace wins over insert) bottom-up. */
function applyEdits(lines, edits) {
	edits.sort((a, b) => b.index - a.index);
	for (const edit of edits) {
		if (edit.replace !== undefined) lines.splice(edit.index, 1, ...edit.replace);
		else lines.splice(edit.index, 0, ...edit.lines);
	}
	return lines.join('\n');
}

/* ============================================================ chat bundle */

const CHAT_PRICING = [
	'//#region dsh-cost-pill/pricing',
	'/**',
	' * Money helpers over the host `cost` projection. The host owns the price',
	' * table and ships it inside the projection view, so nothing here prices',
	' * tokens on its own — an absent projection means no cost surface at all.',
	' */',
	'/** Money text with precision scaled to the amount. */',
	'function costPillFormat(value, currency) {',
	'\tif (!Number.isFinite(value)) return "—";',
	'\tconst digits = value >= 1 ? 2 : value >= 0.1 ? 3 : 4;',
	'\treturn currency + value.toFixed(digits);',
	'}',
	'/** The `provider/model` key of one Turn usage route, when known. */',
	'function costPillRouteKey(route) {',
	'\treturn route === void 0 || route === null ? void 0 : route.provider + "/" + route.model;',
	'}',
	'/** Host rate row for one `provider/model` key: the model row, else the fallback row. */',
	'function costPillRate(cost, routeKey) {',
	'\tif (cost === void 0) return void 0;',
	'\tif (routeKey !== void 0) {',
	'\t\tconst row = cost.models?.[routeKey];',
	'\t\tif (row !== void 0) return row;',
	'\t}',
	'\treturn cost.rates;',
	'}',
	'/** Money for one token-bucket reading under one host rate row. */',
	'function costPillOfUsage(usage, rate) {',
	'\tif (usage === void 0 || usage === null || rate === void 0) return 0;',
	'\tconst buckets = usage.totals ?? usage;',
	'\tconst perToken = 1e-6;',
	'\treturn ((buckets.uncachedInputTokens ?? 0) * rate.cacheMiss',
	'\t\t+ (buckets.cacheReadTokens ?? 0) * rate.cacheHit',
	'\t\t+ (buckets.cacheWriteTokens ?? 0) * (rate.cacheWrite ?? rate.cacheMiss)',
	'\t\t+ (buckets.outputTokens ?? 0) * rate.output) * perToken;',
	'}',
	'/** Money split of one whole-Session `cost` view: re-reads, new input, output. */',
	'function costPillSplit(cost) {',
	'\tconst split = { reread: 0, newInput: 0, output: 0 };',
	'\tif (cost === void 0) return split;',
	'\tconst perToken = 1e-6;',
	'\tfor (const row of cost.routes ?? []) {',
	'\t\tconst rate = costPillRate(cost, row.route);',
	'\t\tif (rate === void 0) continue;',
	'\t\tsplit.reread += (row.buckets.cacheHit ?? 0) * rate.cacheHit * perToken;',
	'\t\tsplit.newInput += ((row.buckets.cacheMiss ?? 0) * rate.cacheMiss + (row.buckets.cacheWrite ?? 0) * (rate.cacheWrite ?? rate.cacheMiss)) * perToken;',
	'\t\tsplit.output += (row.buckets.output ?? 0) * rate.output * perToken;',
	'\t}',
	'\treturn split;',
	'}',
	'/** Rate summary (cache hit / miss / output) for the pricing dialog. */',
	'function costPillRateLabel(rate, currency) {',
	'\treturn rate === void 0 ? "—" : rate.cacheHit + " / " + rate.cacheMiss + " / " + rate.output + " " + currency;',
	'}',
	'/** Most recent billed route in the loaded log, or undefined when none is known. */',
	'function costPillLatestRoute(nodes) {',
	'\tlet route;',
	'\tfor (const node of nodes) {',
	'\t\tconst usage = node.usage ?? node.tokenUsage ?? node.data?.usage ?? node.data?.tokenUsage;',
	'\t\tconst routes = usage?.routes;',
	'\t\tif (Array.isArray(routes) && routes.length > 0) route = routes[routes.length - 1];',
	'\t}',
	'\treturn route;',
	'}',
	'/** Coin mark for the cost pill — theme-aware, no new icon dependency. */',
	'function CostPillIcon() {',
	'\treturn (0, react_jsx_runtime.jsxs)("svg", {',
	'\t\tviewBox: "0 0 16 16",',
	'\t\twidth: "14",',
	'\t\theight: "14",',
	'\t\t"aria-hidden": true,',
	'\t\tchildren: [(0, react_jsx_runtime.jsx)("circle", {',
	'\t\t\tcx: "8",',
	'\t\t\tcy: "8",',
	'\t\t\tr: "5.75",',
	'\t\t\tfill: "none",',
	'\t\t\tstroke: "currentColor",',
	'\t\t\tstrokeWidth: "1.3"',
	'\t\t}), (0, react_jsx_runtime.jsx)("path", {',
	'\t\t\td: "M8 4.4v7.2M9.9 5.9c-.4-.5-1.1-.8-1.9-.8-1 0-1.8.5-1.8 1.3 0 .9.8 1.2 1.8 1.4 1 .2 1.9.5 1.9 1.4 0 .8-.9 1.3-1.9 1.3-.9 0-1.6-.3-2-.9",',
	'\t\t\tfill: "none",',
	'\t\t\tstroke: "currentColor",',
	'\t\t\tstrokeWidth: "1.2",',
	'\t\t\tstrokeLinecap: "round"',
	'\t\t})]',
	'\t});',
	'}',
	'//#endregion',
];

const CHAT_COMPONENT = [
	'/**',
	' * Session cost pill with a click-open pricing dialog. Every figure comes from',
	' * the host `cost` projection view: money, currency, rates and the per-route',
	' * breakdown, all priced host-side.',
	' */',
	'function CostPill({ cost, routeKey, t }) {',
	'\tconst { open, setOpen, rootRef, panelRef, pos } = useStatDialog();',
	'\tconst totalText = costPillFormat(cost.total, cost.currency);',
	'\tconst rate = costPillRate(cost, routeKey);',
	'\tconst split = costPillSplit(cost);',
	'\treturn (0, react_jsx_runtime.jsxs)("span", {',
	'\t\tref: rootRef,',
	'\t\tclassName: StatsPills_module_css_default.anchor,',
	'\t\tchildren: [(0, react_jsx_runtime.jsxs)("button", {',
	'\t\t\ttype: "button",',
	'\t\t\tclassName: StatsPills_module_css_default.pill,',
	'\t\t\t"aria-haspopup": "dialog",',
	'\t\t\t"aria-expanded": open,',
	'\t\t\t"aria-label": t("stats.dialog.costTitle"),',
	'\t\t\tonClick: () => {',
	'\t\t\t\tsetOpen(!open);',
	'\t\t\t},',
	'\t\t\tchildren: [(0, react_jsx_runtime.jsx)(CostPillIcon, {}), (0, react_jsx_runtime.jsx)("span", {',
	'\t\t\t\tclassName: StatsPills_module_css_default.label,',
	'\t\t\t\tchildren: t("stats.cost", { cost: totalText })',
	'\t\t\t})]',
	'\t\t}), open && (0, react_dom.createPortal)((0, react_jsx_runtime.jsxs)("div", {',
	'\t\t\tref: panelRef,',
	'\t\t\tclassName: stat_dialog_module_css_default.panel,',
	'\t\t\trole: "dialog",',
	'\t\t\t"aria-label": t("stats.dialog.costTitle"),',
	'\t\t\tstyle: pos ?? MEASURE_STYLE,',
	'\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("div", {',
	'\t\t\t\tclassName: stat_dialog_module_css_default.title,',
	'\t\t\t\tchildren: [(0, react_jsx_runtime.jsxs)("span", {',
	'\t\t\t\t\tclassName: stat_dialog_module_css_default.titleLabel,',
	'\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(CostPillIcon, {}), t("stats.dialog.costTitle")]',
	'\t\t\t\t}), (0, react_jsx_runtime.jsx)("span", {',
	'\t\t\t\t\tclassName: stat_dialog_module_css_default.titleValue,',
	'\t\t\t\t\tchildren: totalText',
	'\t\t\t\t})]',
	'\t\t\t}), (0, react_jsx_runtime.jsx)("div", {',
	'\t\t\t\tclassName: stat_dialog_module_css_default.titleRule,',
	'\t\t\t\t"aria-hidden": true',
	'\t\t\t}), (0, react_jsx_runtime.jsxs)("dl", {',
	'\t\t\t\tclassName: stat_dialog_module_css_default.details,',
	'\t\t\t\t"data-session-cost": true,',
	'\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.costModel") }), (0, react_jsx_runtime.jsx)("dd", {',
	'\t\t\t\t\tclassName: stat_dialog_module_css_default.route,',
	'\t\t\t\t\tchildren: routeKey === void 0 ? t("stats.dialog.costDefault") : routeKey',
	'\t\t\t\t}), (0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.costRate") }), (0, react_jsx_runtime.jsx)("dd", {',
	'\t\t\t\t\tchildren: costPillRateLabel(rate, cost.currency)',
	'\t\t\t\t}), (0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.costReread") }), (0, react_jsx_runtime.jsx)("dd", {',
	'\t\t\t\t\tchildren: costPillFormat(split.reread, cost.currency)',
	'\t\t\t\t}), (0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.costNewInput") }), (0, react_jsx_runtime.jsx)("dd", {',
	'\t\t\t\t\tchildren: costPillFormat(split.newInput, cost.currency)',
	'\t\t\t\t}), (0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.costOutput") }), (0, react_jsx_runtime.jsx)("dd", {',
	'\t\t\t\t\tchildren: costPillFormat(split.output, cost.currency)',
	'\t\t\t\t})]',
	'\t\t\t})]',
	'\t\t}), document.body)]',
	'\t});',
	'}',
];

const CHAT_LOCALE_EN = [
	'"stats.cost": "≈ {cost}",',
	'"stats.dialog.costTitle": "Estimated cost",',
	'"stats.dialog.costModel": "Priced as",',
	'"stats.dialog.costDefault": "default rate",',
	'"stats.dialog.costRate": "Rate /1M (hit/miss/out)",',
	'"stats.dialog.costReread": "Cache-hit re-reads",',
	'"stats.dialog.costNewInput": "New input (cache miss)",',
	'"stats.dialog.costOutput": "Output",',
	'"message.turnUsage.cost": "Est. cost",',
];

const CHAT_LOCALE_ZH = [
	'"stats.cost": "≈ {cost}",',
	'"stats.dialog.costTitle": "预估费用",',
	'"stats.dialog.costModel": "计价模型",',
	'"stats.dialog.costDefault": "默认价目",',
	'"stats.dialog.costRate": "单价 /1M（命中/未命中/输出）",',
	'"stats.dialog.costReread": "缓存命中重读",',
	'"stats.dialog.costNewInput": "新增输入（未命中）",',
	'"stats.dialog.costOutput": "输出",',
	'"message.turnUsage.cost": "预估费用",',
];

/** Patch the chat bundle: composer pill, session dialog, per-Turn cost row. */
function patchChat(source) {
	const lines = source.split('\n');
	const edits = [];

	// 1. Money helpers, ahead of the StatsPills region.
	const statsRegion = uniqueLine(lines, '//#region lib/types/client/chat/StatsPills.js', 'stats region');
	edits.push({ index: statsRegion, lines: indentLines(CHAT_PRICING, indentOf(lines[statsRegion])) });

	// 2. The pill component, just before StatsPills itself.
	const statsPills = uniqueLine(lines, 'const StatsPills = (0, react.memo)(function StatsPills', 'StatsPills');
	edits.push({ index: statsPills, lines: indentLines(CHAT_COMPONENT, indentOf(lines[statsPills])) });

	// 3. The pill reads the host projection, and prices itself with the newest route.
	const statsFold = uniqueLine(lines, 'const stats = (0, react.useMemo)(() => projected ?? deriveStats', 'stats fold');
	const foldIndent = indentOf(lines[statsFold]);
	edits.push({
		index: statsFold + 1,
		lines: [
			`${foldIndent}const cost = useProjection("cost");`,
			`${foldIndent}const costRoute = (0, react.useMemo)(() => costPillLatestRoute(settledNodes), [settledNodes]);`,
		],
	});

	// 4. Append the cost pill to the composer dock pill row.
	const usagePill = uniqueLine(lines, 'hasTokens && (0, react_jsx_runtime.jsx)(UsagePill, {', 'usage pill');
	const arrayClose = closeLine(lines, usagePill, '})]', 'composer dock pill row');
	const pillIndent = indentOf(lines[arrayClose]);
	const tailIndent = `${pillIndent}\t`;
	edits.push({
		index: arrayClose,
		replace: [
			`${pillIndent}}), hasTokens && cost !== void 0 && (0, react_jsx_runtime.jsx)(CostPill, {`,
			`${tailIndent}cost,`,
			`${tailIndent}routeKey: costPillRouteKey(costRoute),`,
			`${tailIndent}t`,
			`${pillIndent}})]`,
		],
	});

	// 5. The per-Turn dialog prices its own buckets with the host rates.
	const turnPanel = uniqueLine(lines, 'function TurnUsagePanel({ usage, t }) {', 'TurnUsagePanel');
	edits.push({
		index: turnPanel,
		replace: [`${indentOf(lines[turnPanel])}function TurnUsagePanel({ usage, cost, t }) {`],
	});
	let turnRoutes = -1;
	for (let index = turnPanel + 1; index < lines.length; index += 1) {
		if (lines[index].includes('const routes = usage.routes?.map(')) {
			turnRoutes = index;
			break;
		}
	}
	if (turnRoutes === -1) throw new Error('TurnUsagePanel: route fold not found');
	const turnIndent = `${indentOf(lines[turnPanel])}\t`;
	edits.push({
		index: turnRoutes + 1,
		lines: [`${turnIndent}const costRate = costPillRate(cost, costPillRouteKey(usage.routes?.[0]));`],
	});
	let turnOutput = -1;
	for (let index = turnRoutes + 1; index < lines.length; index += 1) {
		if (lines[index].includes('(0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.output") })')) {
			turnOutput = index;
			break;
		}
	}
	if (turnOutput === -1) throw new Error('TurnUsagePanel: output row not found');
	let outputClose = -1;
	for (let index = turnOutput + 1; index < lines.length; index += 1) {
		// The output `dd` closes with its optional reasoning span on the same line.
		if (lines[index].trimEnd().endsWith('})] })')) {
			outputClose = index;
			break;
		}
	}
	if (outputClose === -1) throw new Error('turn usage details: output row end not found');
	if (!lines.slice(turnOutput, outputClose).some((line) => line.includes('stat_dialog_module_css_default.reasoning'))) {
		throw new Error('turn usage details: output row end does not carry the reasoning span');
	}
	// The output row's `dd` is the array's last element: give it the comma the
	// new rows need, or the parser reads the following `(...)` as a call.
	const rowIndent = indentOf(lines[turnOutput]);
	const outputEnd = lines[outputClose].trimEnd().endsWith(',') ? lines[outputClose] : `${lines[outputClose]},`;
	edits.push({
		index: outputClose,
		replace: [
			outputEnd,
			`${rowIndent}cost !== void 0 && (0, react_jsx_runtime.jsx)("dt", { children: t("message.turnUsage.cost") }),`,
			`${rowIndent}cost !== void 0 && (0, react_jsx_runtime.jsx)("dd", { children: costPillFormat(costPillOfUsage(usage, costRate), cost.currency) }),`,
		],
	});

	// 6. The Turn tail hands the projection to that dialog.
	const turnTail = uniqueLine(lines, 'const TurnTailNodeView = (0, react.memo)(function TurnTailNodeView({', 'TurnTailNodeView');
	edits.push({
		index: turnTail,
		replace: [
			lines[turnTail].replace(
				'renderSlotChain, t, useChat }) {',
				'renderSlotChain, t, useChat, useProjection }) {',
			),
		],
	});
	edits.push({
		index: turnTail + 1,
		lines: [`${indentOf(lines[turnTail])}\tconst cost = useProjection === void 0 ? void 0 : useProjection("cost");`],
	});
	const usageCall = uniqueLine(lines, 'usage: data.tokenUsage,', 'turn usage call');
	edits.push({ index: usageCall + 1, lines: [`${indentOf(lines[usageCall])}cost,`] });

	// 7. Locale keys, English and Chinese dictionaries.
	for (const [needle, keys, label] of [
		['"stats.cacheHit": "Cache hit {percent}%",', CHAT_LOCALE_EN, 'en dictionary'],
		['"stats.cacheHit": "缓存命中 {percent}%",', CHAT_LOCALE_ZH, 'zh dictionary'],
	]) {
		const anchor = uniqueLine(lines, needle, label);
		edits.push({ index: anchor + 1, lines: indentLines(keys, indentOf(lines[anchor])) });
	}

	return applyEdits(lines, edits);
}

/* ======================================================= workspace bundle */

const WORKSPACE_COST = [
	'//#region dsh-cost-pill/project-cost',
	'/**',
	' * Per-project money, read from the host `cost` projection the Session list',
	' * already carries (one `projectionValues` block per row). Nothing is priced',
	' * here: the rates ride the projection, so the host price table stays the only',
	' * one. A Session whose `cost` row is missing — never folded since the plugin',
	' * was mounted — falls back to its `tokenUsage` buckets priced with the rates',
	' * of a Session that does have one, and the badge is marked `≈`.',
	' */',
	'/** Money text with precision scaled to the amount. */',
	'function projectCostMoney(value, currency) {',
	'\tif (!Number.isFinite(value)) return "—";',
	'\tconst digits = value >= 1 ? 2 : value >= 0.1 ? 3 : 4;',
	'\treturn currency + value.toFixed(digits);',
	'}',
	'/** The rate row for a Session priced from its own buckets instead of the host view. */',
	'function projectCostRate(cost) {',
	'\tif (cost === void 0) return void 0;',
	'\tconst keys = Object.keys(cost.models ?? {});',
	'\treturn keys.length === 1 ? cost.models[keys[0]] : cost.rates;',
	'}',
	'/** Money for one flat `tokenUsage` reading under one rate row. */',
	'function projectCostOfBuckets(buckets, rate) {',
	'\tif (buckets === void 0 || rate === void 0) return 0;',
	'\tconst perToken = 1e-6;',
	'\treturn ((buckets.uncachedInputTokens ?? 0) * rate.cacheMiss',
	'\t\t+ (buckets.cacheReadTokens ?? 0) * rate.cacheHit',
	'\t\t+ (buckets.cacheWriteTokens ?? 0) * (rate.cacheWrite ?? rate.cacheMiss)',
	'\t\t+ (buckets.outputTokens ?? 0) * rate.output) * perToken;',
	'}',
	'/**',
	' * Sum one Workspace\'s money over EVERY listed Session (subagent-origin rows',
	' * included: they spend real money in the same project and are only hidden from',
	' * the visible list), archived Sessions excluded.',
	' * @returns group key ("" for ungrouped) → {total, sessions, complete, currency}.',
	' */',
	'function deriveProjectCosts(list, workspaces, archived) {',
	'\tlet reference;',
	'\tfor (const id of list.ids) {',
	'\t\tconst entry = list.byId[id];',
	'\t\tif (entry === void 0 || archived.has(id)) continue;',
	'\t\tconst cost = entry.projectionValues?.cost;',
	'\t\tif (cost !== void 0 && reference === void 0) reference = cost;',
	'\t}',
	'\tconst costs = /* @__PURE__ */ new Map();',
	'\tfor (const id of list.ids) {',
	'\t\tconst entry = list.byId[id];',
	'\t\tif (entry === void 0 || archived.has(id)) continue;',
	'\t\tconst values = entry.projectionValues;',
	'\t\tif (values === void 0) continue;',
	'\t\tconst cost = values.cost;',
	'\t\tlet total;',
	'\t\tlet complete = true;',
	'\t\tif (cost !== void 0) total = cost.total;',
	'\t\telse if (reference !== void 0 && values.tokenUsage !== void 0) {',
	'\t\t\ttotal = projectCostOfBuckets(values.tokenUsage, projectCostRate(reference));',
	'\t\t\tcomplete = false;',
	'\t\t}',
	'\t\telse continue;',
	'\t\tif (total <= 0) continue;',
	'\t\tconst key = owningGroupKey(workspaces, id);',
	'\t\tconst row = costs.get(key) ?? { total: 0, sessions: 0, complete: true, currency: (cost ?? reference).currency };',
	'\t\trow.total += total;',
	'\t\trow.sessions += 1;',
	'\t\trow.complete = row.complete && complete;',
	'\t\tcosts.set(key, row);',
	'\t}',
	'\treturn costs;',
	'}',
	'//#endregion',
];

const WORKSPACE_LOCALE_EN = ['"cost.title": "Project cost; ≈ marks a total that is not complete yet",'];
const WORKSPACE_LOCALE_ZH = ['"cost.title": "项目费用；≈ 表示合计尚不完整",'];

/** Patch the workspace bundle: one money badge per project row. */
function patchWorkspace(source) {
	const lines = source.split('\n');
	const edits = [];

	// 1. The money helpers, ahead of the group derivation they feed.
	const deriveGroups = uniqueLine(lines, 'function deriveGroups(list, workspaces, archivedSessionIds, pendingInteractions, view) {', 'deriveGroups');
	edits.push({ index: deriveGroups, lines: indentLines(WORKSPACE_COST, indentOf(lines[deriveGroups])) });

	// 2. Fold the costs once per derivation, then hang them on each group node.
	const archivedLine = closeLine(lines, deriveGroups, 'const archived = new Set(archivedSessionIds);', 'deriveGroups archived set');
	edits.push({
		index: archivedLine + 1,
		lines: [`${indentOf(lines[archivedLine])}const projectCosts = deriveProjectCosts(list, workspaces, archived);`],
	});
	const groupPush = uniqueLine(lines, 'sessions: expanded ? g.sessions.map', 'group node');
	edits.push({
		index: groupPush,
		replace: [`${indentOf(lines[groupPush])}cost: projectCosts.get(g.key),`, lines[groupPush]],
	});

	// 3. The badge, right after the project name.
	const projectText = uniqueLine(lines, 'className: Rows_module_css_default.projectText', 'project text');
	const projectTextClose = closeLine(lines, projectText, '}),', 'project text close');
	const badgeIndent = indentOf(lines[projectTextClose]);
	edits.push({
		index: projectTextClose,
		replace: [
			lines[projectTextClose],
			`${badgeIndent}group.cost !== void 0 && (0, react_jsx_runtime.jsx)("span", {`,
			`${badgeIndent}\tclassName: Rows_module_css_default.meta,`,
			`${badgeIndent}\tstyle: {`,
			`${badgeIndent}\t\tmarginLeft: "auto",`,
			`${badgeIndent}\t\tflex: "none",`,
			`${badgeIndent}\t\twhiteSpace: "nowrap",`,
			`${badgeIndent}\t\tfontVariantNumeric: "tabular-nums"`,
			`${badgeIndent}\t},`,
			`${badgeIndent}\ttitle: t("cost.title"),`,
			`${badgeIndent}\tchildren: (group.cost.complete ? "" : "≈ ") + projectCostMoney(group.cost.total, group.cost.currency)`,
			`${badgeIndent}}),`,
		],
	});

	// 4. Locale keys for the badge tooltip.
	for (const [needle, keys, label] of [
		['"group.ungrouped": "Ungrouped",', WORKSPACE_LOCALE_EN, 'en dictionary'],
		['"group.ungrouped": "未分组",', WORKSPACE_LOCALE_ZH, 'zh dictionary'],
	]) {
		const anchor = uniqueLine(lines, needle, label);
		edits.push({ index: anchor + 1, lines: indentLines(keys, indentOf(lines[anchor])) });
	}

	return applyEdits(lines, edits);
}

/* ------------------------------------------------------------------- main */

const found = targets();
if (found.length === 0) {
	console.error('no @deepseek-ai/dsh-client-ui-chat / dsh-client-ui-workspace client bundle found; is dsh installed?');
	process.exit(1);
}

let failures = 0;
for (const target of found) {
	const label = target.path.replace(homedir(), '~');
	try {
		if (REVERT) {
			const backup = target.path + BACKUP_SUFFIX;
			if (!existsSync(backup)) {
				console.log(`skip    ${label} (no ${BACKUP_SUFFIX} backup)`);
				continue;
			}
			if (!DRY_RUN) copyFileSync(backup, target.path);
			console.log(`revert  ${label}`);
			continue;
		}
		const source = readFileSync(target.path, 'utf8');
		if (source.includes(MARKER)) {
			console.log(`skip    ${label} (already patched)`);
			continue;
		}
		const patched = target.patch(source);
		if (DRY_RUN) {
			console.log(`dry-run ${label} (+${String(patched.length - source.length)} bytes)`);
			continue;
		}
		const backup = target.path + BACKUP_SUFFIX;
		if (!existsSync(backup)) copyFileSync(target.path, backup);
		writeFileSync(target.path, patched);
		execFileSync(process.execPath, ['--check', target.path], { stdio: 'pipe' });
		console.log(`patched ${label} (backup: ${label}${BACKUP_SUFFIX})`);
	} catch (error) {
		failures += 1;
		console.error(`FAILED  ${label}: ${error.message}`);
	}
}

console.log(`\n${String(found.length)} bundle(s) discovered — prices come from the host projection (prices.json)`);
if (!REVERT && !DRY_RUN) {
	console.log('reload the GUI page; restart `dsh web` if the surfaces do not appear.');
}
process.exit(failures === 0 ? 0 : 1);
