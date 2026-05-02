/**
 * Meta Custom Audiences HTTP client.
 *
 * Wraps the Meta Marketing API v18.0 Custom Audiences `/users` endpoint.
 * Supports both POST (add members) and DELETE (remove members).
 *
 * T-5-005
 *
 * BR-DISPATCH-003: 429 → exponential backoff, max 3 attempts.
 *   400 INVALID_PARAMETER → permanent failure (no retry).
 *   Other errors → retryable.
 * BR-PRIVACY-002: only hashes transmitted — no PII in clear.
 */

import type { MetaAudiencePayload } from './mapper.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_GRAPH_API_VERSION = 'v18.0';
const META_GRAPH_BASE_URL = 'https://graph.facebook.com';

/** Backoff delays in milliseconds for retry attempts 0, 1, 2. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

/** Maximum number of attempts (first attempt + 2 retries on 429). */
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Structured error thrown by MetaCustomAudienceClient.
 *
 * BR-DISPATCH-003: retryable=false → permanent failure; retryable=true → retry.
 */
export class MetaAudienceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MetaAudienceError';
  }
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface MetaUsersResponse {
  /** Number of members received by the Meta API. */
  numReceived: number;
  /** Optional audiences session info returned by Meta. */
  audienceSessionId?: string;
}

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/** Raw Meta API error envelope. */
interface MetaErrorEnvelope {
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

// ---------------------------------------------------------------------------
// MetaCustomAudienceClient
// ---------------------------------------------------------------------------

/**
 * Thin HTTP client for Meta Custom Audiences Management API.
 *
 * Constructed with a token and ad account ID; methods accept the
 * platform audience resource ID (Meta custom audience ID) and a payload.
 *
 * T-5-005
 * BR-AUDIENCE-002: caller must hold advisory lock before invoking this client.
 */
export class MetaCustomAudienceClient {
  constructor(
    private readonly token: string,
    private readonly adAccountId: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /**
   * Add members to a Meta Custom Audience.
   *
   * POST https://graph.facebook.com/v18.0/{audienceResourceId}/users
   *
   * BR-DISPATCH-003: retries on 429 with exponential backoff (max 3 attempts).
   *
   * @param audienceResourceId - Meta custom audience ID (platform_resource_id).
   * @param payload            - batched payload from buildMetaPayload().
   * @throws MetaAudienceError on unrecoverable errors.
   */
  async addMembers(
    audienceResourceId: string,
    payload: MetaAudiencePayload,
  ): Promise<MetaUsersResponse> {
    return this.callUsersEndpoint('POST', audienceResourceId, payload);
  }

  /**
   * Remove members from a Meta Custom Audience.
   *
   * DELETE https://graph.facebook.com/v18.0/{audienceResourceId}/users
   *
   * BR-DISPATCH-003: retries on 429 with exponential backoff (max 3 attempts).
   *
   * @param audienceResourceId - Meta custom audience ID (platform_resource_id).
   * @param payload            - batched payload from buildMetaPayload().
   * @throws MetaAudienceError on unrecoverable errors.
   */
  async removeMembers(
    audienceResourceId: string,
    payload: MetaAudiencePayload,
  ): Promise<MetaUsersResponse> {
    return this.callUsersEndpoint('DELETE', audienceResourceId, payload);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async callUsersEndpoint(
    method: 'POST' | 'DELETE',
    audienceResourceId: string,
    payload: MetaAudiencePayload,
  ): Promise<MetaUsersResponse> {
    const url = `${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${encodeURIComponent(audienceResourceId)}/users`;

    const body = JSON.stringify({ payload });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let response: Response;

      try {
        response = await this.fetchFn(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.token}`,
          },
          body,
        });
      } catch {
        // Network-level failure — retryable
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(RETRY_DELAYS_MS[attempt] ?? 1_000);
          continue;
        }
        throw new MetaAudienceError(
          'Network error calling Meta Custom Audiences API',
          'NETWORK_ERROR',
          true,
        );
      }

      if (response.ok) {
        // 2xx — parse num_received if present, else derive from data length
        type SuccessBody = {
          num_received?: number;
          audience_session?: { session_id?: string };
        };
        const json = (await response.json()) as SuccessBody;
        return {
          numReceived: json.num_received ?? payload.data.length,
          audienceSessionId: json.audience_session?.session_id,
        };
      }

      const status = response.status;

      // BR-DISPATCH-003: 429 → retry with backoff
      if (status === 429) {
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(RETRY_DELAYS_MS[attempt] ?? 1_000);
          continue;
        }
        throw new MetaAudienceError(
          'Rate limit exceeded after max retries',
          'RATE_LIMIT',
          true,
        );
      }

      // 4xx / 5xx — try to parse error envelope
      let envelope: MetaErrorEnvelope = {};
      try {
        envelope = (await response.json()) as MetaErrorEnvelope;
      } catch {
        // JSON parse failed
      }

      const errorCode = String(envelope.error?.code ?? 'UNKNOWN');
      const errorMessage = envelope.error?.message ?? `HTTP ${status}`;

      // BR-DISPATCH-003: 400 INVALID_PARAMETER → permanent failure (no retry)
      if (status === 400 && errorCode === 'INVALID_PARAMETER') {
        throw new MetaAudienceError(errorMessage, 'INVALID_PARAMETER', false);
      }

      // All other errors from Meta — retryable unless it's a 4xx we can't recover from
      const retryable = status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        await sleep(RETRY_DELAYS_MS[attempt] ?? 1_000);
        continue;
      }

      throw new MetaAudienceError(errorMessage, errorCode, retryable);
    }

    // Should never reach here — last iteration always throws
    throw new MetaAudienceError(
      'Exhausted retries calling Meta Custom Audiences API',
      'RETRY_EXHAUSTED',
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
