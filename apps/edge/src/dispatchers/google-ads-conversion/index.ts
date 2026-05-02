/**
 * Google Ads Conversion Upload dispatcher — public API.
 *
 * Re-exports all public symbols for the google-ads-conversion dispatcher module.
 *
 * T-4-005
 *
 * Idempotency key (BR-DISPATCH-001 / ADR-013):
 *   sha256(workspace_id|event_id|google_ads_conversion|customer_id|conversion_action)
 *   destination_subresource = conversion_action
 */

// OAuth helper (T-4-005)
export {
  refreshAccessToken,
  type OAuthConfig,
} from './oauth.js';

// Mapper (T-4-005)
export {
  formatConversionDateTime,
  mapEventToConversionUpload,
  type ConversionUploadEvent,
  type ConversionUploadPayload,
  type EventAttribution,
  type GoogleAdsLaunchConfig,
} from './mapper.js';

// Eligibility (T-4-005)
export {
  checkEligibility,
  type ConsentSnapshot,
  type EligibilityAttribution,
  type EligibilityEvent,
  type EligibilityResult,
  type GoogleAdsEligibilityConfig,
  type SkipReason,
} from './eligibility.js';

// Client (T-4-005)
export {
  classifyGoogleAdsError,
  sendConversionUpload,
  type GoogleAdsConfig,
  type GoogleAdsResult,
} from './client.js';
