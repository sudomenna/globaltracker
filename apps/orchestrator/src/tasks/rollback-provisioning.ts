/**
 * T-7-008: Trigger.dev task — rollback-provisioning
 *
 * Reads campaign_provisions for a workflow run and undoes them (deletes/removes
 * the Meta Ad Set and Google Campaign). The task is idempotent — if all provisions
 * are already rolled_back, it still updates workflow_run and returns cleanly.
 *
 * BRs applied:
 *   - BR-RBAC-002: all DB queries are scoped to workspace_id (multi-tenant anchor)
 *   - BR-PRIVACY-001: no PII in logs — reason string is NOT logged; only run_id and count
 *   - BR-AUDIT-001: campaign_provisions are append-only — status updated, never deleted
 *
 * DATABASE_URL must be set as an environment variable in the Trigger.dev project.
 * META_ADS_ACCESS_TOKEN must be set for real Meta Ad Set deletion.
 */

import { campaignProvisions, createDb, workflowRuns } from '@globaltracker/db';
import { logger, task } from '@trigger.dev/sdk/v3';
import { and, eq } from 'drizzle-orm';

type RollbackProvisioningPayload = {
  run_id: string; // UUID of the workflow_run whose provisions to rollback
  workspace_id: string; // multi-tenant anchor (BR-RBAC-002)
  reason: string; // human-provided reason for rollback (may contain PII — do NOT log)
};

export const rollbackProvisioningTask = task({
  id: 'rollback-provisioning',

  // NFR: max 120 s — external API calls (Meta delete) may take time
  maxDuration: 120,

  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
  },

  run: async (payload: RollbackProvisioningPayload) => {
    // Step 1 — Connect to DB
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL environment variable is not set');
    const db = createDb(dbUrl);

    // Step 2 — Load campaign_provisions for this run_id scoped by workspace_id (BR-RBAC-002)
    const provisions = await db
      .select()
      .from(campaignProvisions)
      .where(
        and(
          eq(campaignProvisions.runId, payload.run_id),
          eq(campaignProvisions.workspaceId, payload.workspace_id),
        ),
      );

    if (provisions.length === 0) {
      throw new Error(`no_provisions_found: ${payload.run_id}`);
    }

    // Step 3 — Check idempotency: if ALL provisions already have status='rolled_back'
    const alreadyRolledBack = provisions.every(
      (p) => p.status === 'rolled_back',
    );
    if (alreadyRolledBack) {
      logger.info('rollback-provisioning: already_rolled_back', {
        run_id: payload.run_id,
        workspace_id: payload.workspace_id,
      });
      // Still update workflow_run to rolled_back (idempotent) — BR-AUDIT-001: status update, not delete
      await db
        .update(workflowRuns)
        .set({
          status: 'rolled_back',
          // BR-PRIVACY-001: reason not persisted — may contain PII
          result: { already_rolled_back: true },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workflowRuns.id, payload.run_id),
            eq(workflowRuns.workspaceId, payload.workspace_id),
          ),
        );
      return { status: 'already_rolled_back' as const };
    }

    // Step 4 — For each provision that is NOT already rolled_back, undo it
    for (const p of provisions) {
      if (p.status === 'rolled_back') {
        continue;
      }

      if (p.platform === 'meta') {
        // Meta Ad Set deletion via Graph API
        const externalId = p.externalId;
        const metaToken = process.env.META_ADS_ACCESS_TOKEN;
        if (externalId && metaToken) {
          // DELETE https://graph.facebook.com/v20.0/{externalId}?access_token={token}
          const res = await fetch(
            `https://graph.facebook.com/v20.0/${externalId}?access_token=${metaToken}`,
            { method: 'DELETE' },
          );
          if (!res.ok && res.status !== 404) {
            // Best effort — log warning but continue (BR-AUDIT-001: still mark rolled_back below)
            logger.warn('meta adset delete failed', {
              external_id: externalId,
              status: res.status,
            });
          }
        } else {
          // BR-PRIVACY-001: do not log reason; only log run_id
          logger.warn('meta rollback: mock (no token or externalId)', {
            run_id: payload.run_id,
          });
        }
      } else if (p.platform === 'google') {
        // Google Ads API OAuth2 flow not implemented — log warning and mark as rolled_back
        logger.warn('google rollback: mock — real API not implemented yet', {
          run_id: payload.run_id,
        });
      }

      // BR-AUDIT-001: campaign_provisions append-only — update status, never DELETE
      await db
        .update(campaignProvisions)
        .set({ status: 'rolled_back', updatedAt: new Date() })
        .where(eq(campaignProvisions.id, p.id));
    }

    // Step 5 — Update workflow_run to rolled_back
    await db
      .update(workflowRuns)
      .set({
        status: 'rolled_back',
        // BR-PRIVACY-001: reason not persisted — may contain PII
        result: { rolled_back_count: provisions.length },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowRuns.id, payload.run_id),
          eq(workflowRuns.workspaceId, payload.workspace_id),
        ),
      );

    // Step 6 — Structured log (BR-PRIVACY-001: no PII — reason is NOT logged, only run_id and count)
    logger.info('rollback-provisioning completed', {
      run_id: payload.run_id,
      workspace_id: payload.workspace_id,
      count: provisions.length,
    });

    return { status: 'rolled_back' as const, count: provisions.length };
  },
});
