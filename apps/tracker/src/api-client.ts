/**
 * API client for /v1/config and /v1/events.
 *
 * Contract: docs/30-contracts/05-api-server-actions.md (CONTRACT-api-config-v1, CONTRACT-api-events-v1)
 *
 * INV-TRACKER-007: failure in /v1/config or /v1/events degrades silently — catch returns null/void.
 * INV-TRACKER-002: zero runtime dependencies.
 * INV-TRACKER-005: never send PII in clear — only hashes, platform cookies, and lead_token.
 */

import type { TrackerConfig } from './types';

/** Shape of the POST /v1/events request body (CONTRACT-api-events-v1). */
export interface EventPayload {
  /** Client-generated UUID for idempotency (BR-EVENT-002). */
  event_id: string;
  schema_version: 1;
  launch_public_id: string;
  page_public_id: string;
  event_name: string;
  /** ISO 8601 timestamp — Edge clamps if in future (contract). */
  event_time: string;
  /** INV-TRACKER-008: only lead_token, never lead_id in clear. */
  lead_token?: string;
  /**
   * Anonymous visitor ID from __fvid cookie.
   * INV-TRACKER-003: only present when consent_analytics='granted'.
   * Used by backend to retroactively link anonymous events to a lead (T-5-003).
   */
  visitor_id?: string;
  attribution: Record<string, string | null>;
  user_data: Record<string, string | null>;
  custom_data: Record<string, unknown>;
  consent: {
    analytics: string;
    marketing: string;
    ad_user_data: string;
    ad_personalization: string;
    customer_match?: string;
  };
}

/** Shape of the 202 Accepted response from POST /v1/events. */
export interface SendEventResponse {
  event_id: string;
  status: 'accepted' | 'duplicate_accepted' | 'rejected';
}

/**
 * Fetch tracker config from Edge.
 * GET /v1/config/:launch_public_id/:page_public_id
 * Header: X-Funil-Site: <site_token>
 *
 * INV-TRACKER-007: on any error, returns null — caller transitions to 'initialized'
 * without event_config rather than throwing.
 */
export async function fetchConfig(
  siteToken: string,
  launchPublicId: string,
  pagePublicId: string,
  baseUrl = '',
): Promise<TrackerConfig | null> {
  try {
    const url = `${baseUrl}/v1/config/${encodeURIComponent(launchPublicId)}/${encodeURIComponent(pagePublicId)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Funil-Site': siteToken,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      // INV-TRACKER-007: non-2xx → degrade silently
      return null;
    }

    const data = (await res.json()) as TrackerConfig;
    return data;
  } catch {
    // INV-TRACKER-007: network error, CORS, parse error → degrade silently
    return null;
  }
}

/**
 * POST /v1/events — sends a tracker event to the Edge.
 *
 * CONTRACT-api-events-v1: body shape as EventPayload above.
 * Header: X-Funil-Site: <siteToken>
 *
 * INV-TRACKER-005: payload must never include PII in clear.
 * INV-TRACKER-007: any network or HTTP error is caught and discarded silently.
 *
 * @returns the event_id from the response, or the original payload event_id on failure.
 */
export async function sendEvent(
  siteToken: string,
  payload: EventPayload,
  baseUrl = '',
): Promise<string> {
  try {
    const url = `${baseUrl}/v1/events`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Funil-Site': siteToken,
      },
      // keepalive: true allows the request to outlive the page unload (best-effort)
      keepalive: true,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      // INV-TRACKER-007: non-2xx (400, 401, 403, 429 …) — fail silently
      return payload.event_id;
    }

    const data = (await res.json()) as SendEventResponse;
    return data.event_id ?? payload.event_id;
  } catch {
    // INV-TRACKER-007: network error, CORS, parse error → fail silently
    return payload.event_id;
  }
}
