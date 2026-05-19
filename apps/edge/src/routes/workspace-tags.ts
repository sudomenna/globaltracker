/**
 * routes/workspace-tags.ts — CRUD HTTP layer for the workspace_tags catalog.
 *
 * T-TAGS-004 (edge). Delegates ALL SQL/transaction logic to
 * `lib/workspace-tags.ts` (T-TAGS-002 helpers). This file is intentionally
 * thin: Zod validation, RBAC gate, audit_log write, response shape.
 *
 * Endpoints (mounted at /v1/workspace-tags):
 *   GET    /              — list (include_archived?, with_count?=true)
 *   POST   /              — create
 *   PATCH  /:id           — partial update (name/color/description)
 *   DELETE /:id           — archive (or cascade hard-delete lead_tags)
 *   POST   /:id/unarchive — restore
 *
 * Auth:
 *   - supabaseJwtMiddleware in required mode, with lookupMember resolving
 *     workspace_id from workspace_members (same pattern as leads-timeline).
 *   - Wave 2B: any authenticated role passes. Refining to owner|admin|editor
 *     deferred — see [OQ] in route comments.
 *
 * Audit log:
 *   - Every write inserts one auditLog row: action,
 *     entityType='workspace_tag', entityId=tag.id, before/after, requestContext.
 *   - actor_id falls back to `'cp_user'` when no JWT-bound user (dev fallback);
 *     same pattern used by leads-timeline.ts bulk-archive (BR-AUDIT-001).
 *
 * BRs honored:
 *   - BR-IDENTITY: workspace_id is always taken from the auth context, never
 *     from the request body.
 *   - BR-AUDIT-001: every mutation writes an audit_log entry.
 *   - BR-PRIVACY-001: no PII handled here; tag metadata is non-sensitive.
 *
 * ORCHESTRATOR MOUNT (in apps/edge/src/index.ts):
 *   import workspaceTagsRoute from './routes/workspace-tags.js';
 *   app.route('/v1/workspace-tags', workspaceTagsRoute);
 */

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog, createDb, workspaceMembers, type Db } from '@globaltracker/db';
import {
  archiveTag,
  createTag,
  listTags,
  unarchiveTag,
  updateTag,
  type WorkspaceTagRow,
} from '../lib/workspace-tags.js';
import { isValidRole, type WorkspaceRole } from '../lib/rbac.js';

// ---------------------------------------------------------------------------
// RBAC allowlist (T-TAGS-011)
//
// BR-RBAC: write operations on the workspace tag catalog are administrative
// and must be restricted to high-trust roles. We mirror the canonical role
// taxonomy from lib/rbac.ts (owner|admin|marketer|privacy|operator|viewer) —
// the orchestrator prompt referenced "editor", which does not exist in this
// taxonomy; the closest semantic equivalent for everyday editing of catalog
// metadata would be `marketer`, but for the catalog mutations themselves we
// keep the gate tight at owner|admin (matches the spec for "Catálogo").
//
// Reads remain open to any authenticated role (handled inline in GET).
// ---------------------------------------------------------------------------
const CATALOG_WRITE_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>([
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

const NameSchema = z.string().trim().min(1).max(120);
const ColorSchema = z.string().max(32).nullable();
const DescriptionSchema = z.string().max(500).nullable();

const CreateTagBodySchema = z
  .object({
    name: NameSchema,
    color: ColorSchema.optional(),
    description: DescriptionSchema.optional(),
  })
  .strict();

// PATCH allows any subset, but at least one editable field must be present.
const UpdateTagBodySchema = z
  .object({
    name: NameSchema.optional(),
    color: ColorSchema.optional(),
    description: DescriptionSchema.optional(),
  })
  .strict()
  .refine(
    (data) => data.name !== undefined || data.color !== undefined || data.description !== undefined,
    { message: 'At least one of name/color/description must be provided' },
  );

const DeleteTagBodySchema = z
  .object({
    cascade: z.boolean().optional(),
  })
  .strict();

const ListTagsQuerySchema = z
  .object({
    include_archived: z
      .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
      .optional(),
    with_count: z
      .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
      .optional(),
  })
  .strict();

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkspaceTagsRoute(opts?: {
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

  // RBAC: auth middleware sets `role` from workspace_members lookup. Per-handler
  // role gates below restrict catalog WRITES to owner|admin (T-TAGS-011). GETs
  // remain open to any authenticated role.
  route.use('*', async (c, next) => {
    const mw = supabaseJwtMiddleware<AppEnv>({
      required: false, // keeps DEV_WORKSPACE_ID fallback for local/curl tests
      lookupMember: buildLookupMember(c.env),
    });
    return mw(c, next);
  });

  // -------------------------------------------------------------------------
  // GET / — list
  // -------------------------------------------------------------------------
  route.get('/', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }

    const parsed = ListTagsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid query parameters',
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

    const includeArchived = parseBool(parsed.data.include_archived, false);
    const withCount = parseBool(parsed.data.with_count, true);

    const tags = await listTags({ db, workspaceId, includeArchived, withCount });

    return c.json({ tags, request_id: requestId }, 200, {
      'X-Request-Id': requestId,
    });
  });

  // -------------------------------------------------------------------------
  // POST / — create
  // -------------------------------------------------------------------------
  route.post('/', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }
    // BR-RBAC: catalog write restricted to owner|admin (T-TAGS-011).
    const roleGate = requireWriteRole(c, CATALOG_WRITE_ROLES, requestId);
    if (roleGate) return roleGate;

    const bodyRaw = await c.req.json().catch(() => ({}));
    const parsed = CreateTagBodySchema.safeParse(bodyRaw);
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

    const userId = c.get('user_id') as string | undefined;
    // INV-WORKSPACE-TAG-002: createdBy follows `user:<uuid>` when JWT bound;
    // falls back to `user:dev` to keep dev/curl flows working.
    const createdBy = userId && userId !== 'dev' ? `user:${userId}` : 'user:dev';

    const result = await createTag({
      db,
      workspaceId,
      name: parsed.data.name,
      color: parsed.data.color ?? null,
      description: parsed.data.description ?? null,
      createdBy,
    });

    if (!result.ok) {
      if (result.error === 'duplicate') {
        return c.json({ code: 'duplicate_tag', request_id: requestId }, 409, {
          'X-Request-Id': requestId,
        });
      }
      safeLog('error', {
        event: 'workspace_tag_create_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        error: result.message?.slice(0, 200),
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // BR-AUDIT-001: one audit_log row per write.
    await writeAuditEntry(db, {
      workspaceId,
      actorId: userId ?? 'cp_user',
      action: 'workspace_tag.create',
      entityId: result.tag.id,
      before: null,
      after: serializeTag(result.tag),
      requestId,
    });

    return c.json({ tag: result.tag, request_id: requestId }, 201, {
      'X-Request-Id': requestId,
    });
  });

  // -------------------------------------------------------------------------
  // PATCH /:id — update
  // -------------------------------------------------------------------------
  route.patch('/:id', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }
    // BR-RBAC: catalog write restricted to owner|admin (T-TAGS-011).
    const roleGate = requireWriteRole(c, CATALOG_WRITE_ROLES, requestId);
    if (roleGate) return roleGate;

    const tagId = c.req.param('id');
    if (!tagId || !isUuid(tagId)) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid tag id',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const bodyRaw = await c.req.json().catch(() => ({}));
    const parsed = UpdateTagBodySchema.safeParse(bodyRaw);
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

    // Capture `before` for audit. We call listTags once and filter — cheap,
    // and keeps us from duplicating the SELECT-by-id query in this file.
    // Includes archived so we can audit edits on archived rows too.
    const beforeRow = await findTagById(db, workspaceId, tagId);

    const result = await updateTag({
      db,
      workspaceId,
      tagId,
      patch: {
        name: parsed.data.name,
        color: parsed.data.color,
        description: parsed.data.description,
      },
    });

    if (!result.ok) {
      if (result.error === 'not_found') {
        return c.json({ code: 'not_found', request_id: requestId }, 404, {
          'X-Request-Id': requestId,
        });
      }
      if (result.error === 'duplicate') {
        return c.json({ code: 'duplicate_tag', request_id: requestId }, 409, {
          'X-Request-Id': requestId,
        });
      }
      safeLog('error', {
        event: 'workspace_tag_update_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        tag_id: tagId,
        error: result.message?.slice(0, 200),
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    const userId = c.get('user_id') as string | undefined;
    await writeAuditEntry(db, {
      workspaceId,
      actorId: userId ?? 'cp_user',
      action: 'workspace_tag.update',
      entityId: tagId,
      before: beforeRow ? serializeTag(beforeRow) : null,
      after: serializeTag(result.tag),
      requestId,
    });

    return c.json({ tag: result.tag, request_id: requestId }, 200, {
      'X-Request-Id': requestId,
    });
  });

  // -------------------------------------------------------------------------
  // DELETE /:id — archive (or cascade hard-delete lead_tags)
  // -------------------------------------------------------------------------
  route.delete('/:id', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }
    // BR-RBAC: catalog write restricted to owner|admin (T-TAGS-011).
    const roleGate = requireWriteRole(c, CATALOG_WRITE_ROLES, requestId);
    if (roleGate) return roleGate;

    const tagId = c.req.param('id');
    if (!tagId || !isUuid(tagId)) {
      return c.json(
        { code: 'validation_error', message: 'Invalid tag id', request_id: requestId },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // Body is optional — empty body is fine (cascade defaults to false).
    const bodyRaw = await c.req.json().catch(() => ({}));
    const parsed = DeleteTagBodySchema.safeParse(bodyRaw ?? {});
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
    const cascade = parsed.data.cascade ?? false;

    const db = resolveDb(c.env);
    if (!db) {
      return c.json(
        { code: 'not_available', message: 'db unavailable', request_id: requestId },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    const result = await archiveTag({ db, workspaceId, tagId, cascade });

    if (!result.ok) {
      safeLog('error', {
        event: 'workspace_tag_archive_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        tag_id: tagId,
        error: result.error.slice(0, 200),
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // Only audit when something actually happened. Archiving an already-archived
    // tag returns archived:false from the helper — we don't write an audit row
    // for that no-op, but we still 200 (idempotent semantics).
    if (result.archived) {
      const userId = c.get('user_id') as string | undefined;
      await writeAuditEntry(db, {
        workspaceId,
        actorId: userId ?? 'cp_user',
        action: cascade ? 'workspace_tag.delete_cascade' : 'workspace_tag.archive',
        entityId: tagId,
        before: { archived_at: null },
        after: { archived_at: new Date().toISOString(), cascaded: result.cascaded },
        requestId,
      });
    }

    return c.json(
      {
        archived: result.archived,
        cascaded: result.cascaded,
        request_id: requestId,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // POST /:id/unarchive — restore
  // -------------------------------------------------------------------------
  route.post('/:id/unarchive', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json({ code: 'unauthorized', request_id: requestId }, 401, {
        'X-Request-Id': requestId,
      });
    }
    // BR-RBAC: catalog write restricted to owner|admin (T-TAGS-011).
    const roleGate = requireWriteRole(c, CATALOG_WRITE_ROLES, requestId);
    if (roleGate) return roleGate;

    const tagId = c.req.param('id');
    if (!tagId || !isUuid(tagId)) {
      return c.json(
        { code: 'validation_error', message: 'Invalid tag id', request_id: requestId },
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

    const result = await unarchiveTag({ db, workspaceId, tagId });

    if (!result.ok) {
      safeLog('error', {
        event: 'workspace_tag_unarchive_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        tag_id: tagId,
        error: result.error.slice(0, 200),
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    if (result.unarchived) {
      const userId = c.get('user_id') as string | undefined;
      await writeAuditEntry(db, {
        workspaceId,
        actorId: userId ?? 'cp_user',
        action: 'workspace_tag.unarchive',
        entityId: tagId,
        before: { archived_at: 'set' },
        after: { archived_at: null },
        requestId,
      });
    }

    return c.json(
      { unarchived: result.unarchived, request_id: requestId },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  return route;
}

// ---------------------------------------------------------------------------
// Helpers (file-local)
// ---------------------------------------------------------------------------

// UUID v1-v5 validator. Avoids importing zod in the param path.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/**
 * Returns a 403 Response when the current role is not in the allowlist;
 * returns null (callable as truthy guard) when the role is allowed.
 *
 * BR-RBAC: workspace-scoped role gate. Audit log is intentionally NOT written
 * on denial — the request never reaches the mutation, so no business event
 * occurred.
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

function serializeTag(tag: WorkspaceTagRow): Record<string, unknown> {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    description: tag.description,
    created_by: tag.createdBy,
    created_at: tag.createdAt.toISOString(),
    archived_at: tag.archivedAt ? tag.archivedAt.toISOString() : null,
  };
}

/** Convenience SELECT-by-id used to capture `before` for audit. */
async function findTagById(
  db: Db,
  workspaceId: string,
  tagId: string,
): Promise<WorkspaceTagRow | null> {
  // listTags is the single canonical reader (BR-IDENTITY scoping enforced inside).
  // For one row this is a marginal overhead — the alternative would be a raw
  // SELECT which would duplicate the rowToCamel mapping from lib/workspace-tags.
  const all = await listTags({ db, workspaceId, includeArchived: true });
  return all.find((t) => t.id === tagId) ?? null;
}

type AuditEntry = {
  workspaceId: string;
  actorId: string;
  action: string;
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
      entityType: 'workspace_tag',
      entityId: entry.entityId,
      before: entry.before as Record<string, unknown> | null,
      after: entry.after as Record<string, unknown> | null,
      requestContext: { request_id: entry.requestId },
    });
  } catch (err) {
    // BR-AUDIT-001 best-effort: audit failure must not block the user-facing
    // mutation (the SQL write already succeeded). We log and continue.
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
// Default instance — kept consistent with leads-timeline.ts pattern.
// Wired in apps/edge/src/index.ts with real getConnStr.
// ---------------------------------------------------------------------------

const workspaceTagsRoute = createWorkspaceTagsRoute();
export default workspaceTagsRoute;
