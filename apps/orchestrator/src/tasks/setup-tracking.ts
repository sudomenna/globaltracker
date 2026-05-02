/**
 * T-7-005: Trigger.dev task — setup-tracking
 *
 * Validates that a page + launch are correctly configured for tracking.
 * Checks:
 *   - INV-LAUNCH-003: pixel_policy declared in launch.config.tracking.meta
 *   - INV-PAGE-004: at least one active page_token exists for the page
 *   - INV-PAGE-006: page.event_config is a non-null object
 *
 * BRs applied:
 *   - BR-RBAC-002: all DB queries are scoped to workspace_id
 *   - BR-PRIVACY-001: no PII persisted in logs or result — only UUIDs and flags
 *
 * DATABASE_URL must be set as an environment variable in the Trigger.dev project.
 */

import {
  createDb,
  launches,
  pageTokens,
  pages,
  workflowRuns,
} from '@globaltracker/db';
import { logger, task } from '@trigger.dev/sdk/v3';
import { and, eq } from 'drizzle-orm';

// INV-LAUNCH-003: pixel_policy values valid for a live launch
const VALID_PIXEL_POLICIES = [
  'server_only',
  'browser_and_server_managed',
  'coexist_with_existing_pixel',
] as const;

type ValidPixelPolicy = (typeof VALID_PIXEL_POLICIES)[number];

// Shape of launch.config expected by INV-LAUNCH-003
interface LaunchTrackingConfig {
  tracking?: {
    meta?: {
      pixel_policy?: string;
    };
  };
}

export type SetupTrackingPayload = {
  page_id: string; // UUID interno da page
  launch_id: string; // UUID interno do launch
  workspace_id: string; // UUID do workspace — BR-RBAC-002 multi-tenant anchor
  run_id: string; // UUID do workflow_run a atualizar com resultado
};

export type SetupTrackingResult = {
  page_id: string;
  launch_id: string;
  has_active_token: boolean;
  pixel_policy: ValidPixelPolicy | null;
  event_config_valid: boolean;
  validated_at: string;
};

export const setupTrackingTask = task({
  id: 'setup-tracking',

  // NFR: max 60 s — DB queries + validation should complete well under this limit
  maxDuration: 60,

  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10000,
  },

  run: async (payload: SetupTrackingPayload): Promise<SetupTrackingResult> => {
    // Step 1 — Connect to DB
    // DATABASE_URL must be set in Trigger.dev project environment variables
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('DATABASE_URL environment variable is not set');
    const db = createDb(dbUrl);

    // Step 2 — Fetch Page (BR-RBAC-002: scoped to workspace_id)
    const pageRows = await db
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.id, payload.page_id),
          eq(pages.workspaceId, payload.workspace_id),
        ),
      )
      .limit(1);

    const page = pageRows[0];

    if (!page) {
      // Irrecoverable error — update workflow_run before throwing so the UI reflects failure
      await db
        .update(workflowRuns)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(
          and(
            eq(workflowRuns.id, payload.run_id),
            eq(workflowRuns.workspaceId, payload.workspace_id),
          ),
        );
      throw new Error(`page_not_found: ${payload.page_id}`);
    }

    // Step 2 — Fetch Launch (BR-RBAC-002: scoped to workspace_id)
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
      // Irrecoverable error — update workflow_run before throwing
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

    // Step 3 — Validate INV-LAUNCH-003: pixel_policy must be declared before going live
    const launchConfig = launch.config as LaunchTrackingConfig | null;
    const rawPixelPolicy = launchConfig?.tracking?.meta?.pixel_policy;
    const isValidPixelPolicy = (v: string | undefined): v is ValidPixelPolicy =>
      v !== undefined &&
      (VALID_PIXEL_POLICIES as readonly string[]).includes(v);

    const pixelPolicy: ValidPixelPolicy | null = isValidPixelPolicy(
      rawPixelPolicy,
    )
      ? rawPixelPolicy
      : null;

    if (!pixelPolicy) {
      // INV-LAUNCH-003: missing pixel_policy — warning only (may be configured later)
      // The task does NOT fail here; caller is responsible for gating the launch
      logger.warn(
        'setup-tracking: INV-LAUNCH-003 — pixel_policy missing or invalid',
        {
          run_id: payload.run_id,
          workspace_id: payload.workspace_id,
          raw_pixel_policy: rawPixelPolicy ?? null,
        },
      );
    }

    // Step 3 — Validate INV-PAGE-006: event_config must be a non-null object
    const eventConfigValid = page.eventConfig != null;
    if (!eventConfigValid) {
      logger.warn(
        'setup-tracking: INV-PAGE-006 — event_config is null/undefined',
        {
          run_id: payload.run_id,
          workspace_id: payload.workspace_id,
        },
      );
    }

    // Step 4 — Verify active page_token (INV-PAGE-004)
    const activeTokenRows = await db
      .select()
      .from(pageTokens)
      .where(
        and(
          eq(pageTokens.pageId, payload.page_id),
          eq(pageTokens.workspaceId, payload.workspace_id),
          eq(pageTokens.status, 'active'),
        ),
      )
      .limit(1);

    const hasActiveToken = activeTokenRows.length > 0;

    // Step 5 — Persist result to workflow_runs (BR-PRIVACY-001: no PII — only UUIDs + flags)
    const validationResult: SetupTrackingResult = {
      page_id: payload.page_id,
      launch_id: payload.launch_id,
      has_active_token: hasActiveToken,
      pixel_policy: pixelPolicy,
      event_config_valid: eventConfigValid,
      validated_at: new Date().toISOString(),
    };

    await db
      .update(workflowRuns)
      .set({
        status: 'completed',
        result: validationResult,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflowRuns.id, payload.run_id),
          eq(workflowRuns.workspaceId, payload.workspace_id),
        ),
      );

    // Step 6 — Structured log (BR-PRIVACY-001: no PII — UUIDs are opaque identifiers)
    logger.info('setup-tracking completed', {
      run_id: payload.run_id,
      workspace_id: payload.workspace_id,
      has_active_token: hasActiveToken,
      event_config_valid: eventConfigValid,
      pixel_policy_present: pixelPolicy !== null,
    });

    return validationResult;
  },
});
