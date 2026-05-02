/**
 * Google Ads Enhanced Conversions HTTP client.
 *
 * Sends a single conversionAdjustment to the Google Ads API.
 * fetch is injectable so the function is testable without real network I/O.
 *
 * T-4-006
 * BR-DISPATCH-003: retry/permanent/skip classification drives the caller's retry logic.
 *   RESOURCE_EXHAUSTED (429 / gRPC 8) → retry
 *   INVALID_ARGUMENT with order_id unknown → permanent_failure (order_id_not_found)
 *   other 4xx → permanent_failure
 *   5xx / network → server_error (retry)
 */

import type { EnhancedConversionPayload } from './mapper.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for a single Enhanced Conversions request. */
export interface GoogleEnhancedConversionsConfig {
  /**
   * Google Ads customer ID (without dashes).
   * e.g. "1234567890"
   */
  customerId: string;
  /** Google Ads API developer token. */
  developerToken: string;
  /** Short-lived access token from OAuth refresh. */
  accessToken: string;
}

/** Discriminated union for the result of a conversionAdjustments:upload call. */
export type GoogleAdsResult =
  | { ok: true }
  | { ok: false; kind: 'rate_limit' }
  | { ok: false; kind: 'server_error'; status: number }
  | { ok: false; kind: 'permanent_failure'; code: string };

/** Google Ads API error detail shape (REST JSON mapping). */
interface GoogleAdsErrorDetail {
  errorCode?: {
    requestError?: string;
    conversionUploadError?: string;
    [key: string]: string | undefined;
  };
  message?: string;
  [key: string]: unknown;
}

/** Google Ads API error envelope (REST JSON mapping). */
interface GoogleAdsErrorEnvelope {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: GoogleAdsErrorDetail[];
  };
}

/** Google Ads partial failure error in the success-shaped response. */
interface ConversionAdjustmentsUploadResponse {
  partialFailureError?: {
    code?: number;
    message?: string;
    details?: GoogleAdsErrorDetail[];
  };
  results?: unknown[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_ADS_BASE_URL = 'https://googleads.googleapis.com';
const GOOGLE_ADS_API_VERSION = 'v17';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the error message or details indicate an unknown order_id
 * (i.e., the original tagged conversion was not found).
 */
function isOrderIdNotFound(envelope: GoogleAdsErrorEnvelope): boolean {
  const message = envelope.error?.message?.toLowerCase() ?? '';
  if (message.includes('order_id') || message.includes('not found')) {
    return true;
  }
  const details = envelope.error?.details ?? [];
  for (const detail of details) {
    const detailMsg = (detail.message ?? '').toLowerCase();
    if (detailMsg.includes('order_id') || detailMsg.includes('not found')) {
      return true;
    }
    // Google Ads surfaces conversionUploadError with INVALID_CONVERSION_ACTION_TYPE
    // or similar when the original conversion is absent.
    const convErr = detail.errorCode?.conversionUploadError ?? '';
    if (
      convErr.includes('ORDER_ID_NOT_FOUND') ||
      convErr.includes('NOT_FOUND')
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Uploads a single Enhanced Conversion adjustment to Google Ads.
 *
 * T-4-006
 * BR-DISPATCH-003: caller uses GoogleAdsResult to decide retry vs permanent vs skip.
 *
 * @param payload  - the adjustment payload from mapEventToEnhancedConversion()
 * @param config   - API credentials (customerId, developerToken, accessToken)
 * @param fetchFn  - injectable fetch (defaults to global fetch)
 */
export async function sendEnhancedConversion(
  payload: EnhancedConversionPayload,
  config: GoogleEnhancedConversionsConfig,
  fetchFn: typeof fetch = fetch,
): Promise<GoogleAdsResult> {
  const url = `${GOOGLE_ADS_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers/${encodeURIComponent(config.customerId)}/conversionAdjustments:upload`;

  const body = JSON.stringify({
    conversionAdjustments: [payload],
    partialFailure: true,
  });

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.accessToken}`,
        'developer-token': config.developerToken,
      },
      body,
    });
  } catch (networkError) {
    // Network-level failure — treat as server_error so caller retries.
    // BR-DISPATCH-003: network timeout → retrying
    return { ok: false, kind: 'server_error', status: 0 };
  }

  // --- 429 RESOURCE_EXHAUSTED (HTTP-level) ---
  if (response.status === 429) {
    // BR-DISPATCH-003: 429 → retrying with backoff
    return { ok: false, kind: 'rate_limit' };
  }

  // --- 5xx server errors ---
  if (response.status >= 500) {
    // BR-DISPATCH-003: 5xx → retrying with backoff
    return { ok: false, kind: 'server_error', status: response.status };
  }

  // --- 4xx client errors ---
  if (!response.ok) {
    const status = response.status;

    let envelope: GoogleAdsErrorEnvelope = {};
    try {
      envelope = (await response.json()) as GoogleAdsErrorEnvelope;
    } catch {
      return { ok: false, kind: 'permanent_failure', code: 'bad_request' };
    }

    // RESOURCE_EXHAUSTED can also arrive as a 4xx via gRPC/JSON mapping.
    if (envelope.error?.status === 'RESOURCE_EXHAUSTED') {
      return { ok: false, kind: 'rate_limit' };
    }

    // INVALID_ARGUMENT with order_id unknown → permanent (original conversion not found).
    // BR-DISPATCH-003: INVALID_ARGUMENT (order_id not found) → failed (no retry)
    if (
      status === 400 &&
      envelope.error?.status === 'INVALID_ARGUMENT' &&
      isOrderIdNotFound(envelope)
    ) {
      return {
        ok: false,
        kind: 'permanent_failure',
        code: 'order_id_not_found',
      };
    }

    // All other 4xx → permanent failure (no retry)
    return {
      ok: false,
      kind: 'permanent_failure',
      code: envelope.error?.status ?? 'bad_request',
    };
  }

  // --- 2xx ---
  // Google Ads uses partialFailure — even 2xx can carry inner errors.
  let responseBody: ConversionAdjustmentsUploadResponse = {};
  try {
    responseBody =
      (await response.json()) as ConversionAdjustmentsUploadResponse;
  } catch {
    // Unparseable 2xx body — assume success (idempotent send).
    return { ok: true };
  }

  if (responseBody.partialFailureError) {
    const pfError = responseBody.partialFailureError;
    const pfMessage = pfError.message?.toLowerCase() ?? '';

    // RESOURCE_EXHAUSTED in partial failure → rate_limit
    if (pfError.code === 8 || pfMessage.includes('resource_exhausted')) {
      return { ok: false, kind: 'rate_limit' };
    }

    // order_id not found in partial failure → permanent
    const pseudoEnvelope: GoogleAdsErrorEnvelope = {
      error: {
        status: 'INVALID_ARGUMENT',
        message: pfError.message,
        details: pfError.details,
      },
    };
    if (isOrderIdNotFound(pseudoEnvelope)) {
      return {
        ok: false,
        kind: 'permanent_failure',
        code: 'order_id_not_found',
      };
    }

    return {
      ok: false,
      kind: 'permanent_failure',
      code: 'partial_failure',
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Error classifier helper
// ---------------------------------------------------------------------------

/**
 * Translates a GoogleAdsResult (non-ok) into a dispatch classification.
 *
 * Used by the dispatch worker to decide the next status transition.
 *
 * BR-DISPATCH-003:
 *   retry     → rate_limit, server_error
 *   permanent → permanent_failure (bad_request, order_id_not_found, etc.)
 */
export function classifyGoogleEnhancedError(
  result: Extract<GoogleAdsResult, { ok: false }>,
): 'retry' | 'permanent' | 'skip' {
  switch (result.kind) {
    case 'rate_limit':
      return 'retry';
    case 'server_error':
      return 'retry';
    case 'permanent_failure':
      return 'permanent';
  }
}
