/**
 * Google Data Manager API client — STUB.
 *
 * The Data Manager API spec was not publicly available at the time this module
 * was authored (Google announced changes effective 2026-04; detailed API
 * documentation for the replacement endpoint is TBD).
 *
 * T-5-006
 *
 * ADR-012: 'google_data_manager' is the intended default strategy for
 *   workspaces created after the 2026 Google Customer Match cutoff. This stub
 *   is a placeholder that allows the dispatch pipeline to complete without
 *   error so that sync jobs can be marked succeeded with zero sent counts.
 *   A real implementation will replace this when Google publishes the spec.
 *
 * BR-AUDIENCE-001: stubs must not pretend to have sent members — sentAdditions
 *   and sentRemovals are always 0 until the real implementation is in place.
 */

import type { GoogleMember } from './ads-api-client.js';

// Re-export so callers that only need GoogleMember can import from here
export type { GoogleMember };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by the Data Manager sync stub. */
export interface DataManagerSyncResult {
  /** Always 'succeeded' for the stub — no error path while spec is TBD. */
  status: 'succeeded';
  /** Number of member additions sent. 0 until real implementation. */
  sentAdditions: number;
  /** Number of member removals sent. 0 until real implementation. */
  sentRemovals: number;
  /** Human-readable note explaining why counts are 0. */
  note: string;
}

// ---------------------------------------------------------------------------
// syncWithDataManager
// ---------------------------------------------------------------------------

/**
 * Stub for the Google Data Manager API sync operation.
 *
 * Returns a succeeded result with zero counts. The note field documents
 * that this is a stub so dashboards and logs remain honest.
 *
 * ADR-012: real implementation replaces this when Google publishes the
 *   Data Manager API spec for Customer Match (expected 2026).
 *
 * @param _userListId  - Google user list identifier (unused until real impl)
 * @param _additions   - members to add (unused until real impl)
 * @param _removals    - members to remove (unused until real impl)
 * @returns DataManagerSyncResult with status='succeeded' and zero counts
 */
export async function syncWithDataManager(
  _userListId: string,
  _additions: GoogleMember[],
  _removals: GoogleMember[],
): Promise<DataManagerSyncResult> {
  // Data Manager API spec not yet public (TBD per Google 2026 announcement)
  // ADR-012: stub returns succeeded/0 so dispatch pipeline does not stall
  return {
    status: 'succeeded',
    sentAdditions: 0,
    sentRemovals: 0,
    note: 'data_manager_stub_not_implemented',
  };
}
