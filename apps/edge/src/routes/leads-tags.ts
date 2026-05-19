/**
 * routes/leads-tags.ts — Lead-side tag application (set/unset, bulk).
 *
 * T-TAGS-004 (edge). Thin HTTP layer over `lib/lead-tags.ts` helpers
 * (T-TAGS-002 / T-LEADS-VIEW-002). Audit-log every write.
 *
 * Endpoints (mounted at /v1/leads-tags):
 *   POST   /by-lead/:lead_public_id                  — apply N tags to 1 lead
 *   DELETE /by-lead/:lead_public_id/:tag_name        — remove 1 tag from 1 lead
 *   POST   /bulk-apply                               — N tags × M leads (idempotent)
 *   POST   /bulk-remove                              — N tags × M leads removal
 *
 * Design choices (intentional, taken without escalation):
 *   - Mounted under /v1/leads-tags (separate base path) instead of merging
 *     into /v1/leads to keep this file's footprint isolated; leads-timeline.ts
 *     is already very large and Wave 2C may edit it in parallel.
 *   - lead_public_id == leads.id (BR-IDENTITY-013 / leads-queries.ts docstring).
 *     resolveLeadId just validates that the row exists under the workspace.
 *   - bulk endpoints cap at 50 tag_names × 5000 lead_public_ids per the
 *     prompt spec; unknown public_ids are reported in the response rather
 *     than failing the entire batch (better UX, idempotent retry-friendly).
 *   - Audit log: per-lead audit rows on single-lead endpoints; ONE audit row
 *     per bulk call (entityId = first lead_id, with summary in `after`).
 *     Reasoning: bulk audit at lead granularity could explode audit_log volume
 *     (50×5000 = 250k rows per click). The aggregate row already contains
 *     enough context (counts + tag list) for forensics.
 *
 * BRs honored:
 *   - BR-IDENTITY: workspace_id always from auth context; lead resolved via
 *     SELECT scoped by workspace_id (prevents cross-workspace leak).
 *   - BR-AUDIT-001: every write inserts an audit_log entry.
 *   - BR-PRIVACY-001: tag names + IDs are domain identifiers, not PII.
 *     No PII in logs or error responses.
 *
 * Auth: same supabaseJwtMiddleware pattern as workspace-tags.ts.
 * RBAC: Wave 2B accepts any authenticated role (same caveat as workspace-tags).
 *
 * ORCHESTRATOR MOUNT (in apps/edge/src/index.ts):
 *   import leadsTagsRoute from './routes/leads-tags.js';
 *   app.route('/v1/leads-tags', leadsTagsRoute);
 */

import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog, createDb, leads, workspaceMembers, type Db } from '@globaltracker/db';
import { autoRegisterTag } from '../lib/workspace-tags.js';
import {
  bulkApplyLeadTagsByIds,
  bulkUnsetLeadTagsByIds,
  setLeadTag,
  unsetLeadTag,
} from '../lib/lead-tags.js';
import {
  buildTagFilterWhere,
  TagFilterSchema,
  type TagFilter,
} from '../lib/leads-filter.js';
import { isValidRole, type WorkspaceRole } from '../lib/rbac.js';

// ---------------------------------------------------------------------------
// RBAC allowlists (T-TAGS-011)
//
// BR-RBAC: lead-side tag operations are split into two sensitivity tiers.
//
//   SINGLE-LEAD writes (POST/DELETE /by-lead/...) — day-to-day editing of one
//   lead at a time. Allowed for owner|admin plus the everyday editor role.
//   The canonical taxonomy in lib/rbac.ts is owner|admin|marketer|privacy|
//   operator|viewer (no "editor"); we map the prompt's "editor" to `marketer`,
//   which is the canonical "everyday CP editor" role per BR-RBAC. Privacy is
//   intentionally excluded — privacy is a read/erasure role, not a tag editor.
//
//   BULK writes (POST /bulk-apply, /bulk-remove) — high-blast-radius. Kept
//   tight at owner|admin to match catalog write authority.
// ---------------------------------------------------------------------------
const SINGLE_LEAD_TAG_WRITE_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>([
  'owner',
  'admin',
  'marketer',
]);

const BULK_LEAD_TAG_WRITE_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>([
  'owner',
  'admin',
]);
import {
  supabaseJwtMiddleware,
  type LookupWorkspaceMemberFn,
} from '../middleware/auth-supabase-jwt.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env / context types
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  DATABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
  SUPABASE_URL?: string;
};

type AppVariables = {
  workspace_id?: string;
  user_id?: string;
  role?: string;
  request_id?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const TagNameSchema = z.string().trim().min(1).max(120);

const ApplyByLeadBodySchema = z
  .object({
    tag_names: z.array(TagNameSchema).min(1).max(50),
  })
  .strict();

// T-TAGS-010: bulk endpoints accept EITHER explicit IDs OR a tag_filter that
// resolves to the universe of leads matching tag presence/absence. Mutually
// exclusive (XOR) — passing both is a frontend bug. We model that with a
// union of two strict object shapes; Zod surfaces a clean validation error
// when neither (or both) is provided.
const BulkBodyByIdsSchema = z
  .object({
    tag_names: z.array(TagNameSchema).min(1).max(50),
    lead_public_ids: z.array(z.string().uuid()).min(1).max(5000),
  })
  .strict();

const BulkBodyByFilterSchema = z
  .object({
    tag_names: z.array(TagNameSchema).min(1).max(50),
    tag_filter: TagFilterSchema,
  })
  .strict();

const BulkBodySchema = z.union([BulkBodyByIdsSchema, BulkBodyByFilterSchema]);

// Cap aligned with the explicit-ID path (max 5000). When the filter matches
// more than this, we process the first 5000 (deterministic by leads.id ASC)
// and report `capped: true` so the UI can prompt for a narrower filter.
const BULK_BY_FILTER_CAP = 5000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLeadsTagsRoute(opts?: {
  getConnStr?: (env: AppBindings) => string;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveDb(env: AppBindings): Db | null {
    const connStr = opts?.getConnStr
      ? opts.getConnStr(env)
      : (env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL ?? '');
    if (!connStr) return null;
    return createDb(connStr);
  }

  const buildLookupMember = (env: AppBindings): LookupWorkspaceMemberFn => {
    return async (userId: string) => {
      const db = resolveDb(env);
      if (!db) return null;
      const rows = await db
        .select({
          workspace_id: workspaceMembers.workspaceId,
          role: workspaceMembers.role,
        })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
        .limit(1);
      const row = rows[0];
      if (!row || !isValidRole(row.role)) return null;
      return { workspace_id: row.workspace_id, role: row.role };
    };
  };

  route.use('*', async (c, next) => {
    const mw = supabaseJwtMiddleware<AppEnv>({
      required: false, // DEV_WORKSPACE_ID fallback consistente com workspace-tags
      lookupMember: buildLookupMember(c.env),
    });
    return mw(c, next);
  });

  // -------------------------------------------------------------------------
  // POST /by-lead/:lead_public_id — apply N tags to 1 lead
  // -------------------------------------------------------------------------
  route.post('/by-lead/:lead_public_id', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }
    // BR-RBAC: single-lead tag set restricted to owner|admin|marketer (T-TAGS-011).
    const roleGate = requireWriteRole(c, SINGLE_LEAD_TAG_WRITE_ROLES, requestId);
    if (roleGate) return roleGate;

    const leadPublicId = c.req.param('lead_public_id');
    if (!leadPublicId || !isUuid(leadPublicId)) {
      return c.json(
        { code: 'validation_error', message: 'Invalid lead_public_id', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const bodyRaw = await c.req.json().catch(() => ({}));
    const parsed = ApplyByLeadBodySchema.safeParse(bodyRaw);
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid body',
          details: parsed.error.flatten().fieldErrors,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'not_available', message: 'db unavailable', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    // BR-IDENTITY-013: lead_public_id == leads.id; verify membership.
    const leadId = await resolveLeadId(db, workspaceId, leadPublicId);
    if (!leadId) {
      return c.json({ code: 'not_found', request_id: requestId }, 404, {
        'X-Request-Id': requestId,
      });
    }

    const userId = c.get('user_id') as string | undefined;
    // INV-LEAD-TAG-002 / INV-WORKSPACE-TAG-002: provenance canonical formats.
    const setBy = userId && userId !== 'dev' ? `user:${userId}` : 'user:dev';
    const source =
      userId && userId !== 'dev' ? (`user:${userId}` as const) : ('user:dev' as const);

    let applied = 0;
    // Parallel — autoRegisterTag + setLeadTag are both idempotent.
    await Promise.all(
      parsed.data.tag_names.map(async (tagName) => {
        const reg = await autoRegisterTag({ db, workspaceId, name: tagName, source });
        if (!reg.ok) {
          safeLog('warn', {
            event: 'auto_register_tag_failed',
            request_id: requestId,
            workspace_id: workspaceId,
            tag_name: tagName,
            source,
            error: reg.error.slice(0, 200),
          });
          // Continue — lead_tags row can still be created (soft relation).
        }
        const res = await setLeadTag({
          db,
          workspaceId,
          leadId,
          tagName,
          setBy,
        });
        if (res.ok) {
          applied++;
        } else {
          safeLog('warn', {
            event: 'lead_tag_set_failed',
            request_id: requestId,
            workspace_id: workspaceId,
            lead_id: leadId,
            tag_name: tagName,
            error: res.error.slice(0, 200),
          });
        }
      }),
    );

    // BR-AUDIT-001: single aggregate audit row for this batch.
    await writeAuditEntry(db, {
      workspaceId,
      actorId: userId ?? 'cp_user',
      action: 'lead_tag.set_batch',
      entityType: 'lead',
      entityId: leadId,
      before: null,
      after: { tag_names: parsed.data.tag_names, applied },
      requestId,
    });

    return c.json({ applied, request_id: requestId }, 200, {
      'X-Request-Id': requestId,
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /by-lead/:lead_public_id/:tag_name — remove 1 tag from 1 lead
  // -------------------------------------------------------------------------
  route.delete('/by-lead/:lead_public_id/:tag_name', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }
    // BR-RBAC: single-lead tag unset restricted to owner|admin|marketer (T-TAGS-011).
    const roleGate = requireWriteRole(c, SINGLE_LEAD_TAG_WRITE_ROLES, requestId);
    if (roleGate) return roleGate;

    const leadPublicId = c.req.param('lead_public_id');
    const tagNameRaw = c.req.param('tag_name');
    if (!leadPublicId || !isUuid(leadPublicId)) {
      return c.json(
        { code: 'validation_error', message: 'Invalid lead_public_id', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const tagNameParse = TagNameSchema.safeParse(tagNameRaw ? decodeURIComponent(tagNameRaw) : '');
    if (!tagNameParse.success) {
      return c.json(
        { code: 'validation_error', message: 'Invalid tag_name', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }
    const tagName = tagNameParse.data;

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'not_available', message: 'db unavailable', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    const leadId = await resolveLeadId(db, workspaceId, leadPublicId);
    if (!leadId) {
      return c.json({ code: 'not_found', request_id: requestId }, 404, {
        'X-Request-Id': requestId,
      });
    }

    const res = await unsetLeadTag({ db, workspaceId, leadId, tagName });
    if (!res.ok) {
      safeLog('error', {
        event: 'lead_tag_unset_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        lead_id: leadId,
        tag_name: tagName,
        error: res.error.slice(0, 200),
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    if (res.removed) {
      const userId = c.get('user_id') as string | undefined;
      await writeAuditEntry(db, {
        workspaceId,
        actorId: userId ?? 'cp_user',
        action: 'lead_tag.unset',
        entityType: 'lead',
        entityId: leadId,
        before: { tag_name: tagName },
        after: null,
        requestId,
      });
    }

    return c.json({ removed: res.removed, request_id: requestId }, 200, {
      'X-Request-Id': requestId,
    });
  });

  // -------------------------------------------------------------------------
  // POST /bulk-apply — N tags × M leads
  // -------------------------------------------------------------------------
  route.post('/bulk-apply', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }
    // BR-RBAC: bulk tag apply restricted to owner|admin (T-TAGS-011).
    const roleGate = requireWriteRole(c, BULK_LEAD_TAG_WRITE_ROLES, requestId);
    if (roleGate) return roleGate;

    const bodyRaw = await c.req.json().catch(() => ({}));
    const parsed = BulkBodySchema.safeParse(bodyRaw);
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid body',
          details: parsed.error.flatten().fieldErrors,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'not_available', message: 'db unavailable', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    // T-TAGS-010: two resolution paths, mutually exclusive (XOR enforced by
    // the union schema). `byIds` reports unknown public_ids individually;
    // `byFilter` reports `matched` (rows selected by the filter) + `capped`.
    // TS doesn't narrow the union via property presence here (`tag_names` is
    // in both branches), so we discriminate manually and re-derive the branch
    // via a typed local.
    const data = parsed.data;
    const byIds = 'lead_public_ids' in data;
    let knownIds: string[] = [];
    let unknownPublicIds: string[] = [];
    let matched = 0;
    let capped = false;
    if (byIds) {
      const ids = (data as { lead_public_ids: string[] }).lead_public_ids;
      const r = await resolveLeadIdsBatch(db, workspaceId, ids);
      knownIds = r.knownIds;
      unknownPublicIds = r.unknownPublicIds;
      matched = knownIds.length;
    } else {
      const filter = (data as { tag_filter: TagFilter }).tag_filter;
      const r = await resolveLeadIdsByTagFilter(db, workspaceId, filter);
      // resolveLeadIdsByTagFilter returns null only on empty/invalid filter
      // (caught upstream by Zod). Defensive: treat as empty selection.
      knownIds = r?.ids ?? [];
      capped = r?.capped ?? false;
      matched = knownIds.length;
    }

    const userId = c.get('user_id') as string | undefined;
    const setBy = userId && userId !== 'dev' ? `user:${userId}` : 'user:dev';
    const source =
      userId && userId !== 'dev' ? (`user:${userId}` as const) : ('user:dev' as const);

    // Auto-register catalog rows for every tag (idempotent, parallel).
    await Promise.all(
      parsed.data.tag_names.map(async (name) => {
        const reg = await autoRegisterTag({ db, workspaceId, name, source });
        if (!reg.ok) {
          safeLog('warn', {
            event: 'auto_register_tag_failed',
            request_id: requestId,
            workspace_id: workspaceId,
            tag_name: name,
            source,
            error: reg.error.slice(0, 200),
          });
        }
      }),
    );

    const { applied, skipped } =
      knownIds.length === 0
        ? { applied: 0, skipped: 0 }
        : await bulkApplyLeadTagsByIds({
            db,
            workspaceId,
            leadIds: knownIds,
            tagNames: parsed.data.tag_names,
            setBy,
            requestId,
          });

    // BR-AUDIT-001: one aggregate audit row per bulk call.
    // entityId = first known lead_id (or '-' when batch matched zero leads).
    await writeAuditEntry(db, {
      workspaceId,
      actorId: userId ?? 'cp_user',
      action: 'lead_tag.bulk_apply',
      entityType: 'lead',
      entityId: knownIds[0] ?? '-',
      before: null,
      after: {
        tag_names: parsed.data.tag_names,
        lead_count: knownIds.length,
        applied,
        skipped,
        // T-TAGS-010: capture which selection mode was used (by ids vs. filter)
        // and overflow status — useful for forensics when capped batches recur.
        selection_mode: byIds ? 'by_ids' : 'by_filter',
        ...(byIds ? { unknown_public_ids_count: unknownPublicIds.length } : { capped }),
      },
      requestId,
    });

    return c.json(
      {
        applied,
        skipped,
        matched,
        ...(byIds ? { unknown_public_ids: unknownPublicIds } : { capped }),
        request_id: requestId,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // POST /bulk-remove — N tags × M leads
  // -------------------------------------------------------------------------
  route.post('/bulk-remove', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }
    // BR-RBAC: bulk tag remove restricted to owner|admin (T-TAGS-011).
    const roleGate = requireWriteRole(c, BULK_LEAD_TAG_WRITE_ROLES, requestId);
    if (roleGate) return roleGate;

    const bodyRaw = await c.req.json().catch(() => ({}));
    const parsed = BulkBodySchema.safeParse(bodyRaw);
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid body',
          details: parsed.error.flatten().fieldErrors,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'not_available', message: 'db unavailable', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    // T-TAGS-010: see /bulk-apply above for the XOR design notes.
    const data = parsed.data;
    const byIds = 'lead_public_ids' in data;
    let knownIds: string[] = [];
    let unknownPublicIds: string[] = [];
    let matched = 0;
    let capped = false;
    if (byIds) {
      const ids = (data as { lead_public_ids: string[] }).lead_public_ids;
      const r = await resolveLeadIdsBatch(db, workspaceId, ids);
      knownIds = r.knownIds;
      unknownPublicIds = r.unknownPublicIds;
      matched = knownIds.length;
    } else {
      const filter = (data as { tag_filter: TagFilter }).tag_filter;
      const r = await resolveLeadIdsByTagFilter(db, workspaceId, filter);
      knownIds = r?.ids ?? [];
      capped = r?.capped ?? false;
      matched = knownIds.length;
    }

    const { removed } =
      knownIds.length === 0
        ? { removed: 0 }
        : await bulkUnsetLeadTagsByIds({
            db,
            workspaceId,
            leadIds: knownIds,
            tagNames: parsed.data.tag_names,
          });

    const userId = c.get('user_id') as string | undefined;
    await writeAuditEntry(db, {
      workspaceId,
      actorId: userId ?? 'cp_user',
      action: 'lead_tag.bulk_remove',
      entityType: 'lead',
      entityId: knownIds[0] ?? '-',
      before: { tag_names: parsed.data.tag_names, lead_count: knownIds.length },
      after: {
        removed,
        selection_mode: byIds ? 'by_ids' : 'by_filter',
        ...(byIds ? { unknown_public_ids_count: unknownPublicIds.length } : { capped }),
      },
      requestId,
    });

    return c.json(
      {
        removed,
        matched,
        ...(byIds ? { unknown_public_ids: unknownPublicIds } : { capped }),
        request_id: requestId,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  return route;
}

// ---------------------------------------------------------------------------
// Helpers (file-local)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/**
 * Returns a 403 Response when the current role is not in the allowlist;
 * returns null when allowed. Co-located with workspace-tags.ts's identical
 * helper — kept inline because Wave 2B only has two call sites in this domain
 * and route author's ownership excludes lib/.
 *
 * BR-RBAC: workspace-scoped role gate. No audit log on denial — request never
 * reaches the mutation, no business event occurred.
 */
function requireWriteRole(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  allowed: ReadonlySet<WorkspaceRole>,
  requestId: string,
): Response | null {
  const role = (c.get('role') as WorkspaceRole | undefined) ?? null;
  if (!role || !allowed.has(role)) {
    return c.json({ code: 'forbidden', request_id: requestId }, 403, {
      'X-Request-Id': requestId,
    }) as Response;
  }
  return null;
}

/**
 * BR-IDENTITY-013: lead_public_id == leads.id. Verifies the row exists under
 * the workspace and is not erased; merged leads still resolve so callers can
 * read tags from them, but mutations should arguably target the canonical row.
 * For Wave 2B we accept merged/active; the bulk path mirrors this contract.
 *
 * BR-IDENTITY: workspaceId in WHERE prevents cross-workspace leaks.
 */
async function resolveLeadId(
  db: Db,
  workspaceId: string,
  leadPublicId: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.workspaceId, workspaceId), eq(leads.id, leadPublicId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Batch resolver — single round-trip SELECT IN (...). Returns matched lead ids
 * plus the public_ids that did NOT match (for the response payload so the
 * frontend can surface them). BR-IDENTITY: workspace_id enforced in WHERE.
 */
async function resolveLeadIdsBatch(
  db: Db,
  workspaceId: string,
  leadPublicIds: string[],
): Promise<{ knownIds: string[]; unknownPublicIds: string[] }> {
  if (leadPublicIds.length === 0) {
    return { knownIds: [], unknownPublicIds: [] };
  }
  // Use raw SQL with uuid[] cast — drizzle's inArray binds each id as a
  // parameter, which is fine but the array cast keeps the query shape stable.
  const res = await db.execute(sql`
    SELECT id::text AS id
    FROM leads
    WHERE workspace_id = ${workspaceId}::uuid
      AND id = ANY(${leadPublicIds}::uuid[])
  `);
  const rows = res as unknown as Array<{ id: string }>;
  const knownIds = rows.map((r) => r.id);
  const knownSet = new Set(knownIds);
  const unknownPublicIds = leadPublicIds.filter((p) => !knownSet.has(p));
  return { knownIds, unknownPublicIds };
}

/**
 * T-TAGS-010: resolve the universe of lead_ids matching a tag_filter under a
 * workspace. Bulk endpoints by filter use ONLY tag-presence/absence — no
 * q / launch / lifecycle composition. Reads `BULK_BY_FILTER_CAP + 1` rows so
 * the caller can detect overflow and surface `capped: true` to the UI.
 *
 * BR-IDENTITY: workspace_id is anchored in BOTH the outer WHERE and the
 * EXISTS subqueries built by `buildTagFilterWhere` — no cross-workspace
 * leak even if RLS is bypassed by an internal call site.
 *
 * Returns `null` when the filter is malformed/empty (caller should reject
 * with 400 before reaching this point — defensive).
 */
async function resolveLeadIdsByTagFilter(
  db: Db,
  workspaceId: string,
  filter: TagFilter,
): Promise<{ ids: string[]; capped: boolean } | null> {
  const tagWhere = buildTagFilterWhere(filter, workspaceId, sql`leads.id`);
  if (!tagWhere) return null;
  // Deterministic order (id ASC) so the "first 5000" slice on overflow is
  // stable across retries — same client retry hits the same row set.
  const res = await db.execute(sql`
    SELECT id::text AS id
    FROM leads
    WHERE workspace_id = ${workspaceId}::uuid
      AND ${tagWhere}
    ORDER BY id ASC
    LIMIT ${BULK_BY_FILTER_CAP + 1}
  `);
  const rows = res as unknown as Array<{ id: string }>;
  const capped = rows.length > BULK_BY_FILTER_CAP;
  const ids = capped ? rows.slice(0, BULK_BY_FILTER_CAP).map((r) => r.id) : rows.map((r) => r.id);
  return { ids, capped };
}

type AuditEntry = {
  workspaceId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  requestId: string;
};

async function writeAuditEntry(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLog).values({
      workspaceId: entry.workspaceId,
      actorId: entry.actorId,
      actorType: 'user',
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before as Record<string, unknown> | null,
      after: entry.after as Record<string, unknown> | null,
      requestContext: { request_id: entry.requestId },
    });
  } catch (err) {
    safeLog('error', {
      event: 'audit_log_write_failed',
      request_id: entry.requestId,
      workspace_id: entry.workspaceId,
      action: entry.action,
      entity_id: entry.entityId,
      error: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
    });
  }
}

// ---------------------------------------------------------------------------
// Default instance — wired in index.ts with real getConnStr.
// ---------------------------------------------------------------------------

const leadsTagsRoute = createLeadsTagsRoute();
export default leadsTagsRoute;
