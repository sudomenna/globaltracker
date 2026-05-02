/**
 * CF KV cache wrapper for FX rates.
 *
 * Key format: `fx:{provider}:{from}-{to}:{date}`
 *   - provider: 'ecb' | 'wise' | 'manual'
 *   - from/to: ISO 4217 3-char currency codes (uppercase)
 *   - date: YYYY-MM-DD
 *
 * TTL: 25 hours — covers the full ECB publish cycle (~16:00 CET daily)
 * with a 1-hour buffer so the cron job can refresh before cache expires.
 *
 * Stale reads use a separate key without TTL so the last known value is
 * always available as a fallback when the provider is unavailable.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 25 hours in seconds — primary cache TTL */
export const FX_CACHE_TTL_SECONDS = 25 * 60 * 60; // 90 000

/** Prefix for primary (TTL) cache keys */
const KEY_PREFIX = 'fx';

/** Prefix for stale (no-TTL) fallback keys */
const STALE_KEY_PREFIX = 'fx_stale';

// ---------------------------------------------------------------------------
// Key builders
// ---------------------------------------------------------------------------

/**
 * Build the KV key for a rate entry.
 *
 * @param provider - FX provider identifier
 * @param from     - source currency (will be uppercased)
 * @param to       - target currency (will be uppercased)
 * @param date     - YYYY-MM-DD
 */
export function buildCacheKey(
  provider: string,
  from: string,
  to: string,
  date: string,
): string {
  return `${KEY_PREFIX}:${provider}:${from.toUpperCase()}-${to.toUpperCase()}:${date}`;
}

/**
 * Build the stale fallback KV key (no date component — always overwritten).
 */
export function buildStaleCacheKey(
  provider: string,
  from: string,
  to: string,
): string {
  return `${STALE_KEY_PREFIX}:${provider}:${from.toUpperCase()}-${to.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve a cached rate from KV.
 *
 * Returns the rate number if found and not expired; null on cache miss.
 *
 * @param kv       - CF KVNamespace (injected — no global binding access)
 * @param provider - FX provider identifier for namespacing
 * @param from     - source currency
 * @param to       - target currency
 * @param date     - YYYY-MM-DD
 */
export async function getCachedRate(
  kv: KVNamespace,
  provider: string,
  from: string,
  to: string,
  date: string,
): Promise<number | null> {
  const key = buildCacheKey(provider, from, to, date);
  const value = await kv.get(key);
  if (value === null) return null;

  const rate = Number.parseFloat(value);
  if (Number.isNaN(rate) || rate <= 0) return null;

  return rate;
}

/**
 * Store a rate in KV with TTL 25h, and also update the stale fallback key.
 *
 * The stale key has no TTL — it persists indefinitely and is used as a
 * last-resort fallback when the provider is unavailable after retries.
 *
 * @param kv       - CF KVNamespace (injected)
 * @param provider - FX provider identifier
 * @param from     - source currency
 * @param to       - target currency
 * @param date     - YYYY-MM-DD
 * @param rate     - exchange rate to cache
 */
export async function setCachedRate(
  kv: KVNamespace,
  provider: string,
  from: string,
  to: string,
  date: string,
  rate: number,
): Promise<void> {
  const key = buildCacheKey(provider, from, to, date);
  const staleKey = buildStaleCacheKey(provider, from, to);
  const value = String(rate);

  // Write primary with TTL and stale fallback in parallel
  await Promise.all([
    kv.put(key, value, { expirationTtl: FX_CACHE_TTL_SECONDS }),
    kv.put(staleKey, value), // no TTL — kept indefinitely as fallback
  ]);
}

/**
 * Retrieve the stale (last-known) rate from KV.
 *
 * Used as a fallback when the provider fails after exhausting retries.
 * The returned value may be from a previous day.
 *
 * @param kv       - CF KVNamespace (injected)
 * @param provider - FX provider identifier
 * @param from     - source currency
 * @param to       - target currency
 */
export async function getStaleCachedRate(
  kv: KVNamespace,
  provider: string,
  from: string,
  to: string,
): Promise<number | null> {
  const staleKey = buildStaleCacheKey(provider, from, to);
  const value = await kv.get(staleKey);
  if (value === null) return null;

  const rate = Number.parseFloat(value);
  if (Number.isNaN(rate) || rate <= 0) return null;

  return rate;
}
