/**
 * Google Customer Match eligibility check.
 *
 * Determines whether a sync job is eligible to call any Google API before
 * any I/O is performed. This is the first guard in processGoogleSyncJob().
 *
 * T-5-006
 *
 * BR-AUDIENCE-001: audiences with destination_strategy='disabled_not_eligible'
 *   MUST NOT call the Google API. This function enforces that invariant as the
 *   primary dispatcher-level gate.
 *
 * INV-AUDIENCE-004: dispatcher blocks the call when strategy resolves to
 *   disabled_not_eligible. Eligibility check runs before any DB mutation or
 *   API call on every invocation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a Google sync eligibility check. */
export interface GoogleEligibilityResult {
  /** Whether this sync job may proceed to call Google API. */
  eligible: boolean;
  /**
   * Human-readable reason when eligible=false.
   * Stored in audience_sync_jobs.error_message for observability.
   */
  reason?: string;
}

// ---------------------------------------------------------------------------
// checkGoogleEligibility
// ---------------------------------------------------------------------------

/**
 * Checks whether a sync job for a Google audience may proceed.
 *
 * Rules evaluated in order:
 *   1. BR-AUDIENCE-001 / INV-AUDIENCE-004: destination_strategy must NOT be
 *      'disabled_not_eligible'. If it is, return ineligible with no API call.
 *   2. platformResourceId must be configured (user list ID is required to
 *      address the Google Customer Match list). Without it we cannot send.
 *
 * @param destinationStrategy - raw value from audiences.destination_strategy
 * @param platformResourceId  - Google user list / customer list ID, or null
 * @returns { eligible, reason? }
 */
export function checkGoogleEligibility(
  destinationStrategy: string,
  platformResourceId: string | null,
): GoogleEligibilityResult {
  // BR-AUDIENCE-001: disabled_not_eligible audiences must never reach the API
  // INV-AUDIENCE-004: dispatcher blocks any call for this strategy
  if (destinationStrategy === 'disabled_not_eligible') {
    return {
      eligible: false,
      reason: 'destination_strategy=disabled_not_eligible',
    };
  }

  // Google Customer Match requires a target user list ID to be configured
  if (!platformResourceId) {
    return {
      eligible: false,
      reason: 'platform_resource_id not configured',
    };
  }

  return { eligible: true };
}
