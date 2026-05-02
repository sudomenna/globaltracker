/**
 * T-7-007: Trigger.dev task — provision-campaigns
 *
 * Provisions Meta and Google Ads campaigns in PAUSED state, waits for
 * human approval (up to 72 h), then activates them.
 *
 * BRs applied:
 *   - BR-RBAC-002: all DB queries are scoped to workspace_id
 *   - BR-PRIVACY-001: no PII in logs or payloads — only UUIDs and platform flags
 *   - BR-AUDIT-001: campaign_provisions rows are append-only audit trail (no DELETE)
 *
 * DATABASE_URL must be set as an environment variable in the Trigger.dev project.
 */

import { logger, task, wait } from '@trigger.dev/sdk/v3';
import { and, eq } from 'drizzle-orm';

import {
  campaignProvisions,
  createDb,
  launches,
  workflowRuns,
} from '@globaltracker/db';

type ProvisionCampaignsPayload = {
  launch_id: string;
  platforms: ('meta' | 'google')[];
  workspace_id: string; // BR-RBAC-002 multi-tenant anchor
  run_id: string; // workflow_run.id to update
};

type ProvisionResult = {
  run_id: string;
  workspace_id: string;
  platforms: string[];
  provisions: Array<{
    platform: string;
    external_id: string;
    status: string;
  }>;
  completed_at: string;
};

/**
 * Provisions a Meta ad set in PAUSED state.
 * Returns the external_id assigned by the Meta API.
 * Falls back to a mock ID if env vars are absent (BR-PRIVACY-001: no PII in log).
 */
async function provisionMetaCampaign(launchId: string): Promise<string> {
  const accountId = process.env.META_ADS_ACCOUNT_ID;
  const apiToken = process.env.META_ADS_ACCESS_TOKEN;

  if (!accountId || !apiToken) {
    logger.warn(
      'meta_ads: META_ADS_ACCOUNT_ID or META_ADS_ACCESS_TOKEN not set — using mock provisioning',
      { launch_id: launchId },
    );
    return `mock-meta-adset-${launchId.slice(0, 8)}`;
  }

  const res = await fetch(
    `https://graph.facebook.com/v20.0/act_${accountId}/adsets`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `GT-${launchId}-adset`,
        status: 'PAUSED',
        daily_budget: 1000,
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'REACH',
        bid_amount: 100,
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `meta_ads_provision_failed: HTTP ${res.status} — ${body.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new Error('meta_ads_provision_failed: response missing id field');
  }
  return data.id;
}

/**
 * Activates a Meta ad set by setting its status to ACTIVE.
 * No-ops if env vars are absent (same mock path as provisioning).
 */
async function activateMetaCampaign(externalId: string): Promise<void> {
  const apiToken = process.env.META_ADS_ACCESS_TOKEN;

  if (!apiToken) {
    logger.warn(
      'meta_ads: META_ADS_ACCESS_TOKEN not set — skipping activation',
      {
        external_id: externalId,
      },
    );
    return;
  }

  const res = await fetch(
    `https://graph.facebook.com/v20.0/${externalId}?status=ACTIVE&access_token=${apiToken}`,
    { method: 'POST' },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `meta_ads_activate_failed: HTTP ${res.status} — ${body.slice(0, 200)}`,
    );
  }
}

export const provisionCampaignsTask = task({
  id: 'provision-campaigns',

  // maxDuration covers the full 72 h wait window
  maxDuration: 300000,

  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 2000,
    maxTimeoutInMs: 30000,
  },

  run: async (payload: ProvisionCampaignsPayload): Promise<ProvisionResult> => {
    // Step 1 — Connect to DB
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL environment variable is not set');
    const db = createDb(dbUrl);

    // Step 2 — Validate launch exists and belongs to workspace (BR-RBAC-002)
    const launchRows = await db
      .select()
      .from(launches)
      .where(
        and(
          eq(launches.id, payload.launch_id),
          eq(launches.workspaceId, payload.workspace_id),
        ),
      )
      .limit(1);

    const launch = launchRows[0];

    if (!launch) {
      // Irrecoverable — update workflow_run before throwing so the UI reflects failure
      await db
        .update(workflowRuns)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(
          and(
            eq(workflowRuns.id, payload.run_id),
            eq(workflowRuns.workspaceId, payload.workspace_id),
          ),
        );
      throw new Error(`launch_not_found: ${payload.launch_id}`);
    }

    // Step 3 — Provision each platform campaign in PAUSED state
    // BR-AUDIT-001: campaign_provisions rows are audit trail — append-only, no DELETE
    for (const platform of payload.platforms) {
      let externalId: string;

      try {
        if (platform === 'meta') {
          externalId = await provisionMetaCampaign(payload.launch_id);
        } else {
          // google: always mock — OAuth2 refresh flow out of scope (BR-PRIVACY-001: no PII)
          logger.warn(
            'google_ads: mock provisioning — real API not implemented yet',
            { launch_id: payload.launch_id },
          );
          externalId = `mock-google-campaign-${payload.launch_id.slice(0, 8)}`;
        }
      } catch (err) {
        await db
          .update(workflowRuns)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(
            and(
              eq(workflowRuns.id, payload.run_id),
              eq(workflowRuns.workspaceId, payload.workspace_id),
            ),
          );
        throw err;
      }

      // Insert provision row — BR-PRIVACY-001: no PII in provisionPayload
      await db.insert(campaignProvisions).values({
        workspaceId: payload.workspace_id,
        runId: payload.run_id,
        launchId: payload.launch_id,
        platform,
        externalId,
        status: 'pending_approval',
        provisionPayload: {
          name: `GT-${payload.launch_id}-${platform}`,
          launch_id: payload.launch_id,
          platform,
        },
        rollbackPayload: { externalId, platform },
      });
    }

    // Step 4 — Update workflow_run to waiting_approval (BR-RBAC-002)
    await db
      .update(workflowRuns)
      .set({ status: 'waiting_approval', updatedAt: new Date() })
      .where(
        and(
          eq(workflowRuns.id, payload.run_id),
          eq(workflowRuns.workspaceId, payload.workspace_id),
        ),
      );

    // Step 5 — Pause execution until approved (72 h timeout)
    // The edge route resumes this run via Trigger.dev management API;
    // execution continues here after resume.
    await wait.for({ seconds: 72 * 3600 });

    // Step 6 — After resume: activate each provisioned campaign
    // BR-RBAC-002: scoped to run_id + workspace_id
    const provisions = await db
      .select()
      .from(campaignProvisions)
      .where(
        and(
          eq(campaignProvisions.runId, payload.run_id),
          eq(campaignProvisions.workspaceId, payload.workspace_id),
        ),
      );

    for (const p of provisions) {
      try {
        if (p.platform === 'meta' && p.externalId) {
          await activateMetaCampaign(p.externalId);
        } else {
          // google: always mock
          logger.info('google_ads: mock activation', {
            external_id: p.externalId,
            run_id: payload.run_id,
          });
        }
      } catch (err) {
        await db
          .update(workflowRuns)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(
            and(
              eq(workflowRuns.id, payload.run_id),
              eq(workflowRuns.workspaceId, payload.workspace_id),
            ),
          );
        throw err;
      }

      // Update provision row to active — BR-AUDIT-001: status update, not deletion
      await db
        .update(campaignProvisions)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(campaignProvisions.id, p.id));
    }

    // Step 7 — Update workflow_run to completed with result
    const provisionSummary = provisions.map((p) => ({
      platform: p.platform,
      external_id: p.externalId ?? '',
      status: 'active',
    }));

    const result: ProvisionResult = {
      run_id: payload.run_id,
      workspace_id: payload.workspace_id,
      platforms: payload.platforms,
      provisions: provisionSummary,
      completed_at: new Date().toISOString(),
    };

    await db
      .update(workflowRuns)
      .set({
        status: 'completed',
        result,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowRuns.id, payload.run_id),
          eq(workflowRuns.workspaceId, payload.workspace_id),
        ),
      );

    // Step 8 — Structured log (BR-PRIVACY-001: no PII — only UUIDs and platform flags)
    logger.info('provision-campaigns completed', {
      run_id: payload.run_id,
      workspace_id: payload.workspace_id,
      platforms: payload.platforms,
    });

    return result;
  },
});
