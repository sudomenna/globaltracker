/**
 * FX rates client factory.
 *
 * Selects the appropriate provider based on the FX_RATES_PROVIDER env var
 * and returns a unified `FxRatesClient` function interface.
 *
 * Supported providers:
 *   - ecb    (default): European Central Bank daily XML feed
 *   - wise:             Wise (TransferWise) API — requires WISE_API_KEY
 *   - manual:           Workspace-level config overrides
 *
 * INV-COST-003: the returned client is used to populate spend_cents_normalized.
 * INV-COST-004: the `to` currency must match workspace.fx_normalization_currency.
 */

import {
  EcbFetchError,
  EcbParseError,
  computeCrossRate,
  fetchEcbRates,
} from './ecb-client.js';
import { resolveManualRate } from './manual-resolver.js';
import { fetchWiseRate } from './wise-client.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Unified interface for all FX providers.
 * Returns the exchange rate: 1 unit of `from` = N units of `to`.
 *
 * @param from    - ISO 4217 source currency (e.g. 'USD')
 * @param to      - ISO 4217 target currency (e.g. 'BRL')
 * @param date    - YYYY-MM-DD (used by manual resolver for freshness check)
 * @param env     - Environment bindings (API keys, workspace config)
 * @param fetchFn - Injectable fetch for testability
 */
export type FxRatesClient = (
  from: string,
  to: string,
  date: string,
  env: FxRatesEnv,
  fetchFn?: typeof fetch,
) => Promise<number>;

/**
 * Subset of Worker env needed by FX clients.
 * Explicit DI — no global env access inside the clients.
 */
export interface FxRatesEnv {
  FX_RATES_API_KEY?: string;
  /** Workspace config for manual overrides (jsonb, unknown shape) */
  workspaceConfig?: unknown;
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

const ecbClient: FxRatesClient = async (from, to, _date, _env, fetchFn) => {
  const rates = await fetchEcbRates(fetchFn);
  return computeCrossRate(from, to, rates);
};

const wiseClient: FxRatesClient = async (from, to, _date, env, fetchFn) => {
  const apiKey = env.FX_RATES_API_KEY;
  if (!apiKey) {
    throw new Error(
      'WISE_API_KEY is required when FX_RATES_PROVIDER=wise but was not provided',
    );
  }
  return fetchWiseRate(from, to, apiKey, fetchFn);
};

const manualClient: FxRatesClient = async (from, to, date, env) => {
  const pair = `${from.toUpperCase()}-${to.toUpperCase()}`;
  const rate = resolveManualRate(pair, env.workspaceConfig, date);
  if (rate === null) {
    throw new Error(
      `Manual FX override not available for ${pair} on ${date} — check workspace config`,
    );
  }
  return rate;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type FxProvider = 'ecb' | 'wise' | 'manual';

/**
 * Create an FX rates client for the given provider.
 *
 * @param provider - 'ecb' | 'wise' | 'manual'
 * @returns FxRatesClient function
 *
 * Default (ecb) is used when provider is not specified or unrecognised —
 * consistent with the FX_RATES_PROVIDER=ecb default documented in 12-fx-rates-provider.md.
 */
export function createFxRatesClient(provider: FxProvider): FxRatesClient {
  switch (provider) {
    case 'ecb':
      return ecbClient;
    case 'wise':
      return wiseClient;
    case 'manual':
      return manualClient;
    default: {
      // TypeScript exhaustiveness check — if a new provider is added to the
      // FxProvider type but not handled here, this becomes a compile error.
      const _exhaustive: never = provider;
      void _exhaustive;
      return ecbClient; // runtime fallback — safe default
    }
  }
}

// Re-export errors so consumers have a single import point
export { EcbFetchError, EcbParseError };
