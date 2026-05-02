/**
 * GA4 Measurement Protocol HTTP client.
 *
 * Sends a single event payload to Google Analytics via the Measurement Protocol.
 * fetch is injectable so the function is testable without real network I/O.
 *
 * T-4-004
 * BR-DISPATCH-003: retry/permanent/skip classification drives the caller's
 *   retry logic (5xx → retry; 4xx → permanent).
 *
 * GA4 behaviour note (docs/40-integrations/06-ga4-measurement-protocol.md):
 *   - Success: 204 No Content (no confirmation of actual data ingestion).
 *   - Debug endpoint: /debug/mp/collect — returns validation errors.
 *   - GA4 does NOT have server-side dedup via API; idempotency is local-only (BR-DISPATCH-001).
 */

import type { Ga4MpPayload } from './mapper.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for a single GA4 MP request. */
export interface Ga4Config {
  /** GA4 Measurement ID (from GA4_MEASUREMENT_ID env var). */
  measurementId: string;
  /**
   * GA4 API Secret (from GA4_API_SECRET env var).
   * Sprint 4: global env var. Phase 2: per-workspace.
   */
  apiSecret: string;
  /**
   * Enable debug/validation endpoint (DEBUG_GA4=true env var).
   * Uses /debug/mp/collect which returns validation errors.
   */
  debugMode?: boolean;
}

/** Discriminated union for the result of a GA4 MP call. */
export type Ga4Result =
  | { ok: true }
  | { ok: false; kind: 'server_error'; status: number }
  | { ok: false; kind: 'permanent_failure'; code: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GA4_MP_BASE_URL = 'https://www.google-analytics.com';
const GA4_MP_PATH = '/mp/collect';
const GA4_MP_DEBUG_PATH = '/debug/mp/collect';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends one event payload to GA4 Measurement Protocol.
 *
 * T-4-004
 * BR-DISPATCH-003: caller uses Ga4Result to decide retry vs permanent.
 *
 * @param payload    - the GA4 MP payload from mapEventToGa4Payload()
 * @param config     - GA4 credentials (measurementId + apiSecret)
 * @param fetchFn    - injectable fetch (defaults to global fetch)
 */
export async function sendToGa4(
  payload: Ga4MpPayload,
  config: Ga4Config,
  fetchFn: typeof fetch = fetch,
): Promise<Ga4Result> {
  const path = config.debugMode ? GA4_MP_DEBUG_PATH : GA4_MP_PATH;
  const url = new URL(`${GA4_MP_BASE_URL}${path}`);
  url.searchParams.set('measurement_id', config.measurementId);
  url.searchParams.set('api_secret', config.apiSecret);

  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Network-level failure — treat as server_error so caller retries.
    // BR-DISPATCH-003: network timeout → retrying
    return { ok: false, kind: 'server_error', status: 0 };
  }

  // GA4 MP returns 204 No Content on success.
  if (response.status === 204 || response.ok) {
    return { ok: true };
  }

  const status = response.status;

  if (status >= 500) {
    // BR-DISPATCH-003: 5xx → retrying with backoff
    return { ok: false, kind: 'server_error', status };
  }

  // 4xx — permanent failure (no retry).
  // BR-DISPATCH-003: 4xx → failed (no retry)
  return { ok: false, kind: 'permanent_failure', code: `http_${status}` };
}

// ---------------------------------------------------------------------------
// Error classifier helper
// ---------------------------------------------------------------------------

/**
 * Translates a Ga4Result (non-ok) into a dispatch classification.
 *
 * Used by the dispatch worker to decide the next status transition.
 *
 * BR-DISPATCH-003:
 *   retry         → 5xx, network errors (status 0)
 *   permanent     → 4xx (bad request, unauthorized, etc.)
 */
export function classifyGa4Error(
  result: Extract<Ga4Result, { ok: false }>,
): 'retry' | 'permanent' {
  switch (result.kind) {
    case 'server_error':
      return 'retry';
    case 'permanent_failure':
      return 'permanent';
  }
}
