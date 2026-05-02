/**
 * Manual FX rate resolver.
 *
 * Reads `workspace.config.fx_overrides` (jsonb) to resolve a currency pair.
 * Used when FX_RATES_PROVIDER='manual' — operator sets rates via Control Plane.
 *
 * Shape of fx_overrides:
 *   {
 *     "USD-BRL": 5.20,
 *     "EUR-BRL": 6.10,
 *     "date": "2026-05-01"
 *   }
 *
 * If the stored date does not match today, the rate is considered stale and
 * `null` is returned — forcing fallback to another provider or cached value.
 *
 * INV-COST-004: fx_currency must match workspace.fx_normalization_currency —
 *   the pair key encodes both currencies, so the caller must construct it
 *   consistently (e.g. "USD-BRL" where BRL is the normalization currency).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Validates the shape of workspace.config.fx_overrides.
 * Additional keys (the pairs) are allowed and parsed as numbers.
 */
const FxOverridesSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  })
  .catchall(z.unknown());

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a manual FX rate from workspace config.
 *
 * @param pair   - Currency pair string in "FROM-TO" format, e.g. "USD-BRL"
 * @param config - Raw workspace.config value (unknown shape — validated internally)
 * @param today  - Current date string YYYY-MM-DD (injectable for testability)
 * @returns The rate number if found and date matches today; null otherwise
 *
 * INV-COST-003: returning null signals caller to use fallback for normalization.
 * INV-COST-004: pair encodes the target currency — caller must ensure consistency
 *   with workspace.fx_normalization_currency.
 */
export function resolveManualRate(
  pair: string,
  config: unknown,
  today: string = new Date().toISOString().slice(0, 10),
): number | null {
  // Validate shape — if invalid, treat as no override available
  const parsed = FxOverridesSchema.safeParse(config);
  if (!parsed.success) {
    return null;
  }

  const overrides = parsed.data;

  // Check date validity — stale rates must not be used automatically
  // INV-COST-003: only return a rate when the date matches today (fresh data)
  if (overrides.date !== today) {
    return null;
  }

  // Look up the pair
  const value = overrides[pair];

  if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
    return null;
  }

  return value;
}
