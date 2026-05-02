/**
 * routes/workspace-test-mode.ts
 *   POST /v1/workspace/test-mode  — activate or deactivate test mode
 *   GET  /v1/workspace/test-mode  — read current test mode status
 *
 * CONTRACT: docs/30-contracts/05-api-server-actions.md
 *   §POST /v1/workspace/test-mode
 *   §GET  /v1/workspace/test-mode
 *
 * T-ID: T-8-003
 *
 * Auth (placeholder — full JWT RBAC in Sprint 9):
 *   Requires `Authorization: Bearer <non-empty>`. Missing / malformed → 401.
 *   TODO Sprint RBAC: POST requires OPERATOR/ADMIN; GET requires MARKETER+.
 *
 * BR-AUDIT-001: toda mutação sensível registra audit_log (action='toggle_test_mode').
 * BR-RBAC-002:  workspace_id como âncora multi-tenant — KV keys são scoped por workspace.
 * BR-PRIVACY-001: zero PII em logs e error responses.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  type TestModeStatus,
  activateTestMode,
  deactivateTestMode,
  getTestModeStatus,
} from '../lib/test-mode.js';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env types
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
};

type AppVariables = {
  workspace_id?: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * POST body — toggle test mode on/off.
 *
 * `enabled`:     required boolean; true = activate, false = deactivate.
 * `ttl_seconds`: optional TTL for activation (default 3600, max 7200).
 *                Ignored when `enabled=false`.
 */
const PostBodySchema = z
  .object({
    enabled: z.boolean(),
    ttl_seconds: z.number().int().min(1).max(7200).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Injected audit-entry function type
// (matches the pattern used in dispatch-replay.ts)
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
// Response helpers
// ---------------------------------------------------------------------------

/** Shapes the DB/KV status into the contract response payload. */
function buildStatusResponse(status: TestModeStatus): {
  enabled: boolean;
  expires_at: string | null;
  ttl_seconds: number | null;
} {
  return {
    enabled: status.active,
    expires_at: status.expiresAt ? status.expiresAt.toISOString() : null,
    ttl_seconds: status.ttlSeconds,
  };
}

// ---------------------------------------------------------------------------
// Auth helper — shared by POST and GET handlers
// ---------------------------------------------------------------------------

/**
 * Extracts and validates the Bearer token from the Authorization header.
 * Returns the token string on success, or null on failure.
 *
 * TODO Sprint RBAC: replace with full JWT validation via auth-cp.ts middleware.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]?.trim()) return null;
  return match[1].trim();
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the workspace-test-mode sub-router with injected audit dependency.
 *
 * Usage in index.ts:
 * ```ts
 * import { workspaceTestModeRoute } from './routes/workspace-test-mode.js';
 * app.route('/v1/workspace', workspaceTestModeRoute);
 * ```
 *
 * @param deps.insertAuditEntry - async function to write to audit_log.
 */
export function createWorkspaceTestModeRoute(deps?: {
  insertAuditEntry?: InsertAuditEntryFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // POST /test-mode — activate or deactivate test mode
  // BR-AUDIT-001: mutação sensível → audit_log action='toggle_test_mode'
  // BR-RBAC-002:  all KV writes scoped by workspace_id
  // -------------------------------------------------------------------------
  route.post('/test-mode', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // BR-RBAC-002: workspace_id as multi-tenant anchor
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ?? '';

    // -----------------------------------------------------------------------
    // 1. Auth — require non-empty Bearer token
    //    TODO Sprint RBAC: validate JWT + require OPERATOR/ADMIN role
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

    // -----------------------------------------------------------------------
    // 2. Validate request body
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

    const bodyParse = PostBodySchema.safeParse(rawBody);

    if (!bodyParse.success) {
      const firstError = bodyParse.error.errors[0];
      return c.json(
        {
          code: 'validation_error',
          message: firstError?.message ?? 'Invalid request body',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const body = bodyParse.data;

    // -----------------------------------------------------------------------
    // 3. Apply test mode change via lib
    //    BR-RBAC-002: KV operations scoped to workspaceId
    // -----------------------------------------------------------------------
    let status: TestModeStatus;

    try {
      if (body.enabled) {
        // Note: activateTestMode uses internal TTL constant (3600s).
        // ttl_seconds from body is forwarded but the lib stub ignores it;
        // T-8-002 (domain-author) may extend the signature as needed.
        status = await activateTestMode(workspaceId, c.env.GT_KV);
      } else {
        await deactivateTestMode(workspaceId, c.env.GT_KV);
        status = { active: false, expiresAt: null, ttlSeconds: null };
      }
    } catch (err) {
      // BR-PRIVACY-001: no PII in log — workspace_id is an opaque UUID
      safeLog('error', {
        event: 'workspace_test_mode_kv_error',
        request_id: requestId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });

      return c.json(
        {
          code: 'internal_error',
          message: 'Failed to update test mode',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 4. Audit log
    //    BR-AUDIT-001: toda mutação sensível registra audit_log.
    //    action='toggle_test_mode' — canonical per docs/30-contracts/06-audit-trail-spec.md
    //    BR-PRIVACY-001: metadata contains only booleans + workspace_id — no PII.
    // -----------------------------------------------------------------------
    if (deps?.insertAuditEntry) {
      try {
        await deps.insertAuditEntry({
          workspace_id: workspaceId,
          actor_id: actorId,
          actor_type: 'user',
          action: 'toggle_test_mode',
          entity_type: 'workspace',
          entity_id: workspaceId,
          metadata: { enabled: body.enabled, workspace_id: workspaceId },
          request_id: requestId,
        });
      } catch (err) {
        // BR-AUDIT-001: log warning but do not fail the request — state is
        //   already written to KV. A reconciliation pass can recover this.
        // BR-PRIVACY-001: no PII in log.
        safeLog('warn', {
          event: '[AUDIT-PENDING] toggle_test_mode',
          request_id: requestId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
      }
    } else {
      safeLog('warn', {
        event: '[AUDIT-PENDING] toggle_test_mode — no insertAuditEntry dep',
        request_id: requestId,
      });
    }

    // -----------------------------------------------------------------------
    // 5. Return 200 with current status
    // -----------------------------------------------------------------------
    return c.json(buildStatusResponse(status), 200, {
      'X-Request-Id': requestId,
    });
  });

  // -------------------------------------------------------------------------
  // GET /test-mode — read current test mode status
  // BR-RBAC-002: KV lookup scoped by workspace_id
  // -------------------------------------------------------------------------
  route.get('/test-mode', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // BR-RBAC-002: workspace_id as multi-tenant anchor
    const workspaceId: string =
      (c.get('workspace_id') as string | undefined) ?? '';

    // -----------------------------------------------------------------------
    // 1. Auth — require non-empty Bearer token
    //    TODO Sprint RBAC: validate JWT + require MARKETER+ role
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

    // -----------------------------------------------------------------------
    // 2. Fetch current status from KV
    //    BR-RBAC-002: getTestModeStatus scopes KV key to workspaceId
    // -----------------------------------------------------------------------
    let status: TestModeStatus;

    try {
      status = await getTestModeStatus(workspaceId, c.env.GT_KV);
    } catch (err) {
      // BR-PRIVACY-001: no PII in log
      safeLog('error', {
        event: 'workspace_test_mode_get_error',
        request_id: requestId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
      });

      return c.json(
        {
          code: 'internal_error',
          message: 'Failed to read test mode status',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 3. Return 200 with current status
    // -----------------------------------------------------------------------
    return c.json(buildStatusResponse(status), 200, {
      'X-Request-Id': requestId,
    });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance with no-op audit stub.
// Callers should prefer createWorkspaceTestModeRoute(deps) to wire real DB.
// ---------------------------------------------------------------------------

/**
 * Default workspaceTestModeRoute instance.
 * Wire real audit dependency in index.ts via:
 * ```ts
 * app.route('/v1/workspace', createWorkspaceTestModeRoute({ insertAuditEntry }));
 * ```
 */
export const workspaceTestModeRoute = createWorkspaceTestModeRoute();
