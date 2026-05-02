/**
 * Google Ads Enhanced Conversions dispatcher — public API.
 *
 * Re-exports all public symbols for the google-enhanced-conversions dispatcher module.
 *
 * T-4-006
 *
 * Idempotency key (BR-DISPATCH-001 / ADR-013):
 *   sha256(workspace_id|event_id|google_enhancement|customer_id|conversion_action)
 *   subresource = conversion_action
 */

// OAuth helper
export {
  refreshAccessToken,
  type OAuthConfig,
} from './oauth.js';

// Mapper (pure)
export {
  mapEventToEnhancedConversion,
  type DispatchableEvent,
  type DispatchableLead,
  type EnhancedConversionsLaunchConfig,
  type EnhancedConversionPayload,
  type GoogleUserIdentifier,
} from './mapper.js';

// Eligibility
export {
  checkEligibility,
  type ConsentSnapshot,
  type EligibilityEvent,
  type EligibilityLead,
  type EligibilityResult,
  type SkipReason,
} from './eligibility.js';

// Client
export {
  sendEnhancedConversion,
  classifyGoogleEnhancedError,
  type GoogleEnhancedConversionsConfig,
  type GoogleAdsResult,
} from './client.js';
