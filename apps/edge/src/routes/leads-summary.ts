/**
 * routes/leads-summary.ts — GET /v1/leads/:public_id/summary
 *
 * T-17-007 (Sprint 17 — Lead Detail Observability).
 *
 * Returns an aggregated, non-PII state snapshot of a single lead:
 *   - current_stage + stages_journey (ASC)
 *   - tags (snapshot)
 *   - attribution_summary (first/last touch + click ids)
 *   - consent_current (5 finalities, latest row)
 *   - metrics (events_total, dispatches_*, purchase_total_brl, last_activity_at)
 *
 * Auth + RBAC:
 *   Reuses supabaseJwtMiddleware via the same lookup helper as leads-timeline.
 *   Any authenticated workspace member may read this endpoint — the response
 *   contains zero PII (BR-PRIVACY-001), so role gating is unnecessary beyond
 *   workspace membership (BR-RBAC-002).
 *
 * BR-IDENTITY-013: route param is lead_public_id = leads.id; never returns or
 *   logs an internal-only identifier.
 * BR-PRIVACY-001: response carries no email/phone/name/hashes; logs are
 *   sanitized (request_id only, no PII).
 *
 * Cache:
 *   `Cache-Control: private, max-age=15` — summary state can shift the moment
 *   a new event lands; 15s window matches the pace of the live console.
 */

import {
  createDb,
  workspaceMembers,
  type Db,
} from '@globaltracker/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  buildLeadSummary,
  type LeadSummary,
} from '../lib/lead-summary.js';
import { isValidRole } from '../lib/rbac.js';
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
  request_id?: string;
  role?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Zod response schema (T-17-008)
// ---------------------------------------------------------------------------

const utmSchema = z
  .object({
    utm_source: z.string().optional(),
    utm_medium: z.string().optional(),
    utm_campaign: z.string().optional(),
    utm_content: z.string().optional(),
    utm_term: z.string().optional(),
  })
  .strict();

export const leadSummaryResponseSchema = z
  .object({
    current_stage: z
      .object({
        stage: z.string(),
        since: z.string(),
      })
      .nullable(),
    stages_journey: z.array(
      z.object({ stage: z.string(), at: z.string() }).strict(),
    ),
    tags: z.array(
      z
        .object({
          tag_name: z.string(),
          set_by: z.string(),
          set_at: z.string(),
        })
        .strict(),
    ),
    attribution_summary: z
      .object({
        first_touch: utmSchema.nullable(),
        last_touch: utmSchema.nullable(),
        fbclid: z.string().nullable(),
        gclid: z.string().nullable(),
      })
      .strict(),
    consent_current: z
      .object({
        analytics: z.boolean(),
        marketing: z.boolean(),
        ad_user_data: z.boolean(),
        ad_personalization: z.boolean(),
        customer_match: z.boolean(),
        updated_at: z.string(),
      })
      .strict()
      .nullable(),
    metrics: z
      .object({
        events_total: z.number().int().nonnegative(),
        dispatches_ok: z.number().int().nonnegative(),
        dispatches_failed: z.number().int().nonnegative(),
        dispatches_skipped: z.number().int().nonnegative(),
        purchase_total_brl: z.number().nonnegative(),
        last_activity_at: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export type LeadSummaryResponse = z.infer<typeof leadSummaryResponseSchema>;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export type CreateLeadsSummaryRouteOpts = {
  /** Connection string resolver — same shape as leads-timeline route. */
  getConnStr: (env: AppBindings) => string;
  /**
   * Optional injectable DB factory — primarily for tests. When omitted,
   * createDb(getConnStr(env)) is used per request.
   */
  buildDb?: (env: AppBindings) => Db;
  /**
   * Optional injectable summary builder — primarily for tests. When omitted,
   * the production buildLeadSummary is used.
   */
  buildSummary?: (params: {
    db: Db;
    leadId: string;
    workspaceId: string;
  }) => Promise<
    | { ok: true; value: LeadSummary }
    | { ok: false; error: { code: string; cause?: string } }
  >;
};

export function createLeadsSummaryRoute(
  opts: CreateLeadsSummaryRouteOpts,
): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveDb(env: AppBindings): Db {
    if (opts.buildDb) return opts.buildDb(env);
    return createDb(opts.getConnStr(env));
  }

  // -------------------------------------------------------------------------
  // Auth middleware — same JWT verification + workspace_member lookup as
  // leads-timeline. Mirrored here so this sub-router can be mounted standalone
  // before leads-timeline in index.ts (Hono matches the first registered
  // route, so /:public_id/summary must be registered before /:public_id).
  // -------------------------------------------------------------------------
  const buildLookupMember = (env: AppBindings): LookupWorkspaceMemberFn => {
    return async (userId: string) => {
      const connStr = opts.getConnStr(env);
      if (!connStr) return null;
      const db = createDb(connStr);
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
      lookupMember: buildLookupMember(c.env),
    });
    return mw(c, next);
  });

  // -------------------------------------------------------------------------
  // GET /:public_id/summary
  // -------------------------------------------------------------------------
  route.get('/:public_id/summary', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      // BR-PRIVACY-001: error body never carries PII; only request_id.
      return c.json(
        { code: 'unauthorized', request_id: requestId },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    const publicId = c.req.param('public_id');
    if (!publicId || publicId.trim() === '') {
      return c.json(
        {
          code: 'validation_error',
          message: 'public_id is required',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const db = resolveDb(c.env);

    // BR-IDENTITY-013: lead_public_id = leads.id (UUID). buildLeadSummary
    // performs the workspace-scoped existence check before fanning queries.
    const builder = opts.buildSummary ?? buildLeadSummary;
    const result = await builder({
      db,
      leadId: publicId,
      workspaceId,
    });

    if (!result.ok) {
      if (result.error.code === 'lead_not_found') {
        return c.json(
          { code: 'lead_not_found', request_id: requestId },
          404,
          { 'X-Request-Id': requestId },
        );
      }
      // db_error or any unexpected error — log sanitized, return generic 500.
      // BR-PRIVACY-001: only the error class name is logged, never query data.
      safeLog('error', {
        event: 'leads_summary_db_error',
        request_id: requestId,
        error_code: result.error.code,
        error_cause: 'cause' in result.error ? result.error.cause : undefined,
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    // Validate response with Zod before sending — guards against drift
    // between the lib's LeadSummary type and the wire schema.
    const parsed = leadSummaryResponseSchema.safeParse(result.value);
    if (!parsed.success) {
      safeLog('error', {
        event: 'leads_summary_response_schema_drift',
        request_id: requestId,
        issues_count: parsed.error.issues.length,
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    return c.json(parsed.data, 200, {
      'X-Request-Id': requestId,
      // 15s private cache — summary state shifts as new events land; this
      // window matches the live console refresh cadence.
      'Cache-Control': 'private, max-age=15',
    });
  });

  return route;
}
