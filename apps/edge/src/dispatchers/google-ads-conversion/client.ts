/**
 * Google Ads Conversion Upload HTTP client.
 *
 * Sends click conversions to the Google Ads API via uploadClickConversions.
 * fetch is injectable so the function is testable without real network I/O.
 *
 * T-4-005
 * BR-DISPATCH-003: retry/permanent/skip classification drives the caller's
 *   retry logic (429/RESOURCE_EXHAUSTED → retry; INVALID_GCLID/PERMISSION_DENIED
 *   → permanent; 5xx → retry).
 */

import type { ConversionUploadPayload } from './mapper.js';
import { type OAuthConfig, refreshAccessToken } from './oauth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Credentials and account settings for a Google Ads API call. */
export interface GoogleAdsConfig {
  /** OAuth credentials for token refresh. */
  oauth: OAuthConfig;
  /** Google Ads Developer Token (header: developer-token). */
  developerToken: string;
  /** Google Ads Customer ID (without dashes, e.g. "1234567890"). */
  customerId: string;
  /**
   * Manager (MCC) Customer ID — set as login-customer-id header when provided.
   * Omit for direct accounts.
   */
  managerCustomerId?: string | null;
}

/** Discriminated union for the result of a Google Ads API call. */
export type GoogleAdsResult =
  | { ok: true }
  | { ok: false; kind: 'rate_limit' }
  | { ok: false; kind: 'server_error'; status: number }
  | { ok: false; kind: 'permanent_failure'; code: string };

/** Partial representation of a Google Ads API error status. */
interface GoogleAdsErrorStatus {
  code?: number;
  message?: string;
  details?: Array<{
    '@type'?: string;
    errors?: Array<{
      errorCode?: {
        conversionUploadError?: string;
        authorizationError?: string;
        quotaError?: string;
      };
      message?: string;
    }>;
  }>;
}

/** Google Ads API response envelope. */
interface GoogleAdsApiResponse {
  results?: unknown[];
  partialFailureError?: GoogleAdsErrorStatus;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOOGLE_ADS_BASE_URL = 'https://googleads.googleapis.com';
const GOOGLE_ADS_API_VERSION = 'v17';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Sends one click conversion to Google Ads uploadClickConversions.
 *
 * T-4-005
 * BR-DISPATCH-003: caller uses GoogleAdsResult to decide retry vs permanent.
 *
 * @param payload    - the conversion payload from mapEventToConversionUpload()
 * @param config     - Google Ads credentials and account settings
 * @param fetchFn    - injectable fetch (defaults to global fetch)
 */
export async function sendConversionUpload(
  payload: ConversionUploadPayload,
  config: GoogleAdsConfig,
  fetchFn: typeof fetch = fetch,
): Promise<GoogleAdsResult> {
  // Refresh OAuth access token (stateless — no cache in CF Workers).
  let accessToken: string;
  try {
    accessToken = await refreshAccessToken(config.oauth, fetchFn);
  } catch (oauthError) {
    // OAuth failure — treat as server error so caller may retry.
    // BR-DISPATCH-003: transient auth errors → retrying
    return { ok: false, kind: 'server_error', status: 0 };
  }

  const url = `${GOOGLE_ADS_BASE_URL}/${GOOGLE_ADS_API_VERSION}/customers/${encodeURIComponent(config.customerId)}:uploadClickConversions`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'developer-token': config.developerToken,
  };

  if (config.managerCustomerId) {
    headers['login-customer-id'] = config.managerCustomerId;
  }

  const body = JSON.stringify({
    conversions: [payload],
    partialFailure: true,
  });

  let response: Response;
  try {
    response = await fetchFn(url, { method: 'POST', headers, body });
  } catch (networkError) {
    // BR-DISPATCH-003: network timeout → retrying
    return { ok: false, kind: 'server_error', status: 0 };
  }

  if (response.status === 429) {
    // BR-DISPATCH-003: RESOURCE_EXHAUSTED / HTTP 429 → retrying with backoff
    return { ok: false, kind: 'rate_limit' };
  }

  if (response.status >= 500) {
    // BR-DISPATCH-003: 5xx → retrying with backoff
    return { ok: false, kind: 'server_error', status: response.status };
  }

  if (!response.ok) {
    // 4xx (excluding 429 handled above)
    return classifyHttpError(response.status);
  }

  // 2xx — check for partialFailureError in response body.
  let apiResponse: GoogleAdsApiResponse = {};
  try {
    apiResponse = (await response.json()) as GoogleAdsApiResponse;
  } catch {
    // Body parse failure on 2xx — treat as success (conversion likely recorded).
    return { ok: true };
  }

  if (apiResponse.partialFailureError) {
    return classifyPartialFailure(apiResponse.partialFailureError);
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
 *   retry     → 429 (rate_limit), 5xx (server_error), network errors
 *   permanent → 400/403/INVALID_GCLID/EXPIRED_GCLID/PERMISSION_DENIED
 */
export function classifyGoogleAdsError(
  result: Extract<GoogleAdsResult, { ok: false }>,
): 'retry' | 'permanent' {
  switch (result.kind) {
    case 'rate_limit':
      return 'retry';
    case 'server_error':
      return 'retry';
    case 'permanent_failure':
      return 'permanent';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps HTTP 4xx status codes (excluding 429) to a permanent failure result.
 */
function classifyHttpError(status: number): GoogleAdsResult {
  if (status === 403) {
    // BR-DISPATCH-003: 403 PERMISSION_DENIED → permanent failure; ops alert
    return { ok: false, kind: 'permanent_failure', code: 'permission_denied' };
  }
  return { ok: false, kind: 'permanent_failure', code: 'bad_request' };
}

/**
 * Inspects a Google Ads partialFailureError to determine the classification.
 *
 * Google Ads returns 200 with partialFailureError for per-conversion errors.
 * We extract the most specific error code available.
 *
 * BR-DISPATCH-003:
 *   INVALID_GCLID / EXPIRED_GCLID → permanent failure (no retry)
 *   RESOURCE_EXHAUSTED            → rate_limit (retry)
 *   PERMISSION_DENIED             → permanent failure; ops alert
 */
function classifyPartialFailure(
  errorStatus: GoogleAdsErrorStatus,
): GoogleAdsResult {
  // Walk details to find the first conversion upload error code.
  for (const detail of errorStatus.details ?? []) {
    for (const err of detail.errors ?? []) {
      const conversionError = err.errorCode?.conversionUploadError;
      if (conversionError) {
        if (
          conversionError === 'INVALID_GCLID' ||
          conversionError === 'EXPIRED_GCLID'
        ) {
          // BR-DISPATCH-003: invalid/expired gclid → failed (no retry)
          return {
            ok: false,
            kind: 'permanent_failure',
            code: 'invalid_gclid',
          };
        }
      }

      const authError = err.errorCode?.authorizationError;
      if (authError === 'USER_PERMISSION_DENIED') {
        // BR-DISPATCH-003: permission denied → permanent failure
        return {
          ok: false,
          kind: 'permanent_failure',
          code: 'permission_denied',
        };
      }

      const quotaError = err.errorCode?.quotaError;
      if (quotaError === 'RESOURCE_EXHAUSTED') {
        // BR-DISPATCH-003: quota exhausted → retry with backoff
        return { ok: false, kind: 'rate_limit' };
      }
    }
  }

  // Unknown partial failure — treat as permanent to avoid infinite retries on
  // malformed conversions.
  return {
    ok: false,
    kind: 'permanent_failure',
    code: `partial_failure_code_${errorStatus.code ?? 'unknown'}`,
  };
}
