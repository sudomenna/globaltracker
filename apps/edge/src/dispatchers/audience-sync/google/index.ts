/**
 * Google Customer Match audience sync job processor.
 *
 * Entry point for dispatching an audience_sync_job to Google using the
 * Customer Match pathway. Supports two strategies (ADR-012):
 *   - 'data_manager'  — Data Manager API (stub; spec TBD)
 *   - 'ads_api'       — Google Ads OfflineUserDataJob API (legacy allowlisted)
 *
 * T-5-006
 *
 * BR-AUDIENCE-001 / INV-AUDIENCE-004: disabled_not_eligible → noop (no API call).
 *   Enforced by checkGoogleEligibility() before any DB mutation or API call.
 * BR-AUDIENCE-002: acquireSyncLock() must be held before any Google API call.
 *   Lock acquired inside transaction to ensure release on commit/rollback.
 * BR-AUDIENCE-003: diff (additions/removals) computed via SQL SET difference.
 * BR-PRIVACY-002: only email_hash / phone_hash transmitted — no PII in clear.
 * ADR-012: auto-demote to disabled_not_eligible on CUSTOMER_NOT_ALLOWLISTED error.
 */

import type { Db } from '@globaltracker/db';
import {
  audienceSnapshotMembers,
  audienceSyncJobs,
  audiences,
  leads,
} from '@globaltracker/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { acquireSyncLock } from '../../../lib/audience.js';
import {
  GoogleAdsCustomerMatchClient,
  GoogleAdsCustomerMatchError,
} from './ads-api-client.js';
import type { GoogleMember } from './ads-api-client.js';
import { syncWithDataManager } from './data-manager-client.js';
import { checkGoogleEligibility } from './eligibility.js';
import { selectGoogleStrategy } from './strategy.js';

// ---------------------------------------------------------------------------
// Env type
// ---------------------------------------------------------------------------

/** Cloudflare Workers env bindings required for Google Customer Match sync. */
export interface GoogleAudienceSyncEnv {
  /** Google Ads Customer ID (without dashes, e.g. "1234567890"). */
  GOOGLE_ADS_CUSTOMER_ID: string;
  /** Google Ads Developer Token (header: developer-token). */
  GOOGLE_ADS_DEVELOPER_TOKEN: string;
  /** OAuth2 client_id for token refresh. */
  GOOGLE_ADS_CLIENT_ID: string;
  /** OAuth2 client_secret for token refresh. */
  GOOGLE_ADS_CLIENT_SECRET: string;
  /** Long-lived OAuth2 refresh_token. */
  GOOGLE_ADS_REFRESH_TOKEN: string;
}

// ---------------------------------------------------------------------------
// Backoff helper (BR-DISPATCH-003)
// ---------------------------------------------------------------------------

/**
 * Compute exponential backoff with jitter for retry scheduling.
 *
 * BR-DISPATCH-003: retryable errors → backoff with jitter.
 *
 * @param attempt - zero-based attempt index
 * @returns backoff in milliseconds
 */
function retryBackoffMs(attempt: number): number {
  const baseSeconds = 60 * 2 ** attempt; // 60s, 120s, 240s ...
  const jitterSeconds = Math.floor(Math.random() * 15);
  return (baseSeconds + jitterSeconds) * 1_000;
}

// ---------------------------------------------------------------------------
// processGoogleSyncJob — main entry point
// ---------------------------------------------------------------------------

/**
 * Process a pending audience_sync_job for the Google platform.
 *
 * Steps:
 *  1. Load job; validate status='pending'.
 *  2. Mark status='processing'.
 *  3. Eligibility check (INV-AUDIENCE-004 / BR-AUDIENCE-001).
 *  4. Select strategy (ADR-012).
 *  5. Acquire advisory lock (BR-AUDIENCE-002).
 *  6. Compute diff via SQL SET difference (BR-AUDIENCE-003).
 *  7. Fetch lead hashes (BR-PRIVACY-002: only hashes transmitted).
 *  8a. 'data_manager': call stub → mark succeeded with 0 counts.
 *  8b. 'ads_api': call GoogleAdsCustomerMatchClient.
 *       - On CUSTOMER_NOT_ALLOWLISTED: auto-demote audience + mark job failed.
 *       - On other retryable errors: schedule next_attempt_at with backoff.
 *       - On success: mark job succeeded.
 *
 * @param syncJobId - UUID of the audience_sync_job to process.
 * @param env       - Google Ads environment variables.
 * @param db        - Drizzle database client.
 */
export async function processGoogleSyncJob(
  syncJobId: string,
  env: GoogleAudienceSyncEnv,
  db: Db,
): Promise<void> {
  // -------------------------------------------------------------------------
  // 1. Load job
  // -------------------------------------------------------------------------
  const [job] = await db
    .select()
    .from(audienceSyncJobs)
    .where(eq(audienceSyncJobs.id, syncJobId));

  if (!job) {
    throw new Error(`audience_sync_job_not_found: ${syncJobId}`);
  }

  if (job.status !== 'pending') {
    // Already processed or being processed by another worker — idempotent exit
    return;
  }

  // -------------------------------------------------------------------------
  // 2. Mark processing
  // -------------------------------------------------------------------------
  await db
    .update(audienceSyncJobs)
    .set({ status: 'processing', startedAt: new Date(), updatedAt: new Date() })
    .where(eq(audienceSyncJobs.id, syncJobId));

  // -------------------------------------------------------------------------
  // 3. Load audience
  // -------------------------------------------------------------------------
  const [audience] = await db
    .select()
    .from(audiences)
    .where(eq(audiences.id, job.audienceId));

  if (!audience) {
    await markFailed(
      db,
      syncJobId,
      'AUDIENCE_NOT_FOUND',
      'audience not found',
      false,
    );
    return;
  }

  // -------------------------------------------------------------------------
  // 3a. Eligibility check (BR-AUDIENCE-001 / INV-AUDIENCE-004)
  //
  // Must run before any API call. If ineligible, mark as succeeded with
  // zero counts per BR-AUDIENCE-001 — the noop path is a valid terminal state.
  // -------------------------------------------------------------------------
  const eligibility = checkGoogleEligibility(
    audience.destinationStrategy,
    job.platformResourceId ?? null,
  );

  if (!eligibility.eligible) {
    // BR-AUDIENCE-001 / INV-AUDIENCE-004: no API call, record noop result
    await db
      .update(audienceSyncJobs)
      .set({
        status: 'succeeded',
        sentAdditions: 0,
        sentRemovals: 0,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(audienceSyncJobs.id, syncJobId));
    return;
  }

  // -------------------------------------------------------------------------
  // 4. Select strategy (ADR-012)
  // -------------------------------------------------------------------------
  const strategy = selectGoogleStrategy(audience.destinationStrategy);

  // 'disabled' from selectGoogleStrategy should not be reachable here because
  // checkGoogleEligibility already handled disabled_not_eligible. However, if
  // destinationStrategy has an unknown value, be defensive.
  if (strategy === 'disabled') {
    await db
      .update(audienceSyncJobs)
      .set({
        status: 'succeeded',
        sentAdditions: 0,
        sentRemovals: 0,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(audienceSyncJobs.id, syncJobId));
    return;
  }

  // -------------------------------------------------------------------------
  // 5–8: Everything inside a transaction so the advisory lock (step 5) is
  //      scoped to the transaction (pg_try_advisory_xact_lock semantics).
  // BR-AUDIENCE-002: lock held for duration of API operation.
  // -------------------------------------------------------------------------
  try {
    await db.transaction(async (tx) => {
      // -----------------------------------------------------------------------
      // 5. Acquire advisory lock (BR-AUDIENCE-002)
      // -----------------------------------------------------------------------
      const { acquired } = await acquireSyncLock(
        job.audienceId,
        job.platformResourceId ?? null,
        tx,
      );

      if (!acquired) {
        // Lock contention — requeue for retry without marking as failed
        await tx
          .update(audienceSyncJobs)
          .set({
            status: 'pending',
            startedAt: null,
            nextAttemptAt: new Date(Date.now() + 60_000),
            updatedAt: new Date(),
          })
          .where(eq(audienceSyncJobs.id, syncJobId));
        return;
      }

      // -----------------------------------------------------------------------
      // 6. Compute diff via SQL SET difference (BR-AUDIENCE-003)
      // -----------------------------------------------------------------------
      let additionIds: string[];
      let removalIds: string[];

      if (job.prevSnapshotId === null) {
        // First sync — all current members are additions
        const members = await tx
          .select({ leadId: audienceSnapshotMembers.leadId })
          .from(audienceSnapshotMembers)
          .where(eq(audienceSnapshotMembers.snapshotId, job.snapshotId));

        additionIds = members.map((m) => m.leadId);
        removalIds = [];
      } else {
        // INV-AUDIENCE-003: deterministic SET difference
        const addRows = await tx.execute<{ lead_id: string }>(sql`
          SELECT lead_id FROM audience_snapshot_members WHERE snapshot_id = ${job.snapshotId}
          EXCEPT
          SELECT lead_id FROM audience_snapshot_members WHERE snapshot_id = ${job.prevSnapshotId}
        `);

        const removeRows = await tx.execute<{ lead_id: string }>(sql`
          SELECT lead_id FROM audience_snapshot_members WHERE snapshot_id = ${job.prevSnapshotId}
          EXCEPT
          SELECT lead_id FROM audience_snapshot_members WHERE snapshot_id = ${job.snapshotId}
        `);

        additionIds = addRows.map((r) => r.lead_id);
        removalIds = removeRows.map((r) => r.lead_id);
      }

      // -----------------------------------------------------------------------
      // 7. Fetch lead hashes (BR-PRIVACY-002: only hashes, never PII in clear)
      // -----------------------------------------------------------------------
      const toGoogleMembers = async (
        leadIds: string[],
      ): Promise<GoogleMember[]> => {
        if (leadIds.length === 0) return [];
        const rows = await tx
          .select({
            id: leads.id,
            emailHash: leads.emailHash,
            phoneHash: leads.phoneHash,
          })
          .from(leads)
          .where(inArray(leads.id, leadIds));

        // BR-IDENTITY-002: hashes already normalized — pass through directly
        return rows.map((r) => ({
          hashedEmail: r.emailHash,
          hashedPhoneNumber: r.phoneHash,
        }));
      };

      const additionMembers = await toGoogleMembers(additionIds);
      const removalMembers = await toGoogleMembers(removalIds);

      // platformResourceId is guaranteed non-null at this point: checkGoogleEligibility
      // returned eligible=true only when platformResourceId is a non-empty string.
      const userListId = job.platformResourceId ?? '';

      // -----------------------------------------------------------------------
      // 8a. Data Manager strategy — stub
      // ADR-012: stub returns 0 counts until Google publishes API spec
      // -----------------------------------------------------------------------
      if (strategy === 'data_manager') {
        const result = await syncWithDataManager(
          userListId,
          additionMembers,
          removalMembers,
        );

        await tx
          .update(audienceSyncJobs)
          .set({
            status: 'succeeded',
            sentAdditions: result.sentAdditions,
            sentRemovals: result.sentRemovals,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(audienceSyncJobs.id, syncJobId));
        return;
      }

      // -----------------------------------------------------------------------
      // 8b. Ads API strategy — OfflineUserDataJob
      // ADR-012: legacy allowlisted path
      // -----------------------------------------------------------------------
      const client = new GoogleAdsCustomerMatchClient({
        customerId: env.GOOGLE_ADS_CUSTOMER_ID,
        developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
        clientId: env.GOOGLE_ADS_CLIENT_ID,
        clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
        refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
      });

      if (additionMembers.length > 0) {
        await client.addMembers(userListId, additionMembers);
      }

      if (removalMembers.length > 0) {
        await client.removeMembers(userListId, removalMembers);
      }

      await tx
        .update(audienceSyncJobs)
        .set({
          status: 'succeeded',
          sentAdditions: additionMembers.length,
          sentRemovals: removalMembers.length,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(audienceSyncJobs.id, syncJobId));
    });
  } catch (err) {
    // -------------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------------
    if (err instanceof GoogleAdsCustomerMatchError) {
      if (err.isNotAllowlisted) {
        // ADR-012 / FLOW-05 §A2: auto-demote audience to disabled_not_eligible
        await db
          .update(audiences)
          .set({
            destinationStrategy: 'disabled_not_eligible',
            autoDemotedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(audiences.id, job.audienceId));

        // Job is permanently failed — no retry
        await markFailed(
          db,
          syncJobId,
          'CUSTOMER_NOT_ALLOWLISTED',
          err.message,
          false, // not retryable
        );
      } else if (err.retryable) {
        // BR-DISPATCH-003: transient error → schedule retry with backoff+jitter
        await markFailed(
          db,
          syncJobId,
          err.code,
          err.message,
          true,
          new Date(Date.now() + retryBackoffMs(0)),
        );
      } else {
        // Permanent failure (credential error, permission denied, etc.)
        await markFailed(db, syncJobId, err.code, err.message, false);
      }
    } else {
      // Unexpected error — retryable to avoid silent loss
      const message = err instanceof Error ? err.message : String(err);
      await markFailed(
        db,
        syncJobId,
        'INTERNAL_ERROR',
        message,
        true,
        new Date(Date.now() + retryBackoffMs(0)),
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function markFailed(
  db: Db,
  syncJobId: string,
  errorCode: string,
  errorMessage: string,
  retryable: boolean,
  nextAttemptAt?: Date,
): Promise<void> {
  await db
    .update(audienceSyncJobs)
    .set({
      status: 'failed',
      errorCode,
      errorMessage,
      finishedAt: retryable ? undefined : new Date(),
      nextAttemptAt: retryable
        ? (nextAttemptAt ?? new Date(Date.now() + retryBackoffMs(0)))
        : null,
      updatedAt: new Date(),
    })
    .where(eq(audienceSyncJobs.id, syncJobId));
}
