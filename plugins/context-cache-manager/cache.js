/**
 * Cache arithmetic and the hot/warm/cold estimate, as pure functions.
 *
 * # What this module refuses to do
 *
 * It never invents a cache. There is no KV cache here, no prefix bookkeeping
 * that would let the manager claim a hit the provider did not charge for, and
 * no estimated token count presented as a measured one. Every number is either
 * a counter the adapter reported or an arithmetic combination of counters the
 * adapter reported; when the counters are absent the answer is `available:
 * false` and a reason, which is a fact about the provider and not an error.
 *
 * That distinction is the whole point. A provider that reports nothing is
 * common — a self-hosted gateway, a mock adapter, an OpenAI-compatible endpoint
 * that drops `prompt_tokens_details` — and a manager that treated "no cache
 * fields" as a failure would make the router's later cache-aware policy
 * impossible to reason about.
 *
 * # The counter semantics this module relies on
 *
 * The harness's `TokenUsage` counts are **disjoint**: `inputTokens` is
 * uncached input only, and cached input is reported separately as
 * `cacheReadTokens` (served from cache) and `cacheWriteTokens` (written to
 * cache). Adapters whose provider folds hits into a prompt total subtract them
 * out. So for one call:
 *
 * ```
 * promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
 * missTokens   = inputTokens
 * hitRatio     = cacheReadTokens / promptTokens
 * ```
 *
 * A write is reported separately rather than folded into the miss count: the
 * harness's own client computes the billed prompt as the sum of the three
 * buckets and the hit share over the same sum, so `missTokens` stays exactly
 * the provider's uncached input (`inputTokens`; DeepSeek's
 * `prompt_cache_miss_tokens` is precisely this value, which its adapter
 * derives by subtracting the read out of `prompt_tokens`).
 *
 * @module newpi-plugin-context-cache-manager/cache
 */

/** The temperature vocabulary, most reusable first. `unknown` means no data. */
export const TEMPERATURES = Object.freeze(['hot', 'warm', 'cold', 'unknown']);

/** The configuration one temperature estimate runs under. */
export const DEFAULT_TEMPERATURE_OPTIONS = Object.freeze({
  /** How many of the most recent calls with cache data to average. */
  window: 20,
  /** At or above this average hit ratio, a fresh route is `hot`. */
  hotRatio: 0.5,
  /** Strictly above this average, and fresh enough, a route is `warm`. */
  warmRatio: 0.05,
  /** How long a `hot` route stays hot without a fresh hit. */
  hotTtlMs: 5 * 60 * 1000,
  /** How long any cache history stays meaningful at all. */
  warmTtlMs: 30 * 60 * 1000,
});

/**
 * Read one optional counter, refusing anything that is not a whole
 * non-negative number.
 *
 * A provider that sends `null`, a string, or a negative number is reporting
 * nothing usable, and `undefined` is the honest representation of that.
 *
 * @param value - the raw counter.
 * @returns the count, or `undefined` when it is not usable.
 */
export function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The reported usage, normalized field by field, with nothing derived.
 *
 * The point of keeping this separate from {@link cacheFromUsage} is that a
 * record can always show exactly what the provider said, next to what the
 * manager computed from it.
 *
 * @param usage - the harness's `TokenUsage`, as the adapter emitted it.
 * @returns a frozen normalized usage, or `null` when there was none.
 */
export function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const normalized = {};
  const input = count(usage.inputTokens);
  const output = count(usage.outputTokens);
  if (input === undefined || output === undefined) {
    // A usage object without both required counters is not usable; the harness
    // contract says they are present, so their absence means an adapter built
    // to a different contract, not a call with no tokens.
    return null;
  }
  normalized.inputTokens = input;
  normalized.outputTokens = output;
  for (const [field, key] of [
    ['totalTokens', 'totalTokens'],
    ['cacheReadTokens', 'cacheReadTokens'],
    ['cacheWriteTokens', 'cacheWriteTokens'],
    ['reasoningTokens', 'reasoningTokens'],
  ]) {
    const value = count(usage[field]);
    if (value !== undefined) normalized[key] = value;
  }
  return Object.freeze(normalized);
}

/**
 * Derive the cache facts of one call from its reported usage.
 *
 * @param usage - the harness's `TokenUsage`, or `null`.
 * @returns a frozen cache summary. `available` is false whenever the provider
 *   reported no cache counter at all.
 */
export function cacheFromUsage(usage) {
  const normalized = normalizeUsage(usage);
  if (normalized === null) {
    return Object.freeze({
      available: false,
      reason: 'the provider reported no token usage for this call',
      hitTokens: null,
      missTokens: null,
      writeTokens: null,
      promptTokens: null,
      hitRatio: null,
    });
  }
  const reported =
    normalized.cacheReadTokens !== undefined || normalized.cacheWriteTokens !== undefined;
  if (!reported) {
    return Object.freeze({
      available: false,
      reason: 'the provider reported usage without cache counters',
      hitTokens: null,
      missTokens: null,
      writeTokens: null,
      promptTokens: null,
      hitRatio: null,
    });
  }
  const input = normalized.inputTokens;
  const hit = normalized.cacheReadTokens ?? 0;
  const write = normalized.cacheWriteTokens ?? 0;
  const prompt = input + hit + write;
  return Object.freeze({
    available: true,
    reason: null,
    hitTokens: hit,
    // The provider's uncached input. Cache writes are reported separately
    // rather than added here, matching the harness's own billed-prompt sum.
    missTokens: input,
    writeTokens: write,
    promptTokens: prompt,
    hitRatio: prompt > 0 ? hit / prompt : null,
  });
}

/**
 * Combine one call's reported usage into a compact, displayable summary.
 *
 * @param usage - the raw `TokenUsage`.
 * @returns `{ usage, cache }`, both possibly `null`/unavailable.
 */
export function summarizeUsage(usage) {
  return Object.freeze({
    usage: normalizeUsage(usage),
    cache: cacheFromUsage(usage),
  });
}

/**
 * Estimate a route's cache temperature from its recent calls.
 *
 * The estimate is deliberately conservative and time-aware: a provider's prompt
 * cache expires, so a hit ratio measured an hour ago says nothing about the
 * next call. Freshness degrades `hot` to `warm` and any history to `cold`,
 * which is the honest default for "I cannot tell you the next call will hit".
 *
 * @param records - per-call records, oldest first, as the journal holds them.
 * @param options - the estimate's thresholds.
 * @param options.now - the clock, for tests.
 * @param options.window - how many recent calls with cache data to average.
 * @param options.hotRatio - the average at or above which a fresh route is hot.
 * @param options.warmRatio - the average strictly above which a fresh route is warm.
 * @param options.hotTtlMs - how long a route stays hot without a fresh hit.
 * @param options.warmTtlMs - how long cache history is meaningful at all.
 * @returns a frozen `{ state, samples, averageHitRatio, lastAt, ageMs, reason }`.
 */
export function estimateTemperature(records, options = {}) {
  const settings = { ...DEFAULT_TEMPERATURE_OPTIONS, ...(options ?? {}) };
  const now = Number.isInteger(settings.now) ? settings.now : Date.now();
  const list = Array.isArray(records) ? records : [];
  const withCache = list.filter(
    (record) => record?.cache?.available === true && typeof record.cache.hitRatio === 'number',
  );
  if (withCache.length === 0) {
    return Object.freeze({
      state: 'unknown',
      samples: 0,
      averageHitRatio: null,
      lastAt: null,
      ageMs: null,
      reason: 'no provider cache counters have been observed for this route',
    });
  }
  const window = Math.max(1, Number.isInteger(settings.window) ? settings.window : 20);
  const recent = withCache.slice(-window);
  const average =
    recent.reduce((total, record) => total + record.cache.hitRatio, 0) / recent.length;
  const lastAt = Number.isInteger(withCache[withCache.length - 1].at)
    ? withCache[withCache.length - 1].at
    : null;
  const ageMs = lastAt === null ? null : Math.max(0, now - lastAt);

  let state;
  let reason;
  if (average >= settings.hotRatio && ageMs !== null && ageMs <= settings.hotTtlMs) {
    state = 'hot';
    reason = `average hit ratio ${average.toFixed(3)} on the last ${recent.length} call(s), last one ${ageMs} ms ago`;
  } else if (average > settings.warmRatio && ageMs !== null && ageMs <= settings.warmTtlMs) {
    state = 'warm';
    reason =
      average >= settings.hotRatio
        ? `the prefix was hitting but the last cacheable call is ${ageMs} ms old`
        : `partial reuse: average hit ratio ${average.toFixed(3)} on the last ${recent.length} call(s)`;
  } else {
    state = 'cold';
    reason =
      average <= settings.warmRatio
        ? `no reuse observed: average hit ratio ${average.toFixed(3)}`
        : `cache history is ${ageMs} ms old`;
  }
  return Object.freeze({
    state,
    samples: recent.length,
    averageHitRatio: average,
    lastAt,
    ageMs,
    reason,
  });
}

/**
 * Group records by route so each `provider/model` gets its own temperature.
 *
 * @param records - per-call records, oldest first.
 * @param options - the estimate's thresholds.
 * @returns a frozen map of `provider/model` to an estimate.
 */
export function temperaturesByRoute(records, options = {}) {
  const groups = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const provider = typeof record?.provider === 'string' ? record.provider : null;
    const model = typeof record?.model === 'string' ? record.model : null;
    if (provider === null || model === null) continue;
    const key = `${provider}/${model}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const estimates = {};
  for (const [key, group] of groups) estimates[key] = estimateTemperature(group, options);
  return Object.freeze(estimates);
}

/** Patterns that turn a diagnostic into a redacted one. */
const REDACTIONS = Object.freeze([
  [/\bsk-[A-Za-z0-9_-]{4,}/g, '[redacted]'],
  [/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]'],
  [/\b(?:api[_-]?key|apikey|token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi, '[redacted]'],
  // Any long opaque run: a key that reached a message without a label.
  [/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]'],
]);

/**
 * Remove anything that looks like a credential from one string.
 *
 * The manager is the last thing that writes before a diagnostic leaves the
 * process, so it scrubs rather than trusts. It matters more here than
 * elsewhere: a provider's error text can quote the request, and a request can
 * carry a project's own secrets.
 *
 * @param text - the text to scrub.
 * @returns the scrubbed text.
 */
export function redact(text) {
  let result = String(text);
  for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement);
  return result;
}

/**
 * The failure facts worth keeping, with every secret-shaped substring removed.
 *
 * @param failure - a thrown error or a terminal finish reason.
 * @returns a frozen `{ code?, message? }`, or `null` when there is nothing to say.
 */
export function describeFailure(failure) {
  if (failure === null || failure === undefined) return null;
  const facts = {};
  const code = failure?.code ?? failure?.failure?.code;
  if (typeof code === 'string' && code !== '') facts.code = code;
  const message = failure?.message ?? failure?.failure?.message;
  if (typeof message === 'string' && message !== '') facts.message = redact(message).slice(0, 300);
  return Object.keys(facts).length === 0 ? null : Object.freeze(facts);
}
