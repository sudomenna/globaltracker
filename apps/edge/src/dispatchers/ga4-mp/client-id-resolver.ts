/**
 * GA4 client_id resolver — pure function, no I/O.
 *
 * Resolves the GA4 client_id from event user_data, following the priority
 * defined in docs/40-integrations/06-ga4-measurement-protocol.md (OQ-003 CLOSED).
 *
 * T-4-004
 * BR-CONSENT-004: __fvid is only set when consent_analytics=granted;
 *   therefore a present fvid implies consent has been captured at tracker time.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal user_data shape required for client_id resolution. */
export interface ClientIdUserData {
  /**
   * GA4 client_id extracted from the `_ga` cookie by tracker.js.
   * Format: GA1.<n>.<clientId> — tracker.js extracts only the clientId part.
   * If tracker.js passes the full cookie value, this resolver uses it verbatim.
   */
  client_id_ga4?: string | null;

  /**
   * Raw `_ga` cookie value, format `GA1.1.<client_id>.<timestamp>`.
   * The resolver extracts the `<client_id>.<timestamp>` portion to form the GA4 client_id.
   */
  _ga?: string | null;

  /**
   * GlobalTracker's own visitor fingerprint cookie value (`__fvid`).
   * Used to derive a GA4-compatible client_id when _ga cookie is unavailable.
   * Expected length: >= 18 characters (alphanumeric); padded with zeros if shorter.
   */
  fvid?: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GA4 cookie format prefix for minted client_ids. */
const GA4_CLIENT_ID_PREFIX = 'GA1.1';

/** Minimum total length needed to extract both numeric segments from fvid. */
const FVID_MIN_PADDED_LENGTH = 18;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves the GA4 client_id for a dispatch payload.
 *
 * Priority order (docs/40-integrations/06-ga4-measurement-protocol.md):
 *   1. event.user_data.client_id_ga4 — extracted from `_ga` cookie by tracker.js
 *   2. Minted from fvid: GA1.1.<fvid[0..8]>.<fvid[8..18]>
 *      (format compatible with GA4 — treated as a browser-side generated id)
 *   3. null — no client_id available; caller MUST skip dispatch (OQ-012)
 *
 * T-4-004
 *
 * @param userData - event.user_data subset
 * @returns string client_id, or null if unresolvable
 */
export function resolveClientId(
  userData: ClientIdUserData | null | undefined,
): string | null {
  if (!userData) return null;

  // Priority 1: client_id already extracted from _ga cookie by tracker.js.
  // Tracker.js is expected to parse "GA1.1.<n>.<n>" and store only the
  // canonical client_id portion, or the full string. We use it verbatim.
  if (userData.client_id_ga4) {
    return userData.client_id_ga4;
  }

  // Priority 2: extract client_id from raw _ga cookie value.
  // Cookie format: GA1.1.<client_id>.<timestamp> — GA4 expects "<client_id>.<timestamp>".
  if (userData._ga) {
    const extracted = extractClientIdFromGaCookie(userData._ga);
    if (extracted) return extracted;
  }

  // Priority 3: mint a GA4-compatible client_id from __fvid.
  // Format: GA1.1.<8 digit segment>.<10 digit segment>
  // OQ-003 CLOSED: trade-off documented in docs/40-integrations/06-ga4-measurement-protocol.md
  if (userData.fvid) {
    return mintClientIdFromFvid(userData.fvid);
  }

  // Priority 4: no client_id derivable.
  // OQ-012 OPEN: checkout direct without tracker coverage.
  return null;
}

/**
 * Extracts the canonical GA4 client_id from a raw `_ga` cookie value.
 * Cookie format: `GA1.1.<client_id>.<timestamp>` (4 segments).
 * GA4 client_id is `<client_id>.<timestamp>` (last 2 segments joined).
 */
function extractClientIdFromGaCookie(ga: string): string | null {
  const parts = ga.split('.');
  if (parts.length < 4) return null;
  const clientId = parts[parts.length - 2];
  const timestamp = parts[parts.length - 1];
  if (!clientId || !timestamp) return null;
  return `${clientId}.${timestamp}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Mints a GA4-compatible client_id from a __fvid string.
 *
 * Format: GA1.1.<fvid[0..8]>.<fvid[8..18]>
 * If fvid is shorter than 18 characters, it is right-padded with zeros.
 *
 * @param fvid - raw __fvid cookie value
 * @returns GA4-compatible client_id string
 */
function mintClientIdFromFvid(fvid: string): string {
  // Right-pad with zeros if needed to guarantee extraction of both segments.
  const padded =
    fvid.length >= FVID_MIN_PADDED_LENGTH
      ? fvid
      : fvid.padEnd(FVID_MIN_PADDED_LENGTH, '0');

  const segment1 = padded.slice(0, 8);
  const segment2 = padded.slice(8, 18);

  return `${GA4_CLIENT_ID_PREFIX}.${segment1}.${segment2}`;
}
