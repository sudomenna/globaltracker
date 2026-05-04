/**
 * routes/pages-status.ts — GET /v1/pages/:public_id/status
 *
 * Returns live status of a page for polling by the Control Plane UI.
 * Used by the page registration screen (A.3) to display health state,
 * last ping, event counts and token status.
 *
 * CONTRACT-api-pages-status-v1
 *
 * ORCHESTRATOR MOUNT (adicionar em apps/edge/src/index.ts após as outras rotas):
 * import { pagesStatusRoute } from './routes/pages-status.js';
 * app.route('/v1/pages', pagesStatusRoute);
 *
 * Auth (Sprint 6 placeholder):
 *   Requires Authorization: Bearer <non-empty>. Full JWT validation via
 *   auth-cp.ts middleware will be wired in Sprint 6. For now, any non-empty
 *   Bearer token is accepted to unblock Control Plane UI development.
 *
 * Health state calculation (server-side):
 *   - unknown:   last_ping_at IS NULL (never received a ping)
 *   - healthy:   last_ping_at < 5min ago AND token_status='active' AND no recent_issues
 *   - degraded:  last_ping_at between 5min and 24h ago, OR token_status='rotating',
 *                OR token expires in < 7 days
 *   - unhealthy: no ping > 24h, OR token_status='revoked',
 *                OR any origin_not_allowed issue in the last hour
 *
 * Cache: Cache-Control max-age=30 to reduce polling cost between browser tabs.
 *
 * BR-PRIVACY-001: zero PII in logs and error responses.
 * BR-RBAC-002: workspace_id isolation — enforced by workspace lookup using
 *   page.workspace_id (row-level). Auth middleware will bind workspace_id in Sprint 6.
 */

import type { Db } from '@globaltracker/db';
import { and, eq, gte, max, or, sql } from 'drizzle-orm';
import { createDb, pages, pageTokens, rawEvents } from '@globaltracker/db';
import { Hono } from 'hono';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Env types (mirrors apps/edge/src/index.ts)
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  DATABASE_URL?: string;
};

type AppVariables = {
  request_id: string;
  workspace_id?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** Path param: :public_id */
const PublicIdParamSchema = z
  .object({
    public_id: z.string().min(1).max(64),
  })
  .strict();

// ---------------------------------------------------------------------------
// Domain types for injected dependencies
// ---------------------------------------------------------------------------

/** Token status subset used in this endpoint. */
export type PageTokenStatus = 'active' | 'rotating' | 'revoked';

/** Minimal page row returned by DB lookup. */
export interface PageStatusRow {
  id: string;
  workspaceId: string;
  publicId: string;
}

/** Minimal page_token row returned by DB lookup. */
export interface PageTokenRow {
  status: PageTokenStatus;
  createdAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

/** Aggregated event stats returned by DB lookup. */
export interface PageEventStats {
  eventsToday: number;
  eventsLast24h: number;
  lastPingAt: Date | null;
}

/** An issue detected for this page (origin_not_allowed, invalid_token, no_ping). */
export interface RecentIssue {
  type: 'origin_not_allowed' | 'invalid_token' | 'no_ping';
  domain?: string;
  count: number;
  last_seen_at: string; // ISO 8601
}

/** Full response shape. */
export interface PageStatusResponse {
  page_public_id: string;
  health_state: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  last_ping_at: string | null; // ISO 8601
  events_today: number;
  events_last_24h: number;
  token_status: PageTokenStatus | 'expired';
  token_rotates_at: string | null; // ISO 8601
  recent_issues: RecentIssue[];
}

// ---------------------------------------------------------------------------
// Injected DB query function types
// ---------------------------------------------------------------------------

/**
 * Looks up a page by public_id. Returns null if not found.
 * BR-RBAC-002: caller must scope lookup to workspace_id when workspace context
 *   is available. For now the endpoint trusts the token-based auth layer.
 */
export type GetPageByPublicIdFn = (
  publicId: string,
) => Promise<PageStatusRow | null>;

/**
 * Fetches the most recent active or rotating token for the given page_id.
 * Returns null when no such token exists.
 */
export type GetActivePageTokenFn = (
  pageId: string,
) => Promise<PageTokenRow | null>;

/**
 * Fetches event count stats for the given page_id.
 * Queries: events_today, events_last_24h, and MAX(received_at) as last_ping_at.
 */
export type GetPageEventStatsFn = (pageId: string) => Promise<PageEventStats>;

// ---------------------------------------------------------------------------
// Health state calculation
// ---------------------------------------------------------------------------

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Computes health_state and derived fields for the response.
 *
 * Rules from docs/70-ux/07-component-health-badges.md §4:
 *   unknown:   last_ping_at IS NULL
 *   healthy:   last_ping_at < 5min ago AND token_status='active' AND no issues in last hour
 *   degraded:  last_ping_at 5min–24h ago, OR token rotating, OR token expires in < 7d
 *   unhealthy: no ping > 24h, OR token revoked, OR origin_not_allowed issue in last hour
 */
export function computeHealthState(
  lastPingAt: Date | null,
  tokenStatus: PageTokenStatus | 'expired',
  tokenRotatedAt: Date | null,
  recentIssues: RecentIssue[],
  now: Date = new Date(),
): 'healthy' | 'degraded' | 'unhealthy' | 'unknown' {
  // unknown: never received a ping
  if (lastPingAt === null) return 'unknown';

  const msSincePing = now.getTime() - lastPingAt.getTime();

  // unhealthy conditions — evaluated first (most severe)
  if (msSincePing > TWENTY_FOUR_HOURS_MS) return 'unhealthy';
  if (tokenStatus === 'revoked') return 'unhealthy';
  const hasOriginRejected = recentIssues.some(
    (i) => i.type === 'origin_not_allowed',
  );
  if (hasOriginRejected) return 'unhealthy';

  // degraded conditions
  if (msSincePing > FIVE_MINUTES_MS) return 'degraded';
  if (tokenStatus === 'rotating') return 'degraded';
  if (tokenStatus === 'expired') return 'degraded';
  // Token expiring in < 7 days: check rotatedAt as proxy (Sprint 6 — no explicit expiry column)
  // If token was rotated and rotation window < 7 days remaining, mark degraded.
  if (tokenRotatedAt !== null) {
    const msInRotation = now.getTime() - tokenRotatedAt.getTime();
    // PAGE_TOKEN_ROTATION_OVERLAP_DAYS = 14 (ADR-023)
    const overlapMs = 14 * 24 * 60 * 60 * 1000;
    const remainingMs = overlapMs - msInRotation;
    if (remainingMs > 0 && remainingMs < SEVEN_DAYS_MS) return 'degraded';
  }

  // healthy: ping < 5min, token active, no issues
  if (msSincePing < FIVE_MINUTES_MS && tokenStatus === 'active') {
    return 'healthy';
  }

  // fallback — degraded for anything ambiguous
  return 'degraded';
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Creates the pages-status sub-router with injected dependencies.
 *
 * Usage in index.ts (wired by orchestrator):
 * ```ts
 * import { createPagesStatusRoute } from './routes/pages-status.js';
 * app.route('/v1/pages', createPagesStatusRoute({ getPageByPublicId, getActivePageToken, getPageEventStats }));
 * ```
 *
 * @param deps.getPageByPublicId - async function to fetch page by public_id.
 * @param deps.getActivePageToken - async function to fetch the active/rotating token.
 * @param deps.getPageEventStats - async function to fetch event counts and last_ping_at.
 */
export function createPagesStatusRoute(deps?: {
  getDb?: (env: AppBindings) => Db;
  getPageByPublicId?: GetPageByPublicIdFn;
  getActivePageToken?: GetActivePageTokenFn;
  getPageEventStats?: GetPageEventStatsFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // GET /:public_id/status
  // CONTRACT-api-pages-status-v1
  // -------------------------------------------------------------------------
  route.get('/:public_id/status', async (c) => {
    // request_id is set by sanitize-logs middleware upstream; fall back to a
    // fresh UUID so X-Request-Id is always present in isolated test calls.
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // -----------------------------------------------------------------------
    // 1. Auth — require non-empty Authorization: Bearer header
    //    TODO Sprint 6: replace with full JWT Supabase validation via auth-cp.ts
    //    middleware. Role must be MARKETER or higher (BR-RBAC-002).
    // -----------------------------------------------------------------------
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // BR-PRIVACY-001: no PII in response
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing authorization',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    const bearerValue = authHeader.slice('Bearer '.length).trim();
    if (!bearerValue) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing authorization',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 2. Validate :public_id path param
    // -----------------------------------------------------------------------
    const parseResult = PublicIdParamSchema.safeParse({
      public_id: c.req.param('public_id'),
    });

    if (!parseResult.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'public_id must be between 1 and 64 characters',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const publicId = parseResult.data.public_id;

    // -----------------------------------------------------------------------
    // 3. Fetch page
    //    BR-RBAC-002: workspace isolation — in Sprint 6 this will additionally
    //    verify page.workspace_id === session.workspace_id from JWT claims.
    // -----------------------------------------------------------------------
    let page: PageStatusRow | null = null;

    const db: Db | null = deps?.getDb
      ? deps.getDb(c.env)
      : deps?.getPageByPublicId
        ? null
        : null;

    const resolvedGetPageByPublicId: GetPageByPublicIdFn | undefined =
      deps?.getPageByPublicId ??
      (db
        ? async (pid) => {
            const row = await db
              .select({ id: pages.id, publicId: pages.publicId, workspaceId: pages.workspaceId })
              .from(pages)
              .where(eq(pages.publicId, pid))
              .limit(1);
            return row[0] ?? null;
          }
        : undefined);

    if (resolvedGetPageByPublicId) {
      try {
        page = await resolvedGetPageByPublicId(publicId);
      } catch (err) {
        // BR-PRIVACY-001: no PII in log — only opaque IDs
        safeLog('error', {
          event: 'pages_status_db_page_error',
          request_id: requestId,
          public_id: publicId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });

        return c.json(
          {
            code: 'internal_error',
            message: 'Database error',
            request_id: requestId,
          },
          500,
          { 'X-Request-Id': requestId },
        );
      }
    }

    if (!page) {
      return c.json(
        {
          code: 'page_not_found',
          message: 'Page not found',
          request_id: requestId,
        },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // 4. Fetch token
    //    INV-PAGE-004: each active page must have at least one active page_token.
    //    ADR-023: token status ∈ {active, rotating, revoked}.
    // -----------------------------------------------------------------------
    let token: PageTokenRow | null = null;
    let tokenStatus: PageTokenStatus | 'expired' = 'expired';
    let tokenRotatesAt: string | null = null;

    const resolvedGetActivePageToken: GetActivePageTokenFn | undefined =
      deps?.getActivePageToken ??
      (db
        ? async (pageId) => {
            const row = await db
              .select({
                status: pageTokens.status,
                createdAt: pageTokens.createdAt,
                rotatedAt: pageTokens.rotatedAt,
                revokedAt: pageTokens.revokedAt,
              })
              .from(pageTokens)
              .where(
                and(
                  eq(pageTokens.pageId, pageId),
                  or(eq(pageTokens.status, 'active'), eq(pageTokens.status, 'rotating')),
                ),
              )
              .orderBy(pageTokens.createdAt)
              .limit(1);
            if (!row[0]) return null;
            return {
              status: row[0].status as PageTokenStatus,
              createdAt: row[0].createdAt,
              rotatedAt: row[0].rotatedAt,
              revokedAt: row[0].revokedAt,
            };
          }
        : undefined);

    if (resolvedGetActivePageToken) {
      try {
        token = await resolvedGetActivePageToken(page.id);
      } catch (err) {
        safeLog('error', {
          event: 'pages_status_db_token_error',
          request_id: requestId,
          page_id: page.id,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        // Non-fatal — proceed with 'expired' token status (degrades health state)
      }
    }

    if (token) {
      // ADR-023: map DB status to response token_status
      tokenStatus = token.status as PageTokenStatus;

      // Compute token_rotates_at: when status='rotating', the rotation overlap
      // window ends 14 days after rotated_at (ADR-023 PAGE_TOKEN_ROTATION_OVERLAP_DAYS).
      if (token.status === 'rotating' && token.rotatedAt !== null) {
        const overlapEndMs =
          token.rotatedAt.getTime() + 14 * 24 * 60 * 60 * 1000;
        tokenRotatesAt = new Date(overlapEndMs).toISOString();
      }
    }

    // -----------------------------------------------------------------------
    // 5. Fetch event stats
    //    Queries: events_today, events_last_24h, MAX(received_at) = last_ping_at
    // -----------------------------------------------------------------------
    let stats: PageEventStats = {
      eventsToday: 0,
      eventsLast24h: 0,
      lastPingAt: null,
    };

    const resolvedGetPageEventStats: GetPageEventStatsFn | undefined =
      deps?.getPageEventStats ??
      (db
        ? async (pageId) => {
            const now = new Date();
            const startOfDay = new Date(now);
            startOfDay.setUTCHours(0, 0, 0, 0);
            const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

            const [todayRow, last24hRow] = await Promise.all([
              db
                .select({ count: sql<number>`cast(count(*) as int)` })
                .from(rawEvents)
                .where(and(eq(rawEvents.pageId, pageId), gte(rawEvents.receivedAt, startOfDay))),
              db
                .select({
                  count: sql<number>`cast(count(*) as int)`,
                  lastPingAt: max(rawEvents.receivedAt),
                })
                .from(rawEvents)
                .where(and(eq(rawEvents.pageId, pageId), gte(rawEvents.receivedAt, ago24h))),
            ]);

            return {
              eventsToday: todayRow[0]?.count ?? 0,
              eventsLast24h: last24hRow[0]?.count ?? 0,
              lastPingAt: last24hRow[0]?.lastPingAt ?? null,
            };
          }
        : undefined);

    if (resolvedGetPageEventStats) {
      try {
        stats = await resolvedGetPageEventStats(page.id);
      } catch (err) {
        safeLog('error', {
          event: 'pages_status_db_stats_error',
          request_id: requestId,
          page_id: page.id,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });
        // Non-fatal — proceed with zero stats
      }
    }

    // -----------------------------------------------------------------------
    // 6. Compute recent_issues
    //    TODO T-6-015 (onda 4): wire origin_not_allowed aggregation from
    //    config_origin_rejected_total metrics (docs/10-architecture/07-observability.md).
    //    For now, return empty array — no issue diagnosis in this T-ID.
    // -----------------------------------------------------------------------
    const recentIssues: RecentIssue[] = [];

    // -----------------------------------------------------------------------
    // 7. Compute health_state
    // -----------------------------------------------------------------------
    const healthState = computeHealthState(
      stats.lastPingAt,
      tokenStatus,
      token?.rotatedAt ?? null,
      recentIssues,
    );

    // -----------------------------------------------------------------------
    // 8. Build response
    //    BR-PRIVACY-001: no PII in response — only opaque IDs and metrics.
    //    Cache-Control: max-age=30 as per docs/70-ux/07-component-health-badges.md §7.
    // -----------------------------------------------------------------------
    const response: PageStatusResponse = {
      page_public_id: page.publicId,
      health_state: healthState,
      last_ping_at: stats.lastPingAt ? stats.lastPingAt.toISOString() : null,
      events_today: stats.eventsToday,
      events_last_24h: stats.eventsLast24h,
      token_status: tokenStatus,
      token_rotates_at: tokenRotatesAt,
      recent_issues: recentIssues,
    };

    safeLog('info', {
      event: 'pages_status_ok',
      request_id: requestId,
      page_id: page.id,
      health_state: healthState,
    });

    c.header('Cache-Control', 'max-age=30');

    return c.json(response, 200, { 'X-Request-Id': requestId });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance with no-op stubs (DB lookups return null).
// Callers should prefer createPagesStatusRoute(deps) to wire real DB.
// ---------------------------------------------------------------------------

/**
 * Default pagesStatusRoute instance — all DB lookups return stub values.
 *
 * Wire real dependencies in index.ts via:
 * ```ts
 * app.route('/v1/pages', createPagesStatusRoute({ getPageByPublicId, getActivePageToken, getPageEventStats }));
 * ```
 */
export const pagesStatusRoute = createPagesStatusRoute();
