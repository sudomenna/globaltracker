/**
 * Google Customer Match strategy selector.
 *
 * Translates an audience's destination_strategy string into one of the three
 * Google sync strategies understood by this dispatcher.
 *
 * T-5-006
 *
 * ADR-012: strategy selection is conditional — workspaces created before the
 *   Google 2026 allowlist cutoff use 'ads_api'; post-cutoff workspaces use
 *   'data_manager'. A workspace that is neither allowlisted nor configured
 *   maps to 'disabled'.
 *
 * BR-AUDIENCE-001: 'disabled_not_eligible' destinations MUST NOT call any
 *   external Google API. Enforced by checkGoogleEligibility() and the
 *   processGoogleSyncJob() guard in index.ts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Three possible sync strategies for a Google audience destination.
 *
 * - 'data_manager'  — uses the upcoming Google Data Manager API (post-2026 default)
 * - 'ads_api'       — uses the Google Ads OfflineUserDataJob API (legacy allowlisted)
 * - 'disabled'      — no external call; audience treated as not eligible
 */
export type GoogleSyncStrategy = 'data_manager' | 'ads_api' | 'disabled';

// ---------------------------------------------------------------------------
// selectGoogleStrategy
// ---------------------------------------------------------------------------

/**
 * Maps a raw destination_strategy value to a typed GoogleSyncStrategy.
 *
 * ADR-012: only two Google strategies produce an active sync. Any other value
 * (including 'disabled_not_eligible', 'meta_custom_audience', or unknown
 * strings) maps to 'disabled'.
 *
 * BR-AUDIENCE-001: callers that receive 'disabled' MUST NOT call Google API.
 *
 * @param destinationStrategy - raw value from audiences.destination_strategy
 * @returns the resolved GoogleSyncStrategy
 */
export function selectGoogleStrategy(
  destinationStrategy: string,
): GoogleSyncStrategy {
  // ADR-012: strategy condicional Google
  switch (destinationStrategy) {
    case 'google_data_manager':
      return 'data_manager';
    case 'google_ads_api_allowlisted':
      return 'ads_api';
    default:
      // BR-AUDIENCE-001: 'disabled_not_eligible' and unknown values → no API call
      return 'disabled';
  }
}
