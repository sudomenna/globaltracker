/**
 * routes/workspace-config.ts — PATCH /v1/workspace/config
 *
 * Updates workspace-level integration configuration (workspace.config JSONB).
 * Uses a safe SELECT → JS deep-merge → UPDATE pattern to avoid the `||` SQL
 * JSONB concatenation bug in the Cloudflare Worker Postgres driver.
 *
 * CONTRACT: docs/30-contracts/05-api-server-actions.md
 * T-ID: T-FUNIL-021
 *
 * Auth: Authorization: Bearer <token> (OPERATOR or ADMIN).
 *   workspace_id comes from the auth context (JWT/Bearer) — NEVER from body.
 *
 * BR-AUDIT-001: mutação de workspace.config registra audit_log
 *   action='workspace_config_updated', metadata.fields_updated = top-level keys do body.
 * BR-RBAC-002: workspace_id como âncora multi-tenant — UPDATE escopo por workspace.
 * BR-PRIVACY-001: zero PII em logs e error responses.
 */

import { auditLog, createDb } from '@globaltracker/db';
import type { Db } from '@globaltracker/db';
import { workspaces } from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings / Variables
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  ENVIRONMENT: string;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
};

type AppVariables = {
  workspace_id: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod schema
//
// Accepts a PARTIAL workspace.config object.
// .strict() rejects unknown top-level fields (400 on extra keys).
// Inner objects are also strict where shapes are known.
// ---------------------------------------------------------------------------

/**
 * Shape for integrations.guru.product_launch_map entries.
 * Each key is an arbitrary product identifier; value maps to a launch.
 */
const GuruProductLaunchEntrySchema = z.object({
  launch_public_id: z.string().min(1),
  funnel_role: z.string().min(1),
});

const GuruConfigSchema = z
  .object({
    product_launch_map: z
      .record(GuruProductLaunchEntrySchema)
      .optional(),
  })
  .strict();

const IntegrationsSchema = z
  .object({
    guru: GuruConfigSchema.optional(),
  })
  .strict();

/**
 * Top-level PATCH body — partial workspace config.
 * .strict() guarantees unknown fields are rejected (400 validation_error).
 */
const PatchWorkspaceConfigBodySchema = z
  .object({
    integrations: IntegrationsSchema.optional(),
  })
  .strict();

type PatchWorkspaceConfigBody = z.infer<typeof PatchWorkspaceConfigBodySchema>;

// ---------------------------------------------------------------------------
// Audit entry type (matches pattern from workspace-test-mode.ts)
// ---------------------------------------------------------------------------

export type InsertAuditEntryFn = (entry: {
  workspace_id: string;
  actor_id: string;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  request_id: string;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Deep merge helper
//
// Recursively merges `patch` into `base`. Arrays are replaced (not merged).
// Only plain objects are recursed; all other types are overwritten.
// ---------------------------------------------------------------------------

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(patch)) {
    const baseVal = result[key];
    const patchVal = patch[key];

    if (
      patchVal !== null &&
      typeof patchVal === 'object' &&
      !Array.isArray(patchVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        patchVal as Record<string, unknown>,
      );
    } else {
      result[key] = patchVal;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) return null;
  return match[1].trim();
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the workspace-config sub-router.
 *
 * Usage in index.ts:
 * ```ts
 * import { createWorkspaceConfigRoute } from './routes/workspace-config.js';
 * app.route('/v1/workspace', createWorkspaceConfigRoute({ getDb, insertAuditEntry }));
 * ```
 *
 * @param deps.getDb - factory to obtain a Drizzle DB from request context.
 * @param deps.insertAuditEntry - async function to write to audit_log.
 */
export function createWorkspaceConfigRoute(deps?: {
  getDb?: (c: { env: AppBindings }) => Db | undefined;
  insertAuditEntry?: InsertAuditEntryFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // PATCH /config — update workspace configuration (partial merge)
  //
  // BR-RBAC-002: workspace_id from JWT/auth context — never from body.
  // BR-AUDIT-001: records audit_log after successful update.
  // BR-PRIVACY-001: no PII in logs or error responses.
  // -------------------------------------------------------------------------
  route.patch('/config', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 1. Auth — require Bearer token; workspace_id from context or token
    //    BR-RBAC-002: workspace_id is the multi-tenant anchor.
    //    TODO (T-AUTH-CP): replace with full JWT validation + OPERATOR/ADMIN role check.
    // -----------------------------------------------------------------------
    const actorId = extractBearerToken(c.req.header('Authorization'));

    if (!actorId) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing or invalid Authorization header',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // BR-RBAC-002: workspace_id must come from auth context (JWT variable or
    // DEV_WORKSPACE_ID bypass in dev/test) — never from the request body.
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ??
      c.env.DEV_WORKSPACE_ID ??
      actorId;

    // -----------------------------------------------------------------------
    // 2. Parse JSON body
    // -----------------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        {
          code: 'validation_error',
          message: 'Request body must be valid JSON',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 3. Zod validation — .strict() rejects unknown top-level fields
    // -----------------------------------------------------------------------
    const parsed = PatchWorkspaceConfigBodySchema.safeParse(rawBody);

    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: parsed.error.errors[0]?.message ?? 'Invalid request body',
          details: parsed.error.flatten(),
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const body: PatchWorkspaceConfigBody = parsed.data;

    // -----------------------------------------------------------------------
    // 4. Require DB
    // -----------------------------------------------------------------------
    const db = deps?.getDb?.(c);

    if (!db) {
      safeLog('warn', {
        event: 'workspace_config_patch_no_db',
        request_id: requestId,
        workspace_id: workspaceId,
      });
      return c.json(
        {
          code: 'service_unavailable',
          message: 'DB not configured',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 5. SELECT current config → JS deep-merge → UPDATE
    //
    // CRITICAL: Do NOT use `||` SQL JSONB concatenation — confirmed bug in
    // Cloudflare Worker Postgres driver (encoding corruption). Always use
    // SELECT → deepMerge(JS) → UPDATE pattern.
    //
    // BR-RBAC-002: SELECT and UPDATE scoped to workspaceId.
    // -----------------------------------------------------------------------
    let mergedConfig: Record<string, unknown>;

    try {
      const rows = await db
        .select({ config: workspaces.config })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      const currentConfig = (rows[0]?.config as Record<string, unknown>) ?? {};
      mergedConfig = deepMerge(currentConfig, body as Record<string, unknown>);

      await db
        .update(workspaces)
        .set({ config: mergedConfig })
        .where(eq(workspaces.id, workspaceId));
    } catch (err) {
      // BR-PRIVACY-001: no PII in log — workspace_id is an opaque UUID.
      safeLog('error', {
        event: 'workspace_config_patch_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });

      return c.json(
        {
          code: 'internal_error',
          message: 'Failed to update workspace config',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 6. Audit log
    //    BR-AUDIT-001: toda mutação sensível registra audit_log.
    //    action='workspace_config_updated' — fields_updated are top-level body keys.
    //    BR-PRIVACY-001: metadata contains only field names (no values).
    // -----------------------------------------------------------------------
    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          workspace_id: workspaceId,
          actor_id: actorId,
          actor_type: 'user',
          action: 'workspace_config_updated',
          entity_type: 'workspace',
          entity_id: workspaceId,
          // BR-AUDIT-001: metadata records which fields were touched — not the values.
          // BR-PRIVACY-001: no config values in metadata (could contain API tokens).
          metadata: { fields_updated: Object.keys(body) },
          request_id: requestId,
        });
      } catch (auditErr) {
        // BR-AUDIT-001: log warning but do not fail — config is already updated.
        // A reconciliation pass can recover missing audit entries.
        // BR-PRIVACY-001: no PII in log.
        safeLog('warn', {
          event: '[AUDIT-PENDING] workspace_config_updated',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type:
            auditErr instanceof Error
              ? auditErr.constructor.name
              : typeof auditErr,
        });
      }
    } else if (db) {
      // BR-AUDIT-001: fallback — insert directly when no injected dep (production default export).
      try {
        await db.insert(auditLog).values({
          workspaceId,
          actorId,
          actorType: 'user',
          action: 'workspace_config_updated',
          entityType: 'workspace',
          entityId: workspaceId,
          // BR-PRIVACY-001: after records field names only — no config values (may contain tokens).
          after: { fields_updated: Object.keys(body) },
          requestContext: { request_id: requestId },
        });
      } catch (auditErr) {
        safeLog('warn', {
          event: '[AUDIT-PENDING] workspace_config_updated — fallback insert failed',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type: auditErr instanceof Error ? auditErr.constructor.name : typeof auditErr,
        });
      }
    } else {
      safeLog('warn', {
        event: '[AUDIT-PENDING] workspace_config_updated — no db available',
        request_id: requestId,
        workspace_id: workspaceId,
      });
    }

    safeLog('info', {
      event: 'workspace_config_updated',
      request_id: requestId,
      workspace_id: workspaceId,
      fields_updated: Object.keys(body),
    });

    // -----------------------------------------------------------------------
    // 7. Return 200 with merged config
    // -----------------------------------------------------------------------
    return c.json(
      { config: mergedConfig },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance wired to createDb via Hyperdrive/DATABASE_URL.
// ---------------------------------------------------------------------------

export const workspaceConfigRoute = createWorkspaceConfigRoute({
  getDb: (c) => {
    const connString =
      c.env.DATABASE_URL ?? c.env.HYPERDRIVE?.connectionString;
    if (!connString) return undefined;
    return createDb(connString);
  },
});
