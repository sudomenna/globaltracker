/**
 * funnel-scaffolder.ts — Scaffolds pages and audiences from a funnel template blueprint.
 *
 * T-FUNIL-011 (Sprint 10)
 *
 * Responsibilities:
 *   1. Fetch funnel_template by slug (global or workspace-scoped) within a transaction.
 *   2. Parse blueprint with FunnelBlueprintSchema (Zod).
 *   3. Insert pages ON CONFLICT (launch_id, public_id) DO NOTHING.
 *   4. Insert audiences ON CONFLICT (workspace_id, public_id) DO NOTHING.
 *   5. UPDATE launches SET funnel_blueprint, funnel_template_id.
 *
 * Idempotency:
 *   ON CONFLICT DO NOTHING on pages and audiences ensures calling this function
 *   twice with the same launchId produces no duplicates.
 *
 * BR-PRIVACY-001: no PII in logs — safeLog only receives non-PII fields.
 * BR-RBAC-002: every query is scoped to workspaceId.
 */

import type { Db } from '@globaltracker/db';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// FunnelBlueprintSchema — local definition (edge does not depend on @globaltracker/shared)
// ---------------------------------------------------------------------------

const FunnelBlueprintPageSchema = z.object({
  /** PageRole: 'capture' | 'sales' | 'thankyou' | 'webinar' | 'checkout' | 'survey' */
  role: z.string().min(1),
  /** Suggested public_id slug. Falls back to `${launchPublicId}-${role}-${idx}` */
  suggested_public_id: z.string().min(1).max(64).optional(),
  /** Funnel role tag (e.g. 'workshop', 'main_offer') — injected into events for stage filters */
  suggested_funnel_role: z.string().min(1).max(64).optional(),
  /** Optional initial event_config partial (merged into page defaults at scaffolding time) */
  event_config: z.record(z.unknown()).optional(),
});

const FunnelBlueprintAudienceSchema = z.object({
  /** Slug used as public_id on insert */
  slug: z.string().min(1).max(64),
  /** Human-readable name */
  name: z.string().min(1),
  /** Platform enum */
  platform: z.enum(['meta', 'google']),
  /** Optional initial query_template partial */
  query_template: z.record(z.unknown()).optional(),
});

const FunnelBlueprintStageSchema = z.object({
  slug: z.string().min(1).max(64),
  label: z.string().optional(),
  is_recurring: z.boolean().default(false),
  source_events: z.array(z.string()).default([]),
  source_event_filters: z.record(z.string()).optional(),
});

const FunnelBlueprintSchema = z.object({
  version: z.string().default('1'),
  pages: z.array(FunnelBlueprintPageSchema).default([]),
  stages: z.array(FunnelBlueprintStageSchema).default([]),
  audiences: z.array(FunnelBlueprintAudienceSchema).default([]),
});

type FunnelBlueprint = z.infer<typeof FunnelBlueprintSchema>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScaffoldLaunchParams {
  /** Template slug — resolved as global (workspace_id IS NULL) or workspace-scoped */
  templateSlug: string;
  /** Internal UUID of the launch */
  launchId: string;
  /** Public slug of the launch — used to derive page public_ids when not provided */
  launchPublicId: string;
  /** Workspace ID for scoping */
  workspaceId: string;
  /** Drizzle DB instance */
  db: Db;
}

export interface ScaffoldLaunchResult {
  pagesCreated: number;
  audiencesCreated: number;
}

/**
 * Scaffold pages and audiences for a launch from a funnel template blueprint.
 *
 * All mutations run inside a single Drizzle transaction for atomicity.
 * Uses raw SQL for ON CONFLICT patterns (Drizzle ORM upsert does not support
 * DO NOTHING across all targets in a single statement without helper).
 *
 * Throws on:
 *   - Template not found (slug/workspace mismatch)
 *   - Invalid blueprint (Zod parse failure)
 *
 * Caller is responsible for error handling — typically via waitUntil + .catch.
 *
 * BR-RBAC-002: all inserts scoped to workspaceId.
 * BR-PRIVACY-001: safeLog receives only non-PII fields.
 */
export async function scaffoldLaunch(
  params: ScaffoldLaunchParams,
): Promise<ScaffoldLaunchResult> {
  const { templateSlug, launchId, launchPublicId, workspaceId, db } = params;

  return db.transaction(async (tx) => {
    // -----------------------------------------------------------------------
    // Step 1: Fetch template blueprint
    // Workspace-scoped template takes priority over system template when both match.
    // BR-RBAC-002: cannot access templates from other workspaces.
    // -----------------------------------------------------------------------
    const templateResult = await tx.execute(
      sql`SELECT id, blueprint
          FROM funnel_templates
          WHERE slug = ${templateSlug}
            AND (workspace_id IS NULL OR workspace_id = ${workspaceId}::uuid)
          ORDER BY workspace_id NULLS LAST
          LIMIT 1`,
    );

    const templateRow = (
      templateResult as unknown as { id: string; blueprint: unknown }[]
    )[0];

    if (!templateRow) {
      throw new Error(
        `[scaffold_launch] Template not found: slug="${templateSlug}" workspace_id="${workspaceId}"`,
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Parse blueprint
    // -----------------------------------------------------------------------
    const blueprintParsed = FunnelBlueprintSchema.safeParse(
      templateRow.blueprint,
    );

    if (!blueprintParsed.success) {
      throw new Error(
        `[scaffold_launch] Invalid blueprint for template "${templateSlug}": ${blueprintParsed.error.message}`,
      );
    }

    const blueprint: FunnelBlueprint = blueprintParsed.data;

    // -----------------------------------------------------------------------
    // Step 3: Insert pages
    // Conflict target: (launch_id, public_id) per INV-PAGE-001 unique constraint.
    // ON CONFLICT DO NOTHING ensures idempotency.
    // -----------------------------------------------------------------------
    let pagesCreated = 0;

    for (let idx = 0; idx < blueprint.pages.length; idx++) {
      const page = blueprint.pages[idx];
      if (!page) continue;

      const publicId =
        page.suggested_public_id ?? `${launchPublicId}-${page.role}-${idx}`;
      const eventConfig = JSON.stringify(page.event_config ?? {});

      const insertResult = await tx.execute(
        sql`INSERT INTO pages (workspace_id, launch_id, public_id, role, event_config, status)
            VALUES (
              ${workspaceId}::uuid,
              ${launchId}::uuid,
              ${publicId},
              ${page.role},
              ${eventConfig}::jsonb,
              'draft'
            )
            ON CONFLICT (launch_id, public_id) DO NOTHING
            RETURNING id`,
      );

      if ((insertResult as unknown[]).length > 0) {
        pagesCreated++;
      }
    }

    safeLog('info', {
      event: 'scaffold_pages_done',
      workspace_id: workspaceId,
      launch_id: launchId,
      pages_created: pagesCreated,
    });

    // -----------------------------------------------------------------------
    // Step 4: Insert audiences
    // Conflict target: (workspace_id, public_id) per INV-AUDIENCE-001.
    // ON CONFLICT DO NOTHING ensures idempotency.
    // Default destination_strategy='disabled_not_eligible' per BR-AUDIENCE-001.
    // -----------------------------------------------------------------------
    let audiencesCreated = 0;

    for (const audience of blueprint.audiences) {
      const queryDefinition = JSON.stringify(audience.query_template ?? {});

      const insertResult = await tx.execute(
        sql`INSERT INTO audiences (workspace_id, public_id, name, platform, destination_strategy, query_definition, status)
            VALUES (
              ${workspaceId}::uuid,
              ${audience.slug},
              ${audience.name},
              ${audience.platform},
              'disabled_not_eligible',
              ${queryDefinition}::jsonb,
              'draft'
            )
            ON CONFLICT (workspace_id, public_id) DO NOTHING
            RETURNING id`,
      );

      if ((insertResult as unknown[]).length > 0) {
        audiencesCreated++;
      }
    }

    safeLog('info', {
      event: 'scaffold_audiences_done',
      workspace_id: workspaceId,
      launch_id: launchId,
      audiences_created: audiencesCreated,
    });

    // -----------------------------------------------------------------------
    // Step 5: Update launch with blueprint snapshot and template FK
    // Blueprint stored as snapshot — changes to template do not affect existing launches.
    // -----------------------------------------------------------------------
    await tx.execute(
      // BR-RBAC-001: workspace isolation — only update launch belonging to authenticated workspace
      sql`UPDATE launches
          SET funnel_blueprint = ${JSON.stringify(blueprint)}::jsonb,
              funnel_template_id = ${templateRow.id}::uuid,
              updated_at = now()
          WHERE id = ${launchId}::uuid
            AND workspace_id = ${workspaceId}::uuid`,
    );

    safeLog('info', {
      event: 'scaffold_launch_done',
      workspace_id: workspaceId,
      launch_id: launchId,
      template_slug: templateSlug,
      pages_created: pagesCreated,
      audiences_created: audiencesCreated,
    });

    return { pagesCreated, audiencesCreated };
  });
}
