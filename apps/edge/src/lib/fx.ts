/**
 * FX rate lookup with KV cache, retry, and stale fallback.
 *
 * This is the main entry point consumed by the cost ingestor (cron) when
 * computing spend_cents_normalized for ad_spend_daily rows.
 *
 * Flow:
 *   1. Try KV cache → hit: return rate (stale=false)
 *   2. Cache miss → call configured provider (up to 3 attempts, backoff 1s/2s/4s)
 *   3. Provider success → store in cache (TTL 25h + stale key) → return rate (stale=false)
 *   4. All retries fail → try stale KV fallback → return rate (stale=true)
 *   5. No stale available → throw FxRatesUnavailableError
 *
 * INV-COST-003: spend_cents_normalized must be populated after sync.
 *   getRateForPair is used to fulfil this invariant — throw only as last resort.
 * INV-COST-004: `to` must match workspace.fx_normalization_currency.
 *   Caller is responsible; this function does not validate workspace config.
 *
 * BR-COST-* are cited where applicable.
 */

import {
  getCachedRate,
  getStaleCachedRate,
  setCachedRate,
} from '../integrations/fx-rates/cache.js';
import {
  type FxProvider,
  createFxRatesClient,
} from '../integrations/fx-rates/factory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of getRateForPair */
export interface FxRateResult {
  /** Exchange rate: 1 `from` = rate * `to` */
  rate: number;
  /** True when the rate is from a previous day (stale cache fallback) */
  stale: boolean;
  /** Which provider supplied the rate */
  source: FxProvider;
}

/** Environment bindings required by getRateForPair (explicit DI) */
export interface FxEnv {
  GT_KV: KVNamespace;
  FX_RATES_PROVIDER?: string;
  FX_RATES_API_KEY?: string;
  /** Workspace config for manual provider overrides */
  workspaceConfig?: unknown;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FxRatesUnavailableError extends Error {
  public override readonly cause?: unknown;

  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly date: string,
    cause?: unknown,
  ) {
    super(
      `FX rates unavailable for ${from}-${to} on ${date} after retries and stale fallback`,
    );
    this.name = 'FxRatesUnavailableError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
/** Backoff delays in milliseconds: attempt 1 = 1s, attempt 2 = 2s, attempt 3 = 4s */
const BACKOFF_MS = [1000, 2000, 4000] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a valid FxProvider from the env var string.
 * Defaults to 'ecb' on missing or unrecognised value.
 */
function resolveProvider(raw?: string): FxProvider {
  if (raw === 'wise' || raw === 'manual') return raw;
  return 'ecb'; // default per docs/40-integrations/12-fx-rates-provider.md
}

/**
 * Sleep for `ms` milliseconds. Injectable for test overrides.
 *
 * In CF Workers, setTimeout is available (but note: Workers have a
 * CPU time limit; long sleeps in production should be avoided on hot paths).
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the FX exchange rate for a currency pair on a given date.
 *
 * Uses KV cache first, then provider with retry, then stale fallback.
 *
 * INV-COST-003: caller uses the returned rate to compute spend_cents_normalized
 *   via: Math.round(spend_cents * rate)
 * INV-COST-004: caller must pass `to` = workspace.fx_normalization_currency.
 *
 * @param from     - ISO 4217 source currency (e.g. 'USD')
 * @param to       - ISO 4217 target currency (e.g. 'BRL')
 * @param date     - YYYY-MM-DD — used for cache key and manual resolver
 * @param env      - Worker env bindings (GT_KV, FX_RATES_PROVIDER, etc.)
 * @param fetchFn  - Injectable fetch for testability
 * @param sleepFn  - Injectable sleep for testability
 */
export async function getRateForPair(
  from: string,
  to: string,
  date: string,
  env: FxEnv,
  fetchFn: typeof fetch = fetch,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<FxRateResult> {
  const provider = resolveProvider(env.FX_RATES_PROVIDER);

  // Step 1: KV cache hit
  const cached = await getCachedRate(env.GT_KV, provider, from, to, date);
  if (cached !== null) {
    return { rate: cached, stale: false, source: provider };
  }

  // Step 2: Provider call with retry + exponential backoff
  const client = createFxRatesClient(provider);
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const rate = await client(
        from,
        to,
        date,
        {
          FX_RATES_API_KEY: env.FX_RATES_API_KEY,
          workspaceConfig: env.workspaceConfig,
        },
        fetchFn,
      );

      // Step 3: Cache the fresh rate
      await setCachedRate(env.GT_KV, provider, from, to, date, rate);

      return { rate, stale: false, source: provider };
    } catch (err) {
      lastError = err;

      // Apply backoff before next attempt (but not after the last attempt)
      if (attempt < MAX_RETRIES - 1) {
        const delay = BACKOFF_MS[attempt] ?? 4000;
        await sleepFn(delay);
      }
    }
  }

  // Step 4: Stale fallback — use last known rate regardless of date
  const stale = await getStaleCachedRate(env.GT_KV, provider, from, to);
  if (stale !== null) {
    return { rate: stale, stale: true, source: provider };
  }

  // Step 5: No stale available — unrecoverable
  // INV-COST-003: caller must handle this to avoid leaving spend_cents_normalized NULL
  throw new FxRatesUnavailableError(from, to, date, lastError);
}

// ---------------------------------------------------------------------------
// Utility: normalization helper
// ---------------------------------------------------------------------------

/**
 * Compute spend_cents_normalized from spend_cents and fx_rate.
 *
 * INV-COST-003: spend_cents_normalized = round(spend_cents * fx_rate)
 * Round to nearest integer (standard banker-neutral rounding via Math.round).
 *
 * @param spendCents - original spend in source currency cents
 * @param rate       - FX rate (1 source unit = rate target units)
 * @returns normalized spend in target currency cents
 */
export function normalizeSpendCents(spendCents: number, rate: number): number {
  // INV-COST-003: round to integer — spend is always in cents
  return Math.round(spendCents * rate);
}
