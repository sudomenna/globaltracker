/**
 * ECB (European Central Bank) FX rates client.
 *
 * Fetches daily reference rates from the official ECB XML feed.
 * All rates are EUR-based; cross-rates are derived mathematically.
 *
 * INV-COST-003: spend_cents_normalized must be populated — this provider
 *   supplies the fx_rate required for normalization.
 * INV-COST-004: fx_currency must match workspace.fx_normalization_currency —
 *   caller is responsible for passing the correct `to` currency.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ECB_URL =
  'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EcbFetchError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EcbFetchError';
    this.cause = cause;
  }
}

export class EcbParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcbParseError';
  }
}

// ---------------------------------------------------------------------------
// XML parsing — no external XML lib needed; ECB format is well-known
// ---------------------------------------------------------------------------

/**
 * Parse ECB XML response into a map of { currency: rate }.
 * All rates are relative to EUR (base = 1 EUR).
 *
 * The ECB format contains `<Cube currency="USD" rate="1.0810"/>` entries.
 */
export function parseEcbXml(xml: string): Record<string, number> {
  // Match all <Cube currency="XXX" rate="N.NNN"/> entries (case-insensitive attrs)
  const pattern = /<Cube\s+currency="([A-Z]{3})"\s+rate="([0-9.]+)"\s*\/>/gi;
  const rates: Record<string, number> = {
    // EUR is always 1 relative to itself
    EUR: 1,
  };

  for (
    let match = pattern.exec(xml);
    match !== null;
    match = pattern.exec(xml)
  ) {
    const currency = match[1];
    const rate = Number.parseFloat(match[2] ?? '');
    if (!currency || Number.isNaN(rate) || rate <= 0) {
      throw new EcbParseError(
        `Invalid rate entry: currency=${match[1]}, rate=${match[2]}`,
      );
    }
    rates[currency] = rate;
  }

  if (Object.keys(rates).length <= 1) {
    throw new EcbParseError('ECB XML contained no valid currency rates');
  }

  return rates;
}

// ---------------------------------------------------------------------------
// Cross-rate computation
// ---------------------------------------------------------------------------

/**
 * Compute cross-rate between `from` and `to` using EUR-based rates map.
 *
 * Formula:
 *   - If from === 'EUR': rate = rates[to]
 *   - If to === 'EUR':   rate = 1 / rates[from]
 *   - Otherwise:         rate = rates[to] / rates[from]
 *
 * INV-COST-004: caller must ensure `to` matches workspace.fx_normalization_currency.
 */
export function computeCrossRate(
  from: string,
  to: string,
  rates: Record<string, number>,
): number {
  if (from === to) return 1;

  if (from === 'EUR') {
    const toRate = rates[to];
    if (toRate === undefined) {
      throw new EcbParseError(`Currency not found in ECB rates: ${to}`);
    }
    return toRate;
  }

  if (to === 'EUR') {
    const fromRate = rates[from];
    if (fromRate === undefined) {
      throw new EcbParseError(`Currency not found in ECB rates: ${from}`);
    }
    return 1 / fromRate;
  }

  const fromRate = rates[from];
  const toRate = rates[to];

  if (fromRate === undefined) {
    throw new EcbParseError(`Currency not found in ECB rates: ${from}`);
  }
  if (toRate === undefined) {
    throw new EcbParseError(`Currency not found in ECB rates: ${to}`);
  }

  // Cross-rate via EUR
  return toRate / fromRate;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch all ECB reference rates for today.
 *
 * Returns a map of { currency: rate } where EUR = 1 (base).
 * Inject `fetchFn` for testability (avoids real network calls in tests).
 *
 * INV-COST-003: downstream consumer uses this to populate spend_cents_normalized.
 */
export async function fetchEcbRates(
  fetchFn: typeof fetch = fetch,
): Promise<Record<string, number>> {
  let response: Response;
  try {
    response = await fetchFn(ECB_URL, {
      headers: { Accept: 'application/xml, text/xml' },
    });
  } catch (err) {
    throw new EcbFetchError('Network error fetching ECB rates', err);
  }

  if (!response.ok) {
    throw new EcbFetchError(
      `ECB endpoint returned HTTP ${response.status}: ${response.statusText}`,
    );
  }

  let xml: string;
  try {
    xml = await response.text();
  } catch (err) {
    throw new EcbFetchError('Failed to read ECB response body', err);
  }

  return parseEcbXml(xml);
}
