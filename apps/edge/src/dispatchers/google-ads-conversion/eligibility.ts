/**
 * Google Ads Conversion Upload eligibility check — pure function, no I/O.
 *
 * Validates all pre-conditions before any external API call is made.
 *
 * T-4-005
 * BR-CONSENT-003: dispatch blocked when ad_user_data != 'granted'.
 * BR-DISPATCH-004: skip_reason is mandatory when not eligible.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Consent value per finality (BR-CONSENT-001). */
type ConsentValue = 'granted' | 'denied' | 'unknown';

/** Consent snapshot embedded in event rows. */
export interface ConsentSnapshot {
  analytics?: ConsentValue;
  marketing?: ConsentValue;
  ad_user_data?: ConsentValue;
  ad_personalization?: ConsentValue;
  customer_match?: ConsentValue;
}

/** Attribution data carrying click IDs. */
export interface EligibilityAttribution {
  gclid?: string | null;
  gbraid?: string | null;
  wbraid?: string | null;
}

/** Minimal event shape required for eligibility checks. */
export interface EligibilityEvent {
  consent_snapshot?: ConsentSnapshot | null;
  attribution?: EligibilityAttribution | null;
  event_name: string;
}

/** Subset of launch config required for eligibility. */
export interface GoogleAdsEligibilityConfig {
  tracking?: {
    google?: {
      ads_customer_id?: string | null;
      conversion_actions?: Record<string, string> | null;
    } | null;
  } | null;
}

/** Canonical skip reasons for Google Ads Conversion Upload. */
export type SkipReason =
  | 'consent_denied:ad_user_data'
  | 'no_click_id_available'
  | 'no_conversion_action_mapped'
  | 'integration_not_configured';

/** Result of an eligibility check. */
export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: SkipReason };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether a Google Ads Conversion Upload dispatch job is eligible to
 * proceed.
 *
 * Pure function — deterministic, no side effects, fully testable.
 *
 * T-4-005
 * BR-CONSENT-003: ad_user_data must be 'granted'.
 * BR-DISPATCH-004: every ineligible result carries a mandatory skip_reason.
 *
 * Check order (fail-fast):
 *   1. consent ad_user_data == 'granted'
 *   2. gclid OR gbraid OR wbraid present in event.attribution
 *   3. conversion_action mapped in launchConfig for event.event_name
 *   4. ads_customer_id configured
 *
 * @param event        - event row (or subset) to check
 * @param launchConfig - launch configuration containing google tracking settings
 */
export function checkEligibility(
  event: EligibilityEvent,
  launchConfig: GoogleAdsEligibilityConfig | null | undefined,
): EligibilityResult {
  // Check 1: ad_user_data consent must be 'granted'.
  // BR-CONSENT-003: Google Ads Conversion Upload requires ad_user_data granted.
  // BR-DISPATCH-004: skip_reason='consent_denied:ad_user_data' when denied/unknown.
  const adUserDataConsent = event.consent_snapshot?.ad_user_data;
  if (adUserDataConsent !== 'granted') {
    return { eligible: false, reason: 'consent_denied:ad_user_data' };
  }

  // Check 2: at least one click ID must be present.
  // BR-DISPATCH-004: skip_reason='no_click_id_available' when all absent.
  const attr = event.attribution;
  const hasClickId = !!(attr?.gclid || attr?.gbraid || attr?.wbraid);
  if (!hasClickId) {
    return { eligible: false, reason: 'no_click_id_available' };
  }

  // Check 3: conversion_action must be mapped for this event_name.
  // BR-DISPATCH-004: skip_reason='no_conversion_action_mapped' when absent.
  const conversionAction =
    launchConfig?.tracking?.google?.conversion_actions?.[event.event_name];
  if (!conversionAction) {
    return { eligible: false, reason: 'no_conversion_action_mapped' };
  }

  // Check 4: ads_customer_id must be configured.
  // BR-DISPATCH-004: skip_reason='integration_not_configured' when absent.
  const customerId = launchConfig?.tracking?.google?.ads_customer_id;
  if (!customerId) {
    return { eligible: false, reason: 'integration_not_configured' };
  }

  return { eligible: true };
}
