/**
 * dsh-cost-projection — the `cost` session projection.
 *
 * DSH meters provider-reported tokens (`tokenUsage`) but carries no money
 * anywhere: this unit is the single host-side source of truth for what those
 * tokens cost. It folds every SETTLED `assistant/message` usage sample — the
 * billed attempt, not the transient `assistant/attempt` stream samples — into
 * per-route token buckets, and its client view prices them with the table in
 * `prices.json`.
 *
 * Design facts worth knowing before changing it:
 *
 * - Money lives in the VIEW, tokens in the STATE. Projection state is persisted
 *   JSON (`stateVersion` invalidates it on shape changes), so a rate change must
 *   never require re-folding a log; changing prices.json only needs a reload.
 * - Settled-only is the invoice-validated fold: summing `assistant/message`
 *   usages reproduced the DeepSeek dashboard to 100.04 % of tokens
 *   (`audit-usage.mjs`).
 * - A fork's log starts with the inherited parent prefix. Those events were
 *   already billed in the parent Session, so this unit skips everything before
 *   `inheritedEventCount` — a project total must not count them twice.
 * - The view reuses its object reference per state (`Object.is` stability is a
 *   registry contract: a new object per call would publish a change on every
 *   event).
 *
 * @module dsh-cost-projection
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'cost-projection';

/** The projection registry this unit registers into. */
export const inject = ['sessionProjections'];

/** Fallback rates (USD per million tokens) when the price file is unavailable. */
const DEFAULT_PRICES = {
	currency: '$',
	fallback: { cacheHit: 0.0058, cacheMiss: 0.0581, cacheWrite: 0.0581, output: 0.0872 },
	models: {},
};

/** Token buckets carried by the fold state (plain non-negative integers). */
const bucketsSchema = z
	.object({
		cacheMiss: z.number().int().nonnegative(),
		cacheHit: z.number().int().nonnegative(),
		cacheWrite: z.number().int().nonnegative(),
		output: z.number().int().nonnegative(),
	})
	.strict();

/** One route's price row, in the table's currency per million tokens. */
const rateSchema = z
	.object({
		cacheHit: z.number().nonnegative(),
		cacheMiss: z.number().nonnegative(),
		cacheWrite: z.number().nonnegative(),
		output: z.number().nonnegative(),
	})
	.strict();

const stateSchema = z
	.object({
		/** Events of the inherited fork prefix to skip (already billed upstream). */
		inherited: z.number().int().nonnegative(),
		/** Whole-log buckets across every counted attempt. */
		totals: bucketsSchema,
		/** Buckets per `provider/model` route, in first-seen order. */
		routes: z.record(z.string(), bucketsSchema),
	})
	.strict();

const viewSchema = z
	.object({
		currency: z.string().min(1),
		/** Priced-route table the client uses for its own per-Turn buckets. */
		models: z.record(z.string(), rateSchema),
		/** Fallback row for a route the table does not name. */
		rates: rateSchema,
		/** Whole-Session money. */
		total: z.number().nonnegative(),
		/** Whole-Session buckets, so a reader never re-derives them. */
		buckets: bucketsSchema,
		/** Per-route money, dearest first — the cost breakdown. */
		routes: z.array(
			z
				.object({
					route: z.string(),
					buckets: bucketsSchema,
					cost: z.number().nonnegative(),
				})
				.strict(),
		),
	})
	.strict();

/** The zero bucket row. */
function zeroBuckets() {
	return { cacheMiss: 0, cacheHit: 0, cacheWrite: 0, output: 0 };
}

/** Money for one bucket row under one rate row. */
function priceBuckets(buckets, rate) {
	return (
		(buckets.cacheMiss * rate.cacheMiss +
			buckets.cacheHit * rate.cacheHit +
			buckets.cacheWrite * (rate.cacheWrite ?? rate.cacheMiss) +
			buckets.output * rate.output) /
		1e6
	);
}

/** Normalize one rate row, falling back per missing/invalid field. */
function normalizeRate(raw, fallback) {
	const pick = (field) => (typeof raw?.[field] === 'number' && Number.isFinite(raw[field]) && raw[field] >= 0 ? raw[field] : fallback[field]);
	return {
		cacheHit: pick('cacheHit'),
		cacheMiss: pick('cacheMiss'),
		cacheWrite: pick('cacheWrite'),
		output: pick('output'),
	};
}

/**
 * Read and normalize the price table. A missing or malformed file never fails
 * the boot: the built-in fallback row keeps the projection serving money.
 * @param pricesPath - configured path, or undefined for the built-in table.
 * @returns the currency, the fallback rate row, and the per-route rows.
 */
function loadPrices(pricesPath) {
	if (typeof pricesPath !== 'string' || pricesPath === '') return DEFAULT_PRICES;
	let raw;
	try {
		raw = JSON.parse(readFileSync(pricesPath, 'utf8'));
	} catch (error) {
		console.warn(`cost-projection: cannot read prices at ${pricesPath} (${String(error)}); using the built-in fallback rates`);
		return DEFAULT_PRICES;
	}
	const fallback = normalizeRate(raw?.fallback, DEFAULT_PRICES.fallback);
	const models = {};
	for (const [key, row] of Object.entries(raw?.models ?? {})) {
		models[key] = normalizeRate(row, fallback);
	}
	return {
		currency: typeof raw?.currency === 'string' && raw.currency !== '' ? raw.currency : DEFAULT_PRICES.currency,
		fallback,
		models,
	};
}

/**
 * Register the `cost` unit.
 * @param ctx - plugin context carrying the projection registry.
 * @param config - row config; `pricesPath` names the price table.
 */
export function apply(ctx, config) {
	const prices = loadPrices(config?.pricesPath);
	const viewCache = new WeakMap();

	/** View for one state, cached by state identity for `Object.is` stability. */
	function viewOf(state) {
		let view = viewCache.get(state);
		if (view === undefined) {
			const routes = Object.entries(state.routes)
				.map(([route, buckets]) => ({
					route,
					buckets,
					cost: priceBuckets(buckets, prices.models[route] ?? prices.fallback),
				}))
				.sort((left, right) => right.cost - left.cost);
			view = {
				currency: prices.currency,
				models: prices.models,
				rates: prices.fallback,
				total: routes.reduce((sum, row) => sum + row.cost, 0),
				buckets: state.totals,
				routes,
			};
			viewCache.set(state, view);
		}
		return view;
	}

	ctx.sessionProjections.register({
		key: 'cost',
		stateVersion: 1,
		stateSchema,
		init: (_header, inheritedEventCount) => ({
			inherited: inheritedEventCount,
			totals: zeroBuckets(),
			routes: {},
		}),
		apply: (state, event) => {
			if (event.type !== 'assistant/message') return state;
			const usage = event.data?.usage;
			if (usage === undefined) return state;
			// The fork prefix was billed in the parent Session: never count it here.
			if (event.seq < state.inherited) return state;
			const source = event.data?.message?.source;
			const route = source?.provider === undefined || source?.model === undefined ? 'unknown' : `${source.provider}/${source.model}`;
			const delta = {
				cacheMiss: usage.inputTokens ?? 0,
				cacheHit: usage.cacheReadTokens ?? 0,
				cacheWrite: usage.cacheWriteTokens ?? 0,
				output: usage.outputTokens ?? 0,
			};
			const previous = state.routes[route] ?? zeroBuckets();
			return {
				inherited: state.inherited,
				totals: {
					cacheMiss: state.totals.cacheMiss + delta.cacheMiss,
					cacheHit: state.totals.cacheHit + delta.cacheHit,
					cacheWrite: state.totals.cacheWrite + delta.cacheWrite,
					output: state.totals.output + delta.output,
				},
				routes: {
					...state.routes,
					[route]: {
						cacheMiss: previous.cacheMiss + delta.cacheMiss,
						cacheHit: previous.cacheHit + delta.cacheHit,
						cacheWrite: previous.cacheWrite + delta.cacheWrite,
						output: previous.output + delta.output,
					},
				},
			};
		},
		wire: {
			viewSchema,
			view: viewOf,
		},
	});
}
