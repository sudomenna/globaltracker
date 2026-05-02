/**
 * Meta CAPI eligibility check — pure function, no I/O.
 *
 * Validates that a dispatch job satisfies all pre-conditions before
 * any external call is made.
 *
 * T-3-003
 * BR-CONSENT-003: dispatch is blocked when required consent != granted.
 * BR-DISPATCH-004: skip_reason is mandatory when not eligible.
 */

// ---------------------------------------------------------------------------
// Types (inlined here to keep the module self-contained and pure)
// ---------------------------------------------------------------------------

/** Consent value per finality (BR-CONSENT-001). */
type ConsentValue = 'granted' | 'denied' | 'unknown';

/** Snapshot embedded in event rows. */
export interface ConsentSnapshot {
  analytics?: ConsentValue;
  marketing?: ConsentValue;
  ad_user_data?: ConsentValue;
  ad_personalization?: ConsentValue;
  customer_match?: ConsentValue;
}

/** Minimal event shape required for eligibility checks. */
export interface EligibilityEvent {
  consent_snapshot?: ConsentSnapshot | null;
  user_data?: {
    fbc?: string | null;
    fbp?: string | null;
  } | null;
}

/** Minimal lead shape required for eligibility checks. */
export interface EligibilityLead {
  email_hash?: string | null;
  phone_hash?: string | null;
}

/**
 * Subset of launches.config relevant to Meta CAPI.
 * Nested path: config.tracking.meta.pixel_id
 */
export interface MetaLaunchConfig {
  tracking?: {
    meta?: {
      pixel_id?: string | null;
    } | null;
  } | null;
}

/** Reason why a dispatch job was skipped (subset of canonical skip reasons). */
export type SkipReason =
  | 'consent_denied:ad_user_data'
  | 'no_user_data'
  | 'integration_not_configured';

/** Result of an eligibility check. */
export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: SkipReason };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether a Meta CAPI dispatch job is eligible to proceed.
 *
 * Pure function — deterministic, no side effects, fully testable.
 *
 * T-3-003
 * BR-CONSENT-003: ad_user_data must be 'granted' for events with PII.
 * BR-DISPATCH-004: every ineligible result carries a mandatory skip_reason.
 *
 * Check order (fail-fast):
 *   1. pixel_id configured in launchConfig
 *   2. consent ad_user_data == 'granted'
 *   3. at least one user identity signal present
 *
 * @param event       - event row (or subset) to check
 * @param lead        - resolved lead row; null when identity not resolved
 * @param launchConfig - launch configuration containing tracking.meta.pixel_id
 */
export function checkEligibility(
  event: EligibilityEvent,
  lead: EligibilityLead | null | undefined,
  launchConfig: MetaLaunchConfig | null | undefined,
): EligibilityResult {
  // Check 1: pixel_id must be configured in launch config.
  // BR-DISPATCH-004: skip_reason='integration_not_configured' when absent.
  const pixelId = launchConfig?.tracking?.meta?.pixel_id;
  if (!pixelId) {
    return { eligible: false, reason: 'integration_not_configured' };
  }

  // Check 2: ad_user_data consent must be 'granted'.
  // BR-CONSENT-003: Meta CAPI (events with PII) requires ad_user_data granted.
  // BR-DISPATCH-004: skip_reason='consent_denied:ad_user_data' when denied/unknown.
  const adUserDataConsent = event.consent_snapshot?.ad_user_data;
  if (adUserDataConsent !== 'granted') {
    return { eligible: false, reason: 'consent_denied:ad_user_data' };
  }

  // Check 3: at least one identity signal is present.
  // BR-CONSENT-003: Meta requires em, ph, fbc, fbp, or external_id.
  // BR-DISPATCH-004: skip_reason='no_user_data' when no signal available.
  const hasIdentitySignal =
    !!lead?.email_hash ||
    !!lead?.phone_hash ||
    !!event.user_data?.fbc ||
    !!event.user_data?.fbp;

  if (!hasIdentitySignal) {
    return { eligible: false, reason: 'no_user_data' };
  }

  return { eligible: true };
}
