#!/usr/bin/env node
/**
 * pricing.mjs — one definition of the money formula, shared by the audits.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));

/** The price table (USD, or whatever `currency` says, per million tokens). */
export function loadPrices() {
	return JSON.parse(readFileSync(join(HERE, 'prices.json'), 'utf8'));
}

/**
 * Money for one token-bucket reading under one route.
 * @param prices - the loaded price table.
 * @param key - `provider/model`, or undefined for the fallback row.
 * @param buckets - `{cacheMiss, cacheHit, cacheWrite, output}` token counts.
 * @returns money in the table's currency.
 */
export function costOf(prices, key, buckets) {
	const rate = (key !== undefined && prices.models[key]) || prices.fallback;
	return (
		(buckets.cacheMiss * rate.cacheMiss +
			buckets.cacheHit * rate.cacheHit +
			buckets.cacheWrite * (rate.cacheWrite ?? rate.cacheMiss) +
			buckets.output * rate.output) /
		1e6
	);
}

/** Money text with precision scaled to the amount. */
export function money(prices, value) {
	return `${prices.currency ?? '$'}${value.toFixed(value >= 1 ? 2 : 4)}`;
}

/** Grouped integer. */
export function count(value) {
	return value.toLocaleString('en-US');
}
