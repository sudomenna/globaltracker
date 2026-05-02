/**
 * Google Ads Enhanced Conversions eligibility check — pure function, no I/O.
 *
 * Validates ALL pre-conditions before any external call is made.
 * Any single failure → skip (not eligible). There is no retry that can
 * change a structural fact (missing order_id, absent user data, etc.).
 *
 * T-4-006
 * BR-CONSENT-003: ad_user_data must be 'granted' for Enhanced Conversions.
 * BR-DISPATCH-004: skip_reason is mandatory when not eligible.
 */

// ---------------------------------------------------------------------------
// Types
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
  /** Unix timestamp in seconds (or Date/string parseable to seconds). */
  event_time: number | Date | string;
  consent_snapshot?: ConsentSnapshot | null;
  custom_data?: Record<string, unknown> | null;
}

/** Minimal lead shape required for eligibility checks. */
export interface EligibilityLead {
  email_hash?: string | null;
  phone_hash?: string | null;
}

/** Subset of launches.config relevant to Enhanced Conversions. */
export interface EnhancedConversionsLaunchConfig {
  tracking?: {
    google?: {
      conversion_actions?: Record<string, string> | null;
      ads_customer_id?: string | null;
    } | null;
  } | null;
}

/**
 * Canonical skip reasons for Enhanced Conversions.
 * BR-DISPATCH-004: every ineligible result carries a mandatory skip_reason.
 */
export type SkipReason =
  | 'consent_denied:ad_user_data'
  | 'no_order_id'
  | 'no_user_data'
  | 'no_conversion_action_mapped'
  | 'adjustment_window_expired'
  | 'integration_not_configured';

/** Result of an eligibility check. */
export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: SkipReason };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Google policy: adjustment must be within 24h of the original conversion. */
const ADJUSTMENT_WINDOW_SECONDS = 86_400;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalises event_time to Unix seconds regardless of input type.
 */
function toUnixSeconds(eventTime: number | Date | string): number {
  if (typeof eventTime === 'number') return eventTime;
  if (eventTime instanceof Date) return Math.floor(eventTime.getTime() / 1000);
  return Math.floor(new Date(eventTime).getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks whether a Google Enhanced Conversions dispatch job is eligible to proceed.
 *
 * Pure function — deterministic, no side effects, fully testable.
 * nowSeconds is injectable for deterministic testing.
 *
 * T-4-006
 * BR-CONSENT-003: ad_user_data must be 'granted'.
 * BR-DISPATCH-004: every ineligible result carries a mandatory skip_reason.
 *
 * Check order (fail-fast, in strict priority):
 *   1. ads_customer_id configured in launchConfig
 *   2. consent ad_user_data == 'granted'
 *   3. order_id present and non-empty in event.custom_data
 *   4. lead.email_hash OR lead.phone_hash available
 *   5. conversion_action mapped for event.event_name in launchConfig
 *   6. adjustment within 24h of the original conversion
 *
 * @param event        - event row (or subset) to check
 * @param lead         - resolved lead row; null when identity not resolved
 * @param launchConfig - launch configuration with google tracking config
 * @param nowSeconds   - current time in Unix seconds; injectable for tests
 */
export function checkEligibility(
  event: EligibilityEvent & { event_name?: string },
  lead: EligibilityLead | null | undefined,
  launchConfig: EnhancedConversionsLaunchConfig | null | undefined,
  nowSeconds: number = Date.now() / 1000,
): EligibilityResult {
  // Check 1: ads_customer_id must be configured.
  // BR-DISPATCH-004: skip_reason='integration_not_configured' when absent.
  const adsCustomerId = launchConfig?.tracking?.google?.ads_customer_id;
  if (!adsCustomerId) {
    return { eligible: false, reason: 'integration_not_configured' };
  }

  // Check 2: ad_user_data consent must be 'granted'.
  // BR-CONSENT-003: Enhanced Conversions require explicit user data consent.
  // BR-DISPATCH-004: skip_reason='consent_denied:ad_user_data' when denied/unknown/absent.
  const adUserDataConsent = event.consent_snapshot?.ad_user_data;
  if (adUserDataConsent !== 'granted') {
    return { eligible: false, reason: 'consent_denied:ad_user_data' };
  }

  // Check 3: order_id must be present and non-empty.
  // Enhanced Conversion is an adjustment of an original tagged conversion,
  // keyed on order_id. Without it, the Google API cannot find the original.
  // BR-DISPATCH-004: skip_reason='no_order_id' when absent.
  const orderId = event.custom_data?.order_id;
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return { eligible: false, reason: 'no_order_id' };
  }

  // Check 4: at least one hashed user identifier must be available.
  // Google needs em or phone to perform enhanced matching.
  // BR-DISPATCH-004: skip_reason='no_user_data' when neither is present.
  const hasUserData = !!lead?.email_hash || !!lead?.phone_hash;
  if (!hasUserData) {
    return { eligible: false, reason: 'no_user_data' };
  }

  // Check 5: conversion_action must be mapped for this event_name.
  // Without a valid conversion_action resource name, the API call is meaningless.
  // BR-DISPATCH-004: skip_reason='no_conversion_action_mapped' when absent.
  const eventName = (event as { event_name?: string }).event_name ?? '';
  const conversionAction =
    launchConfig?.tracking?.google?.conversion_actions?.[eventName];
  if (!conversionAction || conversionAction.trim() === '') {
    return { eligible: false, reason: 'no_conversion_action_mapped' };
  }

  // Check 6: adjustment must be within 24h of the original conversion.
  // Google policy — adjustments outside this window are rejected.
  // BR-DISPATCH-004: skip_reason='adjustment_window_expired' when outside window.
  const eventTimeSeconds = toUnixSeconds(event.event_time);
  const elapsedSeconds = nowSeconds - eventTimeSeconds;
  if (elapsedSeconds > ADJUSTMENT_WINDOW_SECONDS) {
    return { eligible: false, reason: 'adjustment_window_expired' };
  }

  return { eligible: true };
}
