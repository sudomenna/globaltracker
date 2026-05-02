/**
 * Meta Custom Audience sync job processor.
 *
 * Entry point for dispatching an audience_sync_job to Meta's Custom
 * Audiences API. Handles lock acquisition, eligibility check, diff
 * computation, batching, and job status updates.
 *
 * T-5-005
 *
 * BR-AUDIENCE-001 / INV-AUDIENCE-004: audiences with destination_strategy=
 *   'disabled_not_eligible' MUST NOT call the Meta API. Handled here.
 * BR-AUDIENCE-002: acquireSyncLock() must be held before any API call.
 * BR-AUDIENCE-003: diff (additions/removals) already computed by createSyncJob;
 *   we derive actual lead_ids by SET difference in SQL.
 * BR-PRIVACY-002: only email_hash / phone_hash transmitted — no PII in clear.
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
import { batchMembers } from './batcher.js';
import { MetaAudienceError, MetaCustomAudienceClient } from './client.js';
import { buildMetaPayload } from './mapper.js';

// ---------------------------------------------------------------------------
// Env type
// ---------------------------------------------------------------------------

export interface MetaAudienceSyncEnv {
  /** Meta Ads API token with ads_management permission. */
  META_CUSTOM_AUDIENCE_TOKEN: string;
  /** Default Meta ad account ID (format: act_<number>). */
  META_DEFAULT_AD_ACCOUNT_ID: string;
}

// ---------------------------------------------------------------------------
// Backoff helper
// ---------------------------------------------------------------------------

/** Compute retry backoff in seconds for a given attempt index (0-based). */
function retryBackoffSeconds(attempt: number): number {
  // 60s, 120s, 240s with small jitter
  const base = 60 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 15);
  return base + jitter;
}

// ---------------------------------------------------------------------------
// processMetaSyncJob
// ---------------------------------------------------------------------------

/**
 * Process a pending audience_sync_job for the Meta platform.
 *
 * Steps:
 *  1. Load job; validate status='pending'.
 *  2. Mark status='processing'.
 *  3. Load audience; check destination_strategy (INV-AUDIENCE-004).
 *  4. Acquire advisory lock (BR-AUDIENCE-002).
 *  5. Compute diff (additions / removals) via SQL SET difference.
 *  6. Fetch leads for each set → build MetaMember lists.
 *  7. Batch + call addMembers / removeMembers.
 *  8. Update job to status='succeeded'.
 *  9. On MetaAudienceError: update to 'failed' with correct retry schedule.
 *
 * @param syncJobId - UUID of the audience_sync_job to process.
 * @param env       - environment variables (META_CUSTOM_AUDIENCE_TOKEN, etc.).
 * @param db        - Drizzle database client.
 */
export async function processMetaSyncJob(
  syncJobId: string,
  env: MetaAudienceSyncEnv,
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
    // Already processed or currently being processed by another worker.
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
  // 3. Load audience + check destination_strategy (INV-AUDIENCE-004)
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

  // BR-AUDIENCE-001 / INV-AUDIENCE-004: disabled_not_eligible → noop, no API call
  if (audience.destinationStrategy === 'disabled_not_eligible') {
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
  // 4. Acquire advisory lock (BR-AUDIENCE-002)
  // -------------------------------------------------------------------------
  // Lock must be inside a transaction for pg_try_advisory_xact_lock semantics.
  // We wrap the entire sync operation in a transaction to ensure the lock is
  // held for the duration and released on commit/rollback.
  try {
    await db.transaction(async (tx) => {
      // BR-AUDIENCE-002: acquire lock — prevents concurrent syncs for same audience+resource
      const { acquired } = await acquireSyncLock(
        job.audienceId,
        job.platformResourceId ?? null,
        tx,
      );

      if (!acquired) {
        // Lock contention — requeue for retry in 60s without marking as failed
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
      // 5. Compute diff via SQL SET difference (BR-AUDIENCE-003)
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
        // INV-AUDIENCE-003: diff via SQL EXCEPT (deterministic SET difference)
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
      // 6. Fetch lead hashes (BR-PRIVACY-002: only transmit hashes)
      // -----------------------------------------------------------------------
      const toMetaMembers = async (leadIds: string[]) => {
        if (leadIds.length === 0) return [];
        const rows = await tx
          .select({
            id: leads.id,
            emailHash: leads.emailHash,
            phoneHash: leads.phoneHash,
          })
          .from(leads)
          .where(inArray(leads.id, leadIds));

        return rows.map((r) => ({
          emailHash: r.emailHash,
          phoneHash: r.phoneHash,
        }));
      };

      const additionMembers = await toMetaMembers(additionIds);
      const removalMembers = await toMetaMembers(removalIds);

      // -----------------------------------------------------------------------
      // 7. Batch + send to Meta API
      // -----------------------------------------------------------------------
      const platformResourceId = job.platformResourceId ?? audience.publicId;

      const client = new MetaCustomAudienceClient(
        env.META_CUSTOM_AUDIENCE_TOKEN,
        env.META_DEFAULT_AD_ACCOUNT_ID,
      );

      let totalAdditions = 0;
      let totalRemovals = 0;

      // Send addition batches
      for (const batch of batchMembers(additionMembers)) {
        const payload = buildMetaPayload(batch);
        const result = await client.addMembers(platformResourceId, payload);
        totalAdditions += result.numReceived;
      }

      // Send removal batches
      for (const batch of batchMembers(removalMembers)) {
        const payload = buildMetaPayload(batch);
        const result = await client.removeMembers(platformResourceId, payload);
        totalRemovals += result.numReceived;
      }

      // -----------------------------------------------------------------------
      // 8. Mark succeeded
      // -----------------------------------------------------------------------
      await tx
        .update(audienceSyncJobs)
        .set({
          status: 'succeeded',
          sentAdditions: totalAdditions,
          sentRemovals: totalRemovals,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(audienceSyncJobs.id, syncJobId));
    });
  } catch (err) {
    // -------------------------------------------------------------------------
    // 9. Error handling
    // -------------------------------------------------------------------------
    if (err instanceof MetaAudienceError) {
      if (err.retryable) {
        // BR-DISPATCH-003: retryable error → schedule next attempt
        const backoffSeconds = retryBackoffSeconds(0);
        await markFailed(
          db,
          syncJobId,
          err.code,
          err.message,
          true,
          new Date(Date.now() + backoffSeconds * 1_000),
        );
      } else {
        // Permanent failure (e.g. INVALID_PARAMETER)
        await markFailed(db, syncJobId, err.code, err.message, false);
      }
    } else {
      // Unexpected error — treat as retryable to avoid silent loss
      const message = err instanceof Error ? err.message : String(err);
      await markFailed(
        db,
        syncJobId,
        'INTERNAL_ERROR',
        message,
        true,
        new Date(Date.now() + 60_000),
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
        ? (nextAttemptAt ?? new Date(Date.now() + 60_000))
        : null,
      updatedAt: new Date(),
    })
    .where(eq(audienceSyncJobs.id, syncJobId));
}
