/**
 * routes/integrations-sendflow.ts — GET/PATCH /v1/integrations/sendflow/credentials
 *
 * T-ID: T-13-016b (Sprint 13)
 * Manage `workspace_integrations.sendflow_sendtok` (the inbound SendFlow webhook
 * authentication token used in `apps/edge/src/routes/webhooks/sendflow.ts`).
 *
 * CONTRACT: docs/30-contracts/05-api-server-actions.md
 *
 * Auth: `Authorization: Bearer <token>` (same pattern as workspace-config.ts).
 *   workspace_id comes from auth context (JWT/Bearer) — NEVER from body.
 *
 * BR-PRIVACY-001: response NEVER echoes the raw sendtok — only `prefix`
 *   (first 4 chars) + `length`. Audit log metadata follows the same rule.
 * BR-AUDIT-001: PATCH writes audit_log action='workspace_sendflow_sendtok_updated'.
 * BR-RBAC-002: workspace_id from auth context, never from body.
 * BR-WEBHOOK-001: token is consumed in constant-time compare by sendflow.ts —
 *   we only persist; we never echo.
 *
 * INV-WI-001: workspace_integrations.workspace_id is unique — upsert via
 *   onConflictDoUpdate(workspace_id).
 */

import { auditLog, createDb, workspaceIntegrations } from '@globaltracker/db';
import type { Db } from '@globaltracker/db';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings / Variables
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV?: KVNamespace;
  ENVIRONMENT?: string;
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
// Aligns with migration 0035 chk constraint
// `chk_workspace_integrations_sendflow_sendtok_length` (16 ≤ length ≤ 200).
// .strict() rejects unknown top-level fields (400 on extra keys).
// ---------------------------------------------------------------------------

const PatchCredentialsBodySchema = z
  .object({
    sendtok: z.string().min(16).max(200),
  })
  .strict();

type PatchCredentialsBody = z.infer<typeof PatchCredentialsBodySchema>;

// ---------------------------------------------------------------------------
// Audit entry type (mirrors workspace-config.ts pattern)
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
// Auth helper (identical to workspace-config.ts)
// ---------------------------------------------------------------------------

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]?.trim()) return null;
  return match[1].trim();
}

// ---------------------------------------------------------------------------
// Masked token shape — what we return in responses.
// BR-PRIVACY-001: callers never see the raw value.
// ---------------------------------------------------------------------------

type MaskedSendtokResponse =
  | { has_sendtok: false; prefix: null; length: null }
  | { has_sendtok: true; prefix: string; length: number };

function maskSendtok(token: string | null | undefined): MaskedSendtokResponse {
  if (!token || token.length === 0) {
    return { has_sendtok: false, prefix: null, length: null };
  }
  return {
    has_sendtok: true,
    prefix: token.slice(0, 4),
    length: token.length,
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the `/v1/integrations/sendflow` sub-router.
 *
 * Usage in index.ts:
 * ```ts
 * import { integrationsSendflowRoute } from './routes/integrations-sendflow.js';
 * app.route('/v1/integrations/sendflow', integrationsSendflowRoute);
 * ```
 *
 * @param deps.getDb - factory to obtain a Drizzle DB from request context.
 * @param deps.insertAuditEntry - async function to write to audit_log.
 */
export function createIntegrationsSendflowRoute(deps?: {
  getDb?: (c: { env: AppBindings }) => Db | undefined;
  insertAuditEntry?: InsertAuditEntryFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // GET /credentials — read masked sendtok
  //
  // BR-PRIVACY-001: response NEVER includes raw token. Only `prefix` (first 4
  //   chars) + `length`. Read; no audit_log.
  // BR-RBAC-002: workspace_id from auth context.
  // -------------------------------------------------------------------------
  route.get('/credentials', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // Auth
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

    // BR-RBAC-002: workspace_id must come from auth context — never body/query.
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ??
      c.env.DEV_WORKSPACE_ID ??
      actorId;

    const db = deps?.getDb?.(c);
    if (!db) {
      safeLog('warn', {
        event: 'integrations_sendflow_get_no_db',
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

    let storedToken: string | null = null;
    try {
      const rows = await db
        .select({ sendflowSendtok: workspaceIntegrations.sendflowSendtok })
        .from(workspaceIntegrations)
        .where(eq(workspaceIntegrations.workspaceId, workspaceId))
        .limit(1);
      storedToken = rows[0]?.sendflowSendtok ?? null;
    } catch (err) {
      // BR-PRIVACY-001: no PII in log — workspace_id is opaque UUID.
      safeLog('error', {
        event: 'integrations_sendflow_get_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        {
          code: 'internal_error',
          message: 'Failed to read sendflow credentials',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    const masked = maskSendtok(storedToken);
    return c.json(
      { ...masked, request_id: requestId },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // PATCH /credentials — upsert sendtok
  //
  // INV-WI-001: workspace_integrations.workspace_id is unique. Use Drizzle
  //   onConflictDoUpdate(target=workspace_id) to upsert atomically.
  // BR-PRIVACY-001: log + audit metadata only contain `prefix` + `length`,
  //   never the raw token.
  // BR-AUDIT-001: action='workspace_sendflow_sendtok_updated'.
  // BR-RBAC-002: workspace_id from auth context.
  // -------------------------------------------------------------------------
  route.patch('/credentials', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // Auth
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

    // BR-RBAC-002: workspace_id from auth context.
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ??
      c.env.DEV_WORKSPACE_ID ??
      actorId;

    // Parse JSON body
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

    // Zod validation — .strict() rejects unknown fields; min(16)/max(200)
    // mirrors migration 0035 chk constraint.
    const parsed = PatchCredentialsBodySchema.safeParse(rawBody);
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

    const body: PatchCredentialsBody = parsed.data;
    const sendtok = body.sendtok;

    const db = deps?.getDb?.(c);
    if (!db) {
      safeLog('warn', {
        event: 'integrations_sendflow_patch_no_db',
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

    // Upsert by unique workspace_id (INV-WI-001).
    try {
      await db
        .insert(workspaceIntegrations)
        .values({
          workspaceId,
          sendflowSendtok: sendtok,
        })
        .onConflictDoUpdate({
          target: workspaceIntegrations.workspaceId,
          set: {
            sendflowSendtok: sendtok,
            updatedAt: sql`now()`,
          },
        });
    } catch (err) {
      // BR-PRIVACY-001: no token value in log.
      safeLog('error', {
        event: 'integrations_sendflow_patch_db_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });
      return c.json(
        {
          code: 'internal_error',
          message: 'Failed to update sendflow credentials',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Audit log
    //   BR-AUDIT-001: mutação sensível registra audit_log.
    //   BR-PRIVACY-001: metadata records only `prefix` + `length` — NEVER the
    //     raw token (it's a webhook auth secret).
    // -----------------------------------------------------------------------
    const auditMetadata = {
      length: sendtok.length,
      prefix: sendtok.slice(0, 4),
    };

    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          workspace_id: workspaceId,
          actor_id: actorId,
          actor_type: 'user',
          action: 'workspace_sendflow_sendtok_updated',
          entity_type: 'workspace_integration',
          entity_id: workspaceId,
          metadata: auditMetadata,
          request_id: requestId,
        });
      } catch (auditErr) {
        // BR-AUDIT-001: log warning but do not fail — sendtok is already updated.
        safeLog('warn', {
          event: '[AUDIT-PENDING] workspace_sendflow_sendtok_updated',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type:
            auditErr instanceof Error
              ? auditErr.constructor.name
              : typeof auditErr,
        });
      }
    } else {
      // Fallback: insert directly when no injected dep (production default export).
      try {
        await db.insert(auditLog).values({
          workspaceId,
          actorId,
          actorType: 'user',
          action: 'workspace_sendflow_sendtok_updated',
          entityType: 'workspace_integration',
          entityId: workspaceId,
          // BR-PRIVACY-001: after records prefix/length only — never the raw token.
          after: auditMetadata,
          requestContext: { request_id: requestId },
        });
      } catch (auditErr) {
        safeLog('warn', {
          event: '[AUDIT-PENDING] workspace_sendflow_sendtok_updated — fallback insert failed',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type:
            auditErr instanceof Error
              ? auditErr.constructor.name
              : typeof auditErr,
        });
      }
    }

    // BR-PRIVACY-001: log without raw value.
    safeLog('info', {
      event: 'sendflow_sendtok_updated',
      request_id: requestId,
      workspace_id: workspaceId,
      length: sendtok.length,
      prefix: sendtok.slice(0, 4),
    });

    return c.json(
      {
        has_sendtok: true,
        prefix: sendtok.slice(0, 4),
        length: sendtok.length,
        request_id: requestId,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance wired to createDb via Hyperdrive/DATABASE_URL.
// ---------------------------------------------------------------------------

export const integrationsSendflowRoute = createIntegrationsSendflowRoute({
  getDb: (c) => {
    const connString =
      c.env.HYPERDRIVE?.connectionString ?? c.env.DATABASE_URL;
    if (!connString) return undefined;
    return createDb(connString);
  },
});
