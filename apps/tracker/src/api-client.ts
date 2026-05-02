/**
 * API client stubs for /v1/config and /v1/events.
 *
 * Onda 1: fetchConfig is wired; track/page event sending is a stub (Onda 2).
 * INV-TRACKER-007: failure in /v1/config degrades silently — catch always returns null.
 *
 * Contract: docs/30-contracts/05-api-server-actions.md
 */

import type { TrackerConfig } from './types';

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
 * Stub: POST /v1/events
 * Implemented in Onda 2 (T-2-004+).
 * Returns a noop promise to keep callers consistent.
 */
export async function sendEvent(
  _siteToken: string,
  _payload: Record<string, unknown>,
  _baseUrl = '',
): Promise<void> {
  // Stub — Onda 2 implements full event sending
  return Promise.resolve();
}
