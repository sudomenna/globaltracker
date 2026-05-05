/**
 * audience.ts — Audience domain logic (MOD-AUDIENCE).
 *
 * Pure domain functions for audience evaluation, snapshot generation,
 * sync job creation, and advisory lock acquisition.
 *
 * T-5-002: audience core domain
 *
 * INV-AUDIENCE-003: diff is deterministic SET difference between snapshot members.
 * INV-AUDIENCE-005: consent_policy applied before snapshot (BR-AUDIENCE-004).
 * INV-AUDIENCE-006: ≤ 2 snapshots with retention_status='active' per audience.
 * INV-AUDIENCE-007: query_definition validated by AudienceQueryDefinitionSchema.
 * BR-AUDIENCE-002: advisory lock prevents concurrent sync for same audience+platform.
 * BR-AUDIENCE-003: snapshot + members written in a single transaction.
 * BR-AUDIENCE-004: consent_customer_match='granted' filter when required.
 * BR-PRIVACY-001: no PII in logs — only IDs and counts.
 */

import type { AudienceSnapshot, AudienceSyncJob, Db } from '@globaltracker/db';
import {
  audienceSnapshotMembers,
  audienceSnapshots,
  audienceSyncJobs,
  audiences,
  launches,
  leadConsents,
  leadIcpScores,
  leadStages,
  leads,
} from '@globaltracker/db';
import { type SQL, and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Re-export domain types
// ---------------------------------------------------------------------------

export type { AudienceSnapshot, AudienceSyncJob };

// ---------------------------------------------------------------------------
// Context type
// ---------------------------------------------------------------------------

export interface AudienceCtx {
  db: Db;
  workspaceId: string;
}

// ---------------------------------------------------------------------------
// INV-AUDIENCE-007: DSL Zod schema for query_definition
// ---------------------------------------------------------------------------

// BR-AUDIENCE-003: query_definition is a structured DSL — no free-form SQL.
// Each condition object must have at least one field.
//
// T-FUNIL-040: vocabulary expanded to align with funnel_template_paid_workshop_v2
// (migration 0031). Canonical fields are now `stage_eq`, `stage_not`, `stage_gte`.
// Legacy fields `stage` and `not_stage` remain accepted as aliases for retro-compat
// — this preserves existing DB rows and INV-AUDIENCE-003 (snapshotHash determinism)
// for query_definitions written before the expansion.
//
// Semantics:
//   - stage_eq: lead has the named stage in lead_stages (== legacy `stage`).
//   - stage_not: lead does NOT have the named stage (== legacy `not_stage`).
//   - stage_gte: lead has the named stage OR any stage that comes AFTER it in
//     the ordered funnel_blueprint.stages[] of the audience's launch. Requires
//     query_definition.launch_id to resolve the blueprint.
//   - is_icp / purchased: unchanged.
export const AudienceQueryConditionSchema = z
  .object({
    // Canonical (preferred from T-FUNIL-040 forward)
    stage_eq: z.string().optional(),
    stage_not: z.string().optional(),
    stage_gte: z.string().optional(),
    // Legacy aliases (retained for retro-compat — see comment above)
    stage: z.string().optional(),
    not_stage: z.string().optional(),
    // Other predicates (unchanged)
    is_icp: z.boolean().optional(),
    purchased: z.boolean().optional(),
  })
  .refine(
    (obj) =>
      obj.stage_eq !== undefined ||
      obj.stage_not !== undefined ||
      obj.stage_gte !== undefined ||
      obj.stage !== undefined ||
      obj.not_stage !== undefined ||
      obj.is_icp !== undefined ||
      obj.purchased !== undefined,
    { message: 'condition must have at least one field' },
  );

// INV-AUDIENCE-007: query_definition must be a builder DSL with at least one condition.
//
// `launch_id` (UUID string) is optional at schema level but REQUIRED at runtime
// when any condition uses `stage_gte` — the evaluator resolves the funnel order
// from launches.funnel_blueprint via this id. `launch_public_id` is informative
// only (kept for traceability; not used by the evaluator).
export const AudienceQueryDefinitionSchema = z.object({
  type: z.literal('builder'),
  launch_id: z.string().optional(),
  launch_public_id: z.string().optional(),
  all: z.array(AudienceQueryConditionSchema).min(1),
});

export type AudienceQueryDefinition = z.infer<
  typeof AudienceQueryDefinitionSchema
>;
export type AudienceQueryCondition = z.infer<
  typeof AudienceQueryConditionSchema
>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface AudienceEvalResult {
  memberCount: number;
  snapshotHash: string;
  members: string[]; // lead_ids sorted
}

export type GenerateSnapshotResult =
  | { status: 'created'; snapshot: AudienceSnapshot }
  | { status: 'noop'; existingSnapshotId: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * djb2 hash — derives a 32-bit integer from a string.
 * Used as the advisory lock key for pg_try_advisory_xact_lock.
 *
 * BR-AUDIENCE-002: lock key derived deterministically from (audience_id, platform_resource_id).
 */
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) + hash + str.charCodeAt(i);
    hash |= 0; // force 32-bit int
  }
  return Math.abs(hash);
}

/**
 * Load the ordered list of stage slugs from a launch's funnel_blueprint.
 *
 * T-FUNIL-040: required by `stage_gte` semantics. Reads launches.funnel_blueprint
 * (jsonb, added by migration 0029) and returns blueprint.stages[].slug in the
 * authoring order — this is the canonical ordering of the funnel.
 *
 * Returns null when:
 *   - launch row not found
 *   - funnel_blueprint column is null
 *   - jsonb does not contain a stages[] array (malformed blueprint)
 *
 * BR-PRIVACY-001: launchId is a UUID, no PII.
 *
 * Note: we read only `stages[].slug` (not the full FunnelBlueprintSchema) to
 * avoid coupling this domain helper to packages/shared. A malformed blueprint
 * (missing/non-array stages) returns null and the evaluator surfaces a
 * deterministic error — no silent fallback.
 */
async function loadFunnelStageOrder(
  launchId: string,
  db: Db,
): Promise<string[] | null> {
  // launches.funnel_blueprint may not be reflected in the Drizzle type yet
  // (added by migration 0029) — use sql template, mirroring raw-events-processor.ts.
  let rows: Array<{ funnelBlueprint: unknown }>;
  try {
    rows = await db
      .select({ funnelBlueprint: sql<unknown>`funnel_blueprint` })
      .from(launches)
      .where(eq(launches.id, launchId))
      .limit(1);
  } catch {
    return null;
  }

  const row = rows[0];
  if (!row || row.funnelBlueprint === null || row.funnelBlueprint === undefined) {
    return null;
  }

  // jsonb via sql template can come back as a string in some drivers — parse first.
  const bp =
    typeof row.funnelBlueprint === 'string'
      ? (() => {
          try {
            return JSON.parse(row.funnelBlueprint);
          } catch {
            return null;
          }
        })()
      : row.funnelBlueprint;

  if (
    bp === null ||
    typeof bp !== 'object' ||
    !('stages' in bp) ||
    !Array.isArray((bp as { stages: unknown }).stages)
  ) {
    return null;
  }

  const stages = (bp as { stages: Array<{ slug?: unknown }> }).stages;
  const slugs: string[] = [];
  for (const s of stages) {
    if (s && typeof s === 'object' && typeof s.slug === 'string') {
      slugs.push(s.slug);
    }
  }
  return slugs;
}

/**
 * Compute SHA-256 hash of a string using SubtleCrypto.
 * Returns a hex string.
 *
 * BR-AUDIENCE-003: snapshot_hash is SHA-256 of sorted member IDs joined by comma.
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// evaluateAudience
// ---------------------------------------------------------------------------

/**
 * Evaluate an audience definition and return the set of qualifying lead IDs.
 *
 * INV-AUDIENCE-003: returns deterministic member set given same DB state.
 * INV-AUDIENCE-005 / BR-AUDIENCE-004: consent_policy.require_customer_match
 *   filters out leads without consent_customer_match='granted'.
 * INV-AUDIENCE-007: query_definition parsed and validated via Zod before use.
 *
 * Only leads with status='active' are included (FLOW-05: erased/merged excluded).
 */
export async function evaluateAudience(
  audienceId: string,
  ctx: AudienceCtx,
): Promise<AudienceEvalResult> {
  const { db, workspaceId } = ctx;

  // 1. Load audience record
  const [audience] = await db
    .select()
    .from(audiences)
    .where(
      and(eq(audiences.id, audienceId), eq(audiences.workspaceId, workspaceId)),
    );

  if (!audience) {
    throw new Error(`audience_not_found: ${audienceId}`);
  }

  // INV-AUDIENCE-007: validate query_definition before use
  const parsedDef = AudienceQueryDefinitionSchema.safeParse(
    audience.queryDefinition,
  );
  if (!parsedDef.success) {
    throw new Error(`invalid_query_definition: ${parsedDef.error.message}`);
  }

  const queryDef = parsedDef.data;

  // BR-AUDIENCE-004: parse consent_policy to check require_customer_match
  const consentPolicy =
    (audience.consentPolicy as { require_customer_match?: boolean } | null) ??
    {};
  const requireCustomerMatch = consentPolicy.require_customer_match === true;

  // 2. Build the lead query with dynamic WHERE conditions
  //
  // Each condition in query_definition.all ANDs additional constraints:
  //   {stage_eq: 'X'} | {stage: 'X'}     → EXISTS lead_stages with stage='X'
  //   {stage_not: 'X'} | {not_stage: 'X'}→ NOT EXISTS lead_stages with stage='X'
  //   {stage_gte: 'X'}                   → EXISTS lead_stages with stage IN
  //                                        (X, ...stages after X in funnel_blueprint order)
  //   {is_icp: true}                     → EXISTS lead_icp_scores with is_icp=true
  //   {purchased: true}                  → EXISTS lead_stages with stage='purchased'
  //   {purchased: false}                 → NOT EXISTS lead_stages with stage='purchased'
  //
  // T-FUNIL-040: canonical fields (stage_eq / stage_not / stage_gte) align with
  // the vocabulary written by funnel_template_paid_workshop_v2 (migration 0031).
  // Legacy `stage` / `not_stage` continue to be accepted as aliases.

  // Determine if any condition needs the funnel stage order (only stage_gte does).
  const needsStageOrder = queryDef.all.some(
    (c) => c.stage_gte !== undefined,
  );

  let stageOrder: string[] | null = null;
  if (needsStageOrder) {
    if (!queryDef.launch_id) {
      // INV-AUDIENCE-007: stage_gte requires launch_id to resolve funnel ordering.
      throw new Error(
        'invalid_query_definition: stage_gte requires launch_id at the top of query_definition',
      );
    }
    stageOrder = await loadFunnelStageOrder(queryDef.launch_id, db);
    if (stageOrder === null) {
      // Deterministic failure — do not silently degrade. The dispatcher will
      // mark the sync job as failed and surface to operator.
      throw new Error(
        `invalid_query_definition: funnel_blueprint not loadable for launch_id=${queryDef.launch_id}`,
      );
    }
  }

  // Use SQL fragment array; Drizzle's `and()` accepts SQL<unknown> fragments directly.
  const dynConditions: SQL[] = [];

  for (const condition of queryDef.all) {
    // stage_eq + legacy alias `stage` — both mean "lead has this stage".
    const stageEqVal = condition.stage_eq ?? condition.stage;
    if (stageEqVal !== undefined) {
      dynConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${leadStages} ls
          WHERE ls.lead_id = ${leads.id}
          AND ls.stage = ${stageEqVal}
        )`,
      );
    }

    // stage_not + legacy alias `not_stage` — both mean "lead does NOT have this stage".
    const stageNotVal = condition.stage_not ?? condition.not_stage;
    if (stageNotVal !== undefined) {
      dynConditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM ${leadStages} ls
          WHERE ls.lead_id = ${leads.id}
          AND ls.stage = ${stageNotVal}
        )`,
      );
    }

    // stage_gte — lead has the named stage OR any stage that appears AFTER it in
    // the funnel_blueprint.stages[] order. T-FUNIL-040.
    if (condition.stage_gte !== undefined) {
      const targetStage = condition.stage_gte;
      // stageOrder is non-null here (we checked needsStageOrder above and threw on null).
      const order = stageOrder as string[];
      const idx = order.indexOf(targetStage);
      if (idx === -1) {
        // Stage not part of this launch's funnel — deterministic error so operator can fix
        // the audience query_definition rather than silently returning empty set.
        throw new Error(
          `invalid_query_definition: stage_gte target "${targetStage}" not found in funnel_blueprint stages`,
        );
      }
      const matchingStages = order.slice(idx);
      // Build a parameterised IN list (sql.join keeps each value as a parameter).
      const stagesList = sql.join(
        matchingStages.map((s) => sql`${s}`),
        sql`, `,
      );
      dynConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${leadStages} ls
          WHERE ls.lead_id = ${leads.id}
          AND ls.stage IN (${stagesList})
        )`,
      );
    }

    if (condition.is_icp === true) {
      dynConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${leadIcpScores} icp
          WHERE icp.lead_id = ${leads.id}
          AND icp.is_icp = true
        )`,
      );
    }

    if (condition.purchased === true) {
      dynConditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${leadStages} ls
          WHERE ls.lead_id = ${leads.id}
          AND ls.stage = 'purchased'
        )`,
      );
    } else if (condition.purchased === false) {
      dynConditions.push(
        sql`NOT EXISTS (
          SELECT 1 FROM ${leadStages} ls
          WHERE ls.lead_id = ${leads.id}
          AND ls.stage = 'purchased'
        )`,
      );
    }
  }

  // INV-AUDIENCE-005 / BR-AUDIENCE-004: apply consent filter when required.
  // Checks that the most recent consent record grants consent_customer_match.
  if (requireCustomerMatch) {
    dynConditions.push(
      sql`EXISTS (
        SELECT 1 FROM ${leadConsents} lc
        WHERE lc.lead_id = ${leads.id}
        AND lc.consent_customer_match = 'granted'
        AND lc.ts = (
          SELECT MAX(lc2.ts)
          FROM ${leadConsents} lc2
          WHERE lc2.lead_id = ${leads.id}
        )
      )`,
    );
  }

  // 3. Execute query — base conditions + dynamic conditions via and()
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.workspaceId, workspaceId),
        eq(leads.status, 'active'),
        ...dynConditions,
      ),
    );

  // 4. Sort member IDs deterministically for hash
  const memberIds = rows.map((r) => r.id).sort();

  // BR-AUDIENCE-003: snapshot_hash = sha256(sorted members joined by comma)
  const snapshotHash = await sha256Hex(memberIds.join(','));

  return {
    memberCount: memberIds.length,
    snapshotHash,
    members: memberIds,
  };
}

// ---------------------------------------------------------------------------
// generateSnapshot
// ---------------------------------------------------------------------------

/**
 * Generate a new audience snapshot if the member set has changed.
 *
 * INV-AUDIENCE-003: snapshot is deterministic — same query = same hash.
 * INV-AUDIENCE-006: enforces ≤ 2 active snapshots per audience by archiving older ones.
 * BR-AUDIENCE-003: snapshot + members written in a single transaction.
 *
 * Returns:
 *   {status: 'noop', existingSnapshotId} if hash matches latest snapshot.
 *   {status: 'created', snapshot} if new snapshot was inserted.
 */
export async function generateSnapshot(
  audienceId: string,
  ctx: AudienceCtx,
): Promise<GenerateSnapshotResult> {
  const { db, workspaceId } = ctx;

  // 1. Evaluate audience to get current member set
  const evalResult = await evaluateAudience(audienceId, ctx);

  // 2. Find the most recent snapshot for this audience
  const [latestSnapshot] = await db
    .select()
    .from(audienceSnapshots)
    .where(
      and(
        eq(audienceSnapshots.audienceId, audienceId),
        eq(audienceSnapshots.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(audienceSnapshots.generatedAt))
    .limit(1);

  // BR-AUDIENCE-003: if hash matches latest snapshot, return noop
  if (
    latestSnapshot &&
    latestSnapshot.snapshotHash === evalResult.snapshotHash
  ) {
    return { status: 'noop', existingSnapshotId: latestSnapshot.id };
  }

  // 3. Create new snapshot + members in a transaction
  const newSnapshot = await db.transaction(async (tx) => {
    // 3a. Insert snapshot row
    const [snapshot] = await tx
      .insert(audienceSnapshots)
      .values({
        workspaceId,
        audienceId,
        snapshotHash: evalResult.snapshotHash,
        memberCount: evalResult.memberCount,
        retentionStatus: 'active',
      })
      .returning();

    if (!snapshot) {
      throw new Error('snapshot_insert_failed');
    }

    // 3b. Batch insert snapshot members
    if (evalResult.members.length > 0) {
      // Insert in chunks of 1000 to avoid query size limits
      const chunkSize = 1000;
      for (let i = 0; i < evalResult.members.length; i += chunkSize) {
        const chunk = evalResult.members.slice(i, i + chunkSize);
        await tx.insert(audienceSnapshotMembers).values(
          chunk.map((leadId) => ({
            snapshotId: snapshot.id,
            leadId,
          })),
        );
      }
    }

    // INV-AUDIENCE-006: enforce ≤ 2 active snapshots per audience.
    // Archive any active snapshots beyond the 2 most recent.
    const activeSnapshots = await tx
      .select({ id: audienceSnapshots.id })
      .from(audienceSnapshots)
      .where(
        and(
          eq(audienceSnapshots.audienceId, audienceId),
          eq(audienceSnapshots.retentionStatus, 'active'),
        ),
      )
      .orderBy(desc(audienceSnapshots.generatedAt));

    if (activeSnapshots.length > 2) {
      const toArchive = activeSnapshots.slice(2).map((s) => s.id);
      await tx
        .update(audienceSnapshots)
        .set({ retentionStatus: 'archived' })
        .where(inArray(audienceSnapshots.id, toArchive));
    }

    return snapshot;
  });

  return { status: 'created', snapshot: newSnapshot };
}

// ---------------------------------------------------------------------------
// createSyncJob
// ---------------------------------------------------------------------------

/**
 * Create an audience sync job with planned additions and removals.
 *
 * INV-AUDIENCE-003: diff is calculated as SET difference between snapshot members
 *   using SQL EXCEPT (deterministic and computed in the database).
 * BR-AUDIENCE-003: planned_additions and planned_removals computed before job creation.
 *
 * @param audienceId      - audience to sync
 * @param snapshotId      - current (T) snapshot
 * @param prevSnapshotId  - previous (T-1) snapshot; null for first sync
 * @param ctx             - AudienceCtx with db and workspaceId
 */
export async function createSyncJob(
  audienceId: string,
  snapshotId: string,
  prevSnapshotId: string | null,
  ctx: AudienceCtx,
): Promise<AudienceSyncJob> {
  const { db, workspaceId } = ctx;

  let plannedAdditions: number;
  let plannedRemovals: number;

  if (prevSnapshotId === null) {
    // First sync: all current members are additions, no removals
    const [countRow] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(audienceSnapshotMembers)
      .where(eq(audienceSnapshotMembers.snapshotId, snapshotId));

    plannedAdditions = countRow?.count ?? 0;
    plannedRemovals = 0;
  } else {
    // INV-AUDIENCE-003: diff via SQL SET difference (EXCEPT)
    //
    // additions = members in snapshotId BUT NOT in prevSnapshotId
    const [additionsRow] = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT lead_id FROM audience_snapshot_members WHERE snapshot_id = ${snapshotId}
        EXCEPT
        SELECT lead_id FROM audience_snapshot_members WHERE snapshot_id = ${prevSnapshotId}
      ) AS additions
    `);

    // removals = members in prevSnapshotId BUT NOT in snapshotId
    const [removalsRow] = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*)::int AS count
      FROM (
        SELECT lead_id FROM audience_snapshot_members WHERE snapshot_id = ${prevSnapshotId}
        EXCEPT
        SELECT lead_id FROM audience_snapshot_members WHERE snapshot_id = ${snapshotId}
      ) AS removals
    `);

    plannedAdditions = Number(additionsRow?.count ?? 0);
    plannedRemovals = Number(removalsRow?.count ?? 0);
  }

  // Insert sync job with pending status
  const [job] = await db
    .insert(audienceSyncJobs)
    .values({
      workspaceId,
      audienceId,
      snapshotId,
      prevSnapshotId,
      status: 'pending',
      plannedAdditions,
      plannedRemovals,
    })
    .returning();

  if (!job) {
    throw new Error('sync_job_insert_failed');
  }

  return job;
}

// ---------------------------------------------------------------------------
// acquireSyncLock
// ---------------------------------------------------------------------------

/**
 * Acquire a Postgres advisory transaction-scoped lock for the given audience+platform.
 *
 * BR-AUDIENCE-002 / INV-AUDIENCE-002: prevents concurrent sync jobs for the same
 *   (audience_id, platform_resource_id) combination.
 *
 * Lock is scoped to the current transaction — caller MUST be inside a transaction.
 * Lock is automatically released on transaction commit or rollback.
 *
 * @param audienceId         - audience being synced
 * @param platformResourceId - platform-side resource identifier (e.g. Meta audience ID)
 * @param db                 - Drizzle db client (should be a transaction context)
 */
export async function acquireSyncLock(
  audienceId: string,
  platformResourceId: string | null,
  db: Db,
): Promise<{ acquired: boolean }> {
  // BR-AUDIENCE-002: derive numeric key deterministically from (audience_id, platform_resource_id)
  const lockKey = djb2(`${audienceId}|${platformResourceId ?? 'default'}`);

  const [row] = await db.execute<{ pg_try_advisory_xact_lock: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(${lockKey}::bigint)`,
  );

  const acquired = row?.pg_try_advisory_xact_lock === true;

  return { acquired };
}

// ---------------------------------------------------------------------------
// listActiveAudiences — helper for cron
// ---------------------------------------------------------------------------

/**
 * List all active audiences for a given workspace.
 * Used by the audience-sync cron to iterate audiences.
 */
export async function listActiveAudiences(workspaceId: string, db: Db) {
  return db
    .select()
    .from(audiences)
    .where(
      and(
        eq(audiences.workspaceId, workspaceId),
        eq(audiences.status, 'active'),
      ),
    );
}

/**
 * List workspaces that have at least one active audience.
 * Used by the audience-sync cron to iterate workspaces.
 */
export async function listWorkspacesWithActiveAudiences(db: Db) {
  const rows = await db
    .selectDistinct({ workspaceId: audiences.workspaceId })
    .from(audiences)
    .where(eq(audiences.status, 'active'));

  return rows.map((r) => r.workspaceId);
}

/**
 * Find the second most recent snapshot for an audience
 * (the "previous" snapshot when creating a sync job after generateSnapshot).
 */
export async function findPreviousSnapshot(
  audienceId: string,
  currentSnapshotId: string,
  db: Db,
): Promise<AudienceSnapshot | null> {
  const snapshots = await db
    .select()
    .from(audienceSnapshots)
    .where(
      and(
        eq(audienceSnapshots.audienceId, audienceId),
        ne(audienceSnapshots.id, currentSnapshotId),
      ),
    )
    .orderBy(desc(audienceSnapshots.generatedAt))
    .limit(1);

  return snapshots[0] ?? null;
}
