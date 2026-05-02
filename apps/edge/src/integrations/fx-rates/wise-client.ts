/**
 * Wise (TransferWise) FX rates client.
 *
 * Fetches real-time exchange rates from the Wise API.
 * Requires a WISE_API_KEY passed explicitly (no global env access).
 *
 * INV-COST-003: spend_cents_normalized must be populated — this provider
 *   supplies the fx_rate required for normalization.
 * INV-COST-004: fx_currency must match workspace.fx_normalization_currency —
 *   caller is responsible for passing the correct `to` currency.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WISE_RATES_URL = 'https://api.wise.com/v1/rates';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class WiseFetchError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'WiseFetchError';
    this.cause = cause;
  }
}

export class WiseParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WiseParseError';
  }
}

// ---------------------------------------------------------------------------
// Response schema (minimal — only what we need)
// ---------------------------------------------------------------------------

interface WiseRateEntry {
  rate: number;
  source: string;
  target: string;
}

function parseWiseResponse(body: unknown, from: string, to: string): number {
  if (!Array.isArray(body) || body.length === 0) {
    throw new WiseParseError(
      `Wise API returned unexpected response shape for ${from}-${to}`,
    );
  }

  // Wise returns an array; the first element is the requested pair
  const entry = body[0] as WiseRateEntry;
  if (
    typeof entry.rate !== 'number' ||
    Number.isNaN(entry.rate) ||
    entry.rate <= 0
  ) {
    throw new WiseParseError(
      `Wise API returned invalid rate for ${from}-${to}: ${entry.rate}`,
    );
  }

  return entry.rate;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the exchange rate for a currency pair from Wise.
 *
 * @param from - ISO 4217 source currency (e.g. 'USD')
 * @param to   - ISO 4217 target currency (e.g. 'BRL')
 * @param apiKey - Wise API bearer token (injected — never read from global env here)
 * @param fetchFn - injectable fetch for testability
 *
 * INV-COST-003: caller uses the returned rate to compute spend_cents_normalized.
 * INV-COST-004: caller must ensure `to` matches workspace.fx_normalization_currency.
 */
export async function fetchWiseRate(
  from: string,
  to: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const url = `${WISE_RATES_URL}?source=${encodeURIComponent(from)}&target=${encodeURIComponent(to)}`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    throw new WiseFetchError(
      `Network error fetching Wise rate for ${from}-${to}`,
      err,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new WiseFetchError(
      `Wise API authentication failed (HTTP ${response.status}): check WISE_API_KEY`,
    );
  }

  if (!response.ok) {
    throw new WiseFetchError(
      `Wise API returned HTTP ${response.status}: ${response.statusText} for ${from}-${to}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    throw new WiseFetchError('Failed to parse Wise API response as JSON', err);
  }

  return parseWiseResponse(body, from, to);
}
