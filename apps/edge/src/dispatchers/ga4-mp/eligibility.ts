/**
 * GA4 MP eligibility check — pure function, no I/O.
 *
 * Validates that a dispatch job satisfies all pre-conditions before
 * any external call is made.
 *
 * T-4-004
 * BR-CONSENT-003: analytics consent must be 'granted' for GA4 MP dispatch.
 * BR-DISPATCH-004: skip_reason is mandatory when not eligible.
 */

import { resolveClientId } from './client-id-resolver.js';
import type { ClientIdUserData } from './client-id-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Consent value per finality (BR-CONSENT-001). */
type ConsentValue = 'granted' | 'denied' | 'unknown';

/** Snapshot embedded in event rows (BR-CONSENT-002). */
export interface ConsentSnapshot {
  analytics?: ConsentValue;
  marketing?: ConsentValue;
  ad_user_data?: ConsentValue;
  ad_personalization?: ConsentValue;
  customer_match?: ConsentValue;
}

/** Minimal event shape required for GA4 eligibility checks. */
export interface Ga4EligibilityEvent {
  consent_snapshot?: ConsentSnapshot | null;
  user_data?: ClientIdUserData | null;
}

/** GA4 integration configuration (Sprint 4: env var; Phase 2: per-workspace). */
export interface Ga4Config {
  /** GA4 Measurement ID (GA4_MEASUREMENT_ID env var). */
  measurementId?: string | null;
  /** GA4 API Secret (GA4_API_SECRET env var). */
  apiSecret?: string | null;
}

/**
 * Reason why a GA4 dispatch job was skipped.
 * BR-DISPATCH-004: skip_reason is mandatory when status='skipped'.
 */
export type Ga4SkipReason =
  | 'consent_denied:analytics'
  | 'integration_not_configured'
  | 'no_client_id';

/** Result of a GA4 eligibility check. */
export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: Ga4SkipReason };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether a GA4 MP dispatch job is eligible to proceed.
 *
 * Pure function — deterministic, no side effects, fully testable.
 *
 * Check order (fail-fast):
 *   1. measurementId configured (GA4_MEASUREMENT_ID)
 *   2. analytics consent == 'granted'  (BR-CONSENT-003)
 *   3. client_id derivable from user_data
 *
 * T-4-004
 * BR-CONSENT-003: ga4_mp requires analytics=granted.
 * BR-DISPATCH-004: every ineligible result carries a mandatory skip_reason.
 *
 * @param event   - event row (or subset) to check
 * @param config  - GA4 integration config (measurementId, apiSecret)
 */
export function checkEligibility(
  event: Ga4EligibilityEvent,
  config: Ga4Config | null | undefined,
): EligibilityResult {
  // Check 1: measurementId must be configured.
  // BR-DISPATCH-004: skip_reason='integration_not_configured' when absent.
  if (!config?.measurementId) {
    return { eligible: false, reason: 'integration_not_configured' };
  }

  // Check 2: analytics consent must be 'granted'.
  // BR-CONSENT-003: ga4_mp requires analytics=granted.
  // BR-DISPATCH-004: skip_reason='consent_denied:analytics' when denied/unknown.
  const analyticsConsent = event.consent_snapshot?.analytics;
  if (analyticsConsent !== 'granted') {
    return { eligible: false, reason: 'consent_denied:analytics' };
  }

  // Check 3: client_id must be derivable from event.user_data.
  // OQ-003 CLOSED: minting from fvid when _ga cookie absent.
  // OQ-012 OPEN: checkout direct without tracker — skip with no_client_id.
  const clientId = resolveClientId(event.user_data);
  if (!clientId) {
    return { eligible: false, reason: 'no_client_id' };
  }

  return { eligible: true };
}
