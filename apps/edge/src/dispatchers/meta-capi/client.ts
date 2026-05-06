/**
 * Meta CAPI HTTP client.
 *
 * Sends a single event payload to Meta's Conversions API.
 * fetch is injectable so the function is testable without real network I/O.
 *
 * T-3-002
 * BR-DISPATCH-003: retry/permanent/skip classification drives the caller's
 *   retry logic (429 → retry; 4xx permanent → failed; skip → skipped).
 */

import type { MetaCapiPayload } from './mapper.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for a single Meta CAPI request. */
export interface MetaCapiConfig {
  /** Meta Pixel ID — derived from launches.config.tracking.meta.pixel_id. */
  pixelId: string;
  /**
   * Meta access token.
   * Sprint 3: global META_CAPI_TOKEN env var.
   * Phase 2: per-workspace token.
   */
  accessToken: string;
  /** Optional test event code (META_CAPI_TEST_EVENT_CODE). */
  testEventCode?: string;
}

/** Successful response body returned by Meta's Conversions API. */
export interface MetaCapiResponseBody {
  events_received: number;
  messages: string[];
  fbtrace_id: string;
}

/** Discriminated union for the result of a CAPI call. */
export type MetaCapiResult =
  | { ok: true; data: MetaCapiResponseBody }
  | { ok: false; kind: 'rate_limit' }
  | { ok: false; kind: 'server_error'; status: number }
  | { ok: false; kind: 'permanent_failure'; code: string }
  | { ok: false; kind: 'skip'; reason: 'no_user_data' };

/** Error detail surfaced from Meta's JSON error object. */
interface MetaApiError {
  message?: string;
  type?: string;
  code?: string | number;
  error_subcode?: number;
  fbtrace_id?: string;
}

/** Meta's standard error envelope. */
interface MetaErrorEnvelope {
  error?: MetaApiError;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_GRAPH_API_VERSION = 'v20.0';
const META_GRAPH_BASE_URL = 'https://graph.facebook.com';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends one event payload to Meta's Conversions API.
 *
 * T-3-002
 * BR-DISPATCH-003: caller uses MetaCapiResult to decide retry vs permanent vs skip.
 *
 * @param payload      - the single-event payload from mapEventToMetaPayload()
 * @param config       - pixel credentials (pixelId + accessToken)
 * @param fetchFn      - injectable fetch (defaults to global fetch)
 */
export async function sendToMetaCapi(
  payload: MetaCapiPayload,
  config: MetaCapiConfig,
  fetchFn: typeof fetch = fetch,
): Promise<MetaCapiResult> {
  const url = `${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${encodeURIComponent(config.pixelId)}/events`;

  // Meta expects test_event_code at the TOP LEVEL of the request body (sibling of `data`),
  // NOT inside each event in the data array. Strip from event payload (legacy mapper bug)
  // and re-attach at top level when configured.
  const { test_event_code: _embeddedTestCode, ...payloadWithoutTestCode } =
    payload as MetaCapiPayload & { test_event_code?: string };
  const requestBody: { data: MetaCapiPayload[]; test_event_code?: string } = {
    data: [payloadWithoutTestCode as MetaCapiPayload],
  };
  if (config.testEventCode) {
    requestBody.test_event_code = config.testEventCode;
  }
  const body = JSON.stringify(requestBody);

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.accessToken}`,
      },
      body,
    });
  } catch (networkError) {
    // Network-level failure — treat as server_error so caller retries.
    // BR-DISPATCH-003: network timeout → retrying
    return { ok: false, kind: 'server_error', status: 0 };
  }

  if (response.ok) {
    // 2xx
    const data = (await response.json()) as MetaCapiResponseBody;
    return { ok: true, data };
  }

  // Non-2xx — parse error envelope where possible.
  const status = response.status;

  if (status === 429) {
    // BR-DISPATCH-003: 429 → retrying with backoff
    return { ok: false, kind: 'rate_limit' };
  }

  if (status >= 500) {
    // BR-DISPATCH-003: 5xx → retrying with backoff
    return { ok: false, kind: 'server_error', status };
  }

  // 4xx — attempt to parse Meta's error envelope for classification.
  let envelope: MetaErrorEnvelope = {};
  try {
    envelope = (await response.json()) as MetaErrorEnvelope;
  } catch {
    // JSON parse failure on a 4xx — treat as generic permanent failure.
    return { ok: false, kind: 'permanent_failure', code: 'bad_request' };
  }

  const errorCode = envelope.error?.code;
  const errorMessage = envelope.error?.message ?? '';

  // BR-DISPATCH-003: 400 invalid_pixel_id → failed (no retry)
  if (
    status === 400 &&
    (errorCode === 'invalid_pixel_id' || errorCode === 190)
  ) {
    return { ok: false, kind: 'permanent_failure', code: 'invalid_pixel_id' };
  }

  // BR-DISPATCH-003: 400 missing_required_user_data → skipped
  if (
    status === 400 &&
    errorMessage.toLowerCase().includes('missing_required_user_data')
  ) {
    return { ok: false, kind: 'skip', reason: 'no_user_data' };
  }

  // All other 400 / 403 / 422 → permanent failure (no retry)
  return { ok: false, kind: 'permanent_failure', code: 'bad_request' };
}

// ---------------------------------------------------------------------------
// Error classifier helper
// ---------------------------------------------------------------------------

/**
 * Translates a MetaCapiResult (non-ok) into a dispatch classification.
 *
 * Used by the dispatch worker to decide the next status transition.
 *
 * BR-DISPATCH-003:
 *   retry         → 429, 5xx, network errors
 *   permanent     → 400/403/422 (invalid pixel, bad request)
 *   skip          → missing user data (no_user_data)
 */
export function classifyMetaCapiError(
  result: Extract<MetaCapiResult, { ok: false }>,
): 'retry' | 'permanent' | 'skip' {
  switch (result.kind) {
    case 'rate_limit':
      return 'retry';
    case 'server_error':
      return 'retry';
    case 'permanent_failure':
      return 'permanent';
    case 'skip':
      return 'skip';
  }
}
