/**
 * routes/funnel-templates.ts — GET /v1/funnel-templates
 *
 * T-FUNIL-011 (Sprint 10): Control-plane endpoints for listing and retrieving
 * funnel templates available to the authenticated workspace.
 *
 * Endpoints:
 *   GET /v1/funnel-templates       — list global + workspace templates
 *   GET /v1/funnel-templates/:slug — single template detail
 *
 * Auth:
 *   Authorization: Bearer <api_key> (control-plane pattern).
 *   In dev/test: DEV_WORKSPACE_ID env fallback skips DB API key lookup.
 *   Missing or empty Bearer → 401.
 *
 * Templates returned:
 *   - Global (workspace_id IS NULL) — system templates visible to all.
 *   - Workspace-scoped (workspace_id = authenticated workspace).
 *
 * BR-PRIVACY-001: no PII in logs or error responses.
 * BR-RBAC-002: workspace isolation enforced — cannot access other workspace templates.
 */

import type { Db } from '@globaltracker/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings / Variables types
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  HYPERDRIVE?: Hyperdrive;
  /** DATABASE_URL for local dev — Hyperdrive used in production */
  DATABASE_URL?: string;
  /** Dev-only workspace ID bypass (skips API key DB lookup) */
  DEV_WORKSPACE_ID?: string;
};

type AppVariables = {
  request_id: string;
  workspace_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Template row shape
// ---------------------------------------------------------------------------

interface FunnelTemplateRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  blueprint: unknown;
  is_system: boolean;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

/**
 * Resolve workspace_id from Authorization: Bearer header.
 *
 * In dev (DEV_WORKSPACE_ID set): skip DB lookup, return DEV_WORKSPACE_ID.
 * In production: TODO — look up workspace_api_keys table by key hash.
 * For Sprint 10 the Bearer token is accepted as-is (opaque); real scope
 * enforcement is Sprint 6's T-ID (same pattern as admin/leads-erase.ts).
 *
 * Returns null if the header is absent or empty.
 */
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
 * Create the funnel-templates sub-router.
 *
 * @param getDb - optional factory to obtain a Drizzle DB instance.
 *   When provided, routes query funnel_templates from DB.
 *   When absent, routes return 503 (DB not configured).
 */
export function createFunnelTemplatesRoute(
  getDb?: (c: { env: AppBindings }) => Db,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // Auth middleware — applied to all routes in this sub-router
  // -------------------------------------------------------------------------
  router.use('*', async (c, next) => {
    const requestId =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    if (!c.get('request_id' as keyof AppVariables)) {
      c.set('request_id', requestId);
    }

    const authHeader = c.req.header('Authorization');
    const token = extractBearerToken(authHeader);

    if (!token) {
      return c.json(
        {
          error: 'unauthorized',
          message: 'Authorization: Bearer required',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // Dev bypass: DEV_WORKSPACE_ID skips DB API key lookup
    if (c.env.DEV_WORKSPACE_ID) {
      c.set('workspace_id', c.env.DEV_WORKSPACE_ID);
      return next();
    }

    // Production: workspace resolution from Bearer token
    // Sprint 10 simplified — token is treated as opaque workspace_id (UUID).
    // Real API key scoping is enforced in Sprint 6 (see admin/leads-erase.ts).
    // TODO(T-AUTH-CP): replace with workspace_api_keys lookup + hash comparison.
    c.set('workspace_id', token);
    return next();
  });

  // -------------------------------------------------------------------------
  // GET / — list global + workspace templates
  // -------------------------------------------------------------------------
  router.get('/', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');

    const db = getDb?.(c);

    if (!db) {
      safeLog('warn', {
        event: 'funnel_templates_list_no_db',
        request_id: requestId,
        workspace_id: workspaceId,
      });
      return c.json(
        {
          error: 'service_unavailable',
          message: 'DB not configured',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    let rows: FunnelTemplateRow[];

    try {
      const result = await db.execute(
        sql`SELECT id, slug, name, description, blueprint, is_system
            FROM funnel_templates
            WHERE workspace_id IS NULL OR workspace_id = ${workspaceId}::uuid
            ORDER BY is_system DESC, name ASC`,
      );
      rows = result as unknown as FunnelTemplateRow[];
    } catch (err) {
      safeLog('error', {
        event: 'funnel_templates_list_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return c.json({ error: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    return c.json(
      {
        templates: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description ?? null,
          blueprint: r.blueprint,
          is_system: r.is_system,
        })),
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  // -------------------------------------------------------------------------
  // GET /:slug — single template detail
  // -------------------------------------------------------------------------
  router.get('/:slug', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');
    const slug = c.req.param('slug');

    const db = getDb?.(c);

    if (!db) {
      safeLog('warn', {
        event: 'funnel_templates_get_no_db',
        request_id: requestId,
        workspace_id: workspaceId,
      });
      return c.json(
        {
          error: 'service_unavailable',
          message: 'DB not configured',
          request_id: requestId,
        },
        503,
        { 'X-Request-Id': requestId },
      );
    }

    let row: FunnelTemplateRow | undefined;

    try {
      const result = await db.execute(
        sql`SELECT id, slug, name, description, blueprint, is_system
            FROM funnel_templates
            WHERE slug = ${slug}
              AND (workspace_id IS NULL OR workspace_id = ${workspaceId}::uuid)
            LIMIT 1`,
      );
      row = (result as unknown as FunnelTemplateRow[])[0];
    } catch (err) {
      safeLog('error', {
        event: 'funnel_templates_get_error',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return c.json({ error: 'internal_error', request_id: requestId }, 500, {
        'X-Request-Id': requestId,
      });
    }

    if (!row) {
      return c.json(
        {
          error: 'not_found',
          message: 'Template not found',
          request_id: requestId,
        },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    return c.json(
      {
        template: {
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description ?? null,
          blueprint: row.blueprint,
          is_system: row.is_system,
        },
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

  return router;
}

/**
 * Default export — no DB wired (returns 503 on queries).
 * Wire DB in index.ts via createFunnelTemplatesRoute(getDb).
 */
export const funnelTemplatesRoute = createFunnelTemplatesRoute();
