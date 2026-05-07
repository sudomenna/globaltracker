/**
 * GA4 client_id resolver — pure functions, no I/O.
 *
 * Resolves the GA4 client_id from event user_data, following the priority
 * defined in docs/40-integrations/06-ga4-measurement-protocol.md (OQ-003 CLOSED).
 *
 * Extended with the 4-level cascade that closes OQ-012 (T-16-002A): self →
 * sibling (same lead, earlier event) → cross-lead (same workspace, same
 * phone/email hash, earlier event) → deterministic mint from
 * (workspace_id, lead_id). DB lookups happen in the caller; this module
 * remains pure and only consumes already-fetched user_data records.
 *
 * T-4-004 / T-16-002A
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

/** Length of the first numeric segment in a GA4 client_id. */
const GA4_SEGMENT1_LENGTH = 8;

/** Length of the second numeric segment in a GA4 client_id. */
const GA4_SEGMENT2_LENGTH = 10;

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

  const segment1 = padded.slice(0, GA4_SEGMENT1_LENGTH);
  const segment2 = padded.slice(
    GA4_SEGMENT1_LENGTH,
    GA4_SEGMENT1_LENGTH + GA4_SEGMENT2_LENGTH,
  );

  return `${GA4_CLIENT_ID_PREFIX}.${segment1}.${segment2}`;
}

// ---------------------------------------------------------------------------
// OQ-012 closure — 4-level cascade resolver (T-16-002A)
// ---------------------------------------------------------------------------

/**
 * Input shape for the cascading resolver.
 *
 * The caller (buildGa4DispatchFn) is responsible for performing the DB
 * lookups (sibling event of the same lead with received_at < current event;
 * cross-lead event matched by phone/email_hash_external) and feeding the
 * already-parsed user_data records here. This keeps the resolver pure.
 */
export interface ResolverInput {
  /** user_data of the event being dispatched. */
  user_data: ClientIdUserData | null | undefined;
  /** user_data of an earlier sibling event of the same lead, if any. */
  sibling_user_data?: ClientIdUserData | null;
  /**
   * user_data of an earlier event linked to a different lead in the same
   * workspace that shares phone_hash_external or email_hash_external.
   */
  cross_lead_user_data?: ClientIdUserData | null;
  /** lead_id of the event — required to mint the deterministic fallback. */
  lead_id?: string | null;
  /** workspace_id of the event — required to mint the deterministic fallback. */
  workspace_id: string;
}

/** Source level that produced the resolved client_id. */
export type ResolverSource =
  | 'self'
  | 'sibling'
  | 'cross_lead'
  | 'deterministic'
  | 'unresolved';

/** Result of the cascade resolution. */
export interface ResolverResult {
  client_id: string | null;
  source: ResolverSource;
}

/**
 * Resolves the GA4 client_id using the 4-level cascade defined in OQ-012:
 *
 *   1. self          — resolveClientId(event.user_data)
 *   2. sibling       — resolveClientId(earlier event of same lead)
 *   3. cross_lead    — resolveClientId(earlier event of different lead with
 *                      matching phone/email hash in same workspace)
 *   4. deterministic — SHA-256(workspace_id:lead_id) → GA1.1.<8d>.<10d>,
 *                      same shape as mintClientIdFromFvid for GA4 consistency
 *
 * Skip ('unresolved') only happens when lead_id is absent — extremely rare,
 * since GA4 dispatches are gated on having a lead.
 *
 * BR-CONSENT-004 still applies upstream (analytics consent gate).
 *
 * T-16-002A — closes OQ-012 (Alternative D: deterministic minted as final
 * fallback, ensuring every dispatch with a lead reaches GA4 with stable
 * cross-event continuity).
 */
export async function resolveClientIdExtended(
  input: ResolverInput,
): Promise<ResolverResult> {
  // Level 1: self
  const self = resolveClientId(input.user_data);
  if (self) return { client_id: self, source: 'self' };

  // Level 2: sibling (same lead, earlier event)
  const sibling = resolveClientId(input.sibling_user_data ?? null);
  if (sibling) return { client_id: sibling, source: 'sibling' };

  // Level 3: cross_lead (same workspace, matching phone/email hash, earlier event)
  const crossLead = resolveClientId(input.cross_lead_user_data ?? null);
  if (crossLead) return { client_id: crossLead, source: 'cross_lead' };

  // Level 4: deterministic — only viable when lead_id is present.
  if (input.lead_id) {
    const deterministic = await mintDeterministicClientId(
      input.workspace_id,
      input.lead_id,
    );
    return { client_id: deterministic, source: 'deterministic' };
  }

  // No lead_id → cannot derive a stable id. Caller should skip with
  // skip_reason='no_client_id_unresolvable'.
  return { client_id: null, source: 'unresolved' };
}

/**
 * Mints a deterministic GA4-compatible client_id from (workspace_id, lead_id).
 *
 * OQ-012 closure — deterministic fallback. The same lead_id always produces
 * the same client_id, preserving cross-event continuity in GA4 (Purchase and
 * subsequent events for the lead share a single GA4 user, even if the
 * shopper never loaded the LP and tracker.js never ran).
 *
 * Format: GA1.1.<8 digits>.<10 digits> — same shape as mintClientIdFromFvid
 * for internal consistency.
 *
 * Implementation: SHA-256("<workspace_id>:<lead_id>"), then take two uint32
 * windows from the digest and zero-pad/slice to the segment lengths.
 */
async function mintDeterministicClientId(
  workspaceId: string,
  leadId: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${workspaceId}:${leadId}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const view = new DataView(digest);

  const u32a = view.getUint32(0);
  const u32b = view.getUint32(4);

  const segment1 = u32a
    .toString()
    .padStart(GA4_SEGMENT1_LENGTH, '0')
    .slice(0, GA4_SEGMENT1_LENGTH);
  const segment2 = u32b
    .toString()
    .padStart(GA4_SEGMENT2_LENGTH, '0')
    .slice(0, GA4_SEGMENT2_LENGTH);

  return `${GA4_CLIENT_ID_PREFIX}.${segment1}.${segment2}`;
}
