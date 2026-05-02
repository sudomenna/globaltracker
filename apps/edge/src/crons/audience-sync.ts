/**
 * audience-sync.ts — Daily audience snapshot + sync job cron.
 *
 * For each active audience across all workspaces:
 *   1. Generate a snapshot (evaluateAudience → generateSnapshot).
 *   2. If snapshot is new (not noop), create an audience_sync_jobs row
 *      with planned additions/removals via SET difference.
 *   3. Audiences with destination_strategy='disabled_not_eligible' still generate
 *      a snapshot for historical tracking, but do NOT create a sync job.
 *
 * The actual API calls to Meta/Google are handled by the dispatcher layer (T-5-005/T-5-006).
 * This cron only writes DB rows — no external HTTP calls.
 *
 * Cron expression: 0 1 * * *  (01:00 UTC daily)
 * T-5-002: audience cron implementation
 *
 * BR-AUDIENCE-001: disabled_not_eligible → no sync job created.
 * BR-AUDIENCE-003: snapshot + diff calculated in domain layer.
 * BR-AUDIENCE-004: consent filter applied inside evaluateAudience.
 * BR-PRIVACY-001: safeLog used throughout — no PII in logs.
 */

import type { Db } from '@globaltracker/db';

import {
  createSyncJob,
  findPreviousSnapshot,
  generateSnapshot,
  listActiveAudiences,
  listWorkspacesWithActiveAudiences,
} from '../lib/audience.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env type (no platform creds needed — dispatchers handle those in Onda 2)
// ---------------------------------------------------------------------------

// No env vars specific to this cron — API credentials live in dispatchers.
export type AudienceSyncEnv = Record<string, never>;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the audience snapshot + sync job generation pass.
 *
 * Never throws at the top level — errors per audience are isolated and logged.
 * Failure on one audience does not block the others.
 *
 * @param _env - Env bindings (reserved for future creds — currently unused)
 * @param db   - Drizzle DB client injected from the scheduled handler
 */
export async function runAudienceSync(
  _env: AudienceSyncEnv,
  db: Db,
): Promise<void> {
  // 1. Find all workspaces that have at least one active audience
  let workspaceIds: string[];
  try {
    workspaceIds = await listWorkspacesWithActiveAudiences(db);
  } catch (err) {
    safeLog('error', {
      event: 'audience_sync_workspace_list_failed',
      error_type: err instanceof Error ? err.constructor.name : 'unknown',
    });
    return;
  }

  safeLog('info', {
    event: 'audience_sync_started',
    workspace_count: workspaceIds.length,
  });

  let totalSnapshots = 0;
  let totalNoops = 0;
  let totalJobs = 0;
  let totalErrors = 0;

  // 2. Process each workspace
  for (const workspaceId of workspaceIds) {
    let audienceList: Awaited<ReturnType<typeof listActiveAudiences>>;
    try {
      audienceList = await listActiveAudiences(workspaceId, db);
    } catch (err) {
      safeLog('error', {
        event: 'audience_sync_list_failed',
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
      totalErrors++;
      continue;
    }

    safeLog('info', {
      event: 'audience_sync_workspace_processing',
      workspace_id: workspaceId,
      audience_count: audienceList.length,
    });

    // 3. Process each audience — errors isolated per audience
    for (const audience of audienceList) {
      try {
        const ctx = { db, workspaceId };

        // 3a. Generate snapshot (evaluates audience + writes snapshot+members if changed)
        const snapshotResult = await generateSnapshot(audience.id, ctx);

        if (snapshotResult.status === 'noop') {
          // No change in audience — skip sync job creation
          totalNoops++;
          safeLog('info', {
            event: 'audience_snapshot_noop',
            audience_id: audience.id,
            workspace_id: workspaceId,
            existing_snapshot_id: snapshotResult.existingSnapshotId,
          });
          continue;
        }

        totalSnapshots++;
        const { snapshot } = snapshotResult;

        safeLog('info', {
          event: 'audience_snapshot_created',
          audience_id: audience.id,
          workspace_id: workspaceId,
          snapshot_id: snapshot.id,
          member_count: snapshot.memberCount,
        });

        // BR-AUDIENCE-001: audiences with destination_strategy='disabled_not_eligible'
        // generate a snapshot for historical tracking but do NOT create a sync job.
        if (audience.destinationStrategy === 'disabled_not_eligible') {
          safeLog('info', {
            event: 'audience_sync_skipped_disabled',
            audience_id: audience.id,
            workspace_id: workspaceId,
            destination_strategy: audience.destinationStrategy,
          });
          continue;
        }

        // 3b. Find previous snapshot for diff calculation
        const prevSnapshot = await findPreviousSnapshot(
          audience.id,
          snapshot.id,
          db,
        );

        // 3c. Create sync job with planned additions/removals
        const job = await createSyncJob(
          audience.id,
          snapshot.id,
          prevSnapshot?.id ?? null,
          ctx,
        );

        totalJobs++;
        safeLog('info', {
          event: 'audience_sync_job_created',
          audience_id: audience.id,
          workspace_id: workspaceId,
          sync_job_id: job.id,
          snapshot_id: snapshot.id,
          prev_snapshot_id: prevSnapshot?.id ?? null,
          planned_additions: job.plannedAdditions,
          planned_removals: job.plannedRemovals,
        });
      } catch (err) {
        // Isolate per-audience errors — do not interrupt other audiences
        totalErrors++;
        safeLog('error', {
          event: 'audience_sync_audience_failed',
          audience_id: audience.id,
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
          error_message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  safeLog('info', {
    event: 'audience_sync_completed',
    total_snapshots_created: totalSnapshots,
    total_noops: totalNoops,
    total_jobs_created: totalJobs,
    total_errors: totalErrors,
  });
}
