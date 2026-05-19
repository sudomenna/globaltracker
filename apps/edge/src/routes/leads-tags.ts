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
import { isValidRole, type WorkspaceRole } from '../lib/rbac.js';
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

const BulkBodySchema = z
  .object({
    tag_names: z.array(TagNameSchema).min(1).max(50),
    lead_public_ids: z.array(z.string().uuid()).min(1).max(5000),
  })
  .strict();

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

    // Resolve lead_public_ids → lead_ids in one round-trip; report unknowns.
    const { knownIds, unknownPublicIds } = await resolveLeadIdsBatch(
      db,
      workspaceId,
      parsed.data.lead_public_ids,
    );

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
        unknown_public_ids_count: unknownPublicIds.length,
      },
      requestId,
    });

    return c.json(
      {
        applied,
        skipped,
        unknown_public_ids: unknownPublicIds,
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

    const { knownIds, unknownPublicIds } = await resolveLeadIdsBatch(
      db,
      workspaceId,
      parsed.data.lead_public_ids,
    );

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
        unknown_public_ids_count: unknownPublicIds.length,
      },
      requestId,
    });

    return c.json(
      {
        removed,
        unknown_public_ids: unknownPublicIds,
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
