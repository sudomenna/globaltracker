/**
 * Audience Sync dispatcher — platform router.
 *
 * Single entry point for processing audience_sync_jobs.
 * Routes to the correct platform adapter based on audience.platform.
 *
 * T-5-005 (meta routing)
 * T-5-006 will add the google routing below the meta case.
 *
 * BR-AUDIENCE-001 / INV-AUDIENCE-004: disabled_not_eligible check is
 *   delegated to each platform adapter (meta/index.ts, google/index.ts).
 * BR-AUDIENCE-002: advisory lock is acquired inside each platform adapter.
 */

import type { Db } from '@globaltracker/db';
import { audienceSyncJobs, audiences } from '@globaltracker/db';
import { eq } from 'drizzle-orm';

import type { GoogleAudienceSyncEnv } from './google/index.js';
import { processGoogleSyncJob } from './google/index.js';
import type { MetaAudienceSyncEnv } from './meta/index.js';
import { processMetaSyncJob } from './meta/index.js';

// ---------------------------------------------------------------------------
// Orchestrator env type
//
// Union of all platform env shapes. T-5-006 added Google env fields.
// ---------------------------------------------------------------------------

export type AudienceSyncOrchestratorEnv = MetaAudienceSyncEnv &
  GoogleAudienceSyncEnv;

// ---------------------------------------------------------------------------
// processSyncJob — main entry point
// ---------------------------------------------------------------------------

/**
 * Route an audience_sync_job to the correct platform adapter.
 *
 * @param syncJobId - UUID of the audience_sync_job.
 * @param env       - orchestrator env (union of all platform envs).
 * @param db        - Drizzle database client.
 */
export async function processSyncJob(
  syncJobId: string,
  env: AudienceSyncOrchestratorEnv,
  db: Db,
): Promise<void> {
  // Load job to find audienceId
  const [job] = await db
    .select()
    .from(audienceSyncJobs)
    .where(eq(audienceSyncJobs.id, syncJobId));

  if (!job) {
    throw new Error(`sync_job_not_found: ${syncJobId}`);
  }

  // Load audience to determine platform
  const [audience] = await db
    .select()
    .from(audiences)
    .where(eq(audiences.id, job.audienceId));

  if (!audience) {
    throw new Error(`audience_not_found: ${job.audienceId}`);
  }

  // Route by platform
  if (audience.platform === 'meta') {
    return processMetaSyncJob(syncJobId, env, db);
  }

  // T-5-006: Google Customer Match routing (ADR-012)
  if (audience.platform === 'google') {
    return processGoogleSyncJob(syncJobId, env, db);
  }

  throw new Error(`unsupported_platform: ${audience.platform}`);
}
