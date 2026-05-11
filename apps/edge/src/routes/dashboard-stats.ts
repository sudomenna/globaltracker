/**
 * routes/dashboard-stats.ts — GET /v1/dashboard/stats
 *
 * Workspace-level dashboard metrics aggregated over a configurable period.
 *
 * Query params:
 *   period: 'today' | '7d' | '30d'  (default: '7d')
 *
 * Response shape: DashboardStatsResponse (see type below).
 *
 * Auth: supabaseJwtMiddleware (same as leads-summary).
 * Cache: private, max-age=60 — refreshed once per minute per client.
 *
 * BR-PRIVACY-001: zero PII in response or logs.
 * BR-RBAC-002: workspace_id from JWT context, all queries scoped by it.
 * INV-EVENT-*: is_test=false filter applied on all event queries.
 */

import {
  adSpendDaily,
  createDb,
  dispatchJobs,
  events,
  launches,
  leadAttributions,
  workspaceMembers,
  type Db,
} from '@globaltracker/db';
import { and, eq, gte, isNotNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
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
// Public response type
// ---------------------------------------------------------------------------

export type LaunchStat = {
  public_id: string;
  name: string;
  status: string;
  leads: number;
  buyers: number;
  revenue: number;
};

export type DashboardStatsResponse = {
  period: string;
  business: {
    revenue: number;
    buyers_unique: number;
    avg_ticket: number;
    conversion_rate: number;
  };
  funnel: {
    leads: number;
    initiate_checkout: number;
    buyers: number;
    lead_to_checkout_rate: number;
    checkout_to_buyer_rate: number;
  };
  tracking: {
    dispatch_success_rate: number | null;
    dead_letter_count: number;
    leads_with_fbclid_pct: number | null;
    leads_without_source_pct: number | null;
  };
  roas: number | null;
  spend: number;
  launches: LaunchStat[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function periodToCutoff(period: string): Date {
  const now = new Date();
  if (period === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === '30d') {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return d;
  }
  // default: 7d
  const d = new Date(now);
  d.setDate(d.getDate() - 7);
  return d;
}

// Defensive JSONB value extraction reused in SUM aggregates.
// Mirrors the pattern in lead-summary.ts (same invariant about legacy string-encoded jsonb).
const purchaseValueExpr = (cdCol: ReturnType<typeof sql>) => sql<string | null>`(
  SELECT NULLIF(v, '')::numeric
  FROM (
    SELECT
      CASE
        WHEN jsonb_typeof(${cdCol}) = 'object' THEN
          COALESCE(${cdCol} ->> 'value', ${cdCol} ->> 'amount', NULL)
        WHEN jsonb_typeof(${cdCol}) = 'string' THEN
          COALESCE(
            (${cdCol} #>> '{}')::jsonb ->> 'value',
            (${cdCol} #>> '{}')::jsonb ->> 'amount',
            NULL
          )
        ELSE NULL
      END AS v
  ) _pv
)`;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createDashboardStatsRoute(opts: {
  getConnStr: (env: AppBindings) => string;
  buildDb?: (env: AppBindings) => Db;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  function resolveDb(env: AppBindings): Db {
    return opts.buildDb ? opts.buildDb(env) : createDb(opts.getConnStr(env));
  }

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
  // GET /stats
  // -------------------------------------------------------------------------
  route.get('/stats', async (c) => {
    const requestId =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();
    const workspaceId = c.get('workspace_id') as string | undefined;
    if (!workspaceId) {
      return c.json(
        { code: 'unauthorized', request_id: requestId },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    const periodParam = c.req.query('period') ?? '7d';
    const cutoff = periodToCutoff(periodParam);
    const db = resolveDb(c.env);

    try {
      // Run all queries in parallel — independent DB reads.
      const [funnelRows, dispatchRows, attrRows, launchRows, spendRows] =
        await Promise.all([
          // ── 1. Funnel + Revenue ──────────────────────────────────────────
          db
            .select({
              leadsUnique: sql<number>`COUNT(DISTINCT ${events.leadId}) FILTER (WHERE ${events.eventName} = 'Lead')::int`,
              icUnique: sql<number>`COUNT(DISTINCT ${events.leadId}) FILTER (WHERE ${events.eventName} = 'InitiateCheckout')::int`,
              buyersUnique: sql<number>`COUNT(DISTINCT ${events.leadId}) FILTER (WHERE ${events.eventName} = 'Purchase')::int`,
              revenue: sql<string>`COALESCE(SUM(
                CASE WHEN ${events.eventName} = 'Purchase' THEN
                  ${purchaseValueExpr(sql`${events.customData}`)}
                ELSE NULL END
              ), 0)::text`,
            })
            .from(events)
            .where(
              and(
                eq(events.workspaceId, workspaceId),
                gte(events.receivedAt, cutoff),
                eq(events.isTest, false),
                isNotNull(events.leadId),
              ),
            ),

          // ── 2. Dispatch health by destination ───────────────────────────
          db
            .select({
              destination: dispatchJobs.destination,
              succeeded: sql<number>`COUNT(*) FILTER (WHERE ${dispatchJobs.status} = 'succeeded')::int`,
              deadLetter: sql<number>`COUNT(*) FILTER (WHERE ${dispatchJobs.status} = 'dead_letter')::int`,
              total: sql<number>`COUNT(*)::int`,
            })
            .from(dispatchJobs)
            .where(
              and(
                eq(dispatchJobs.workspaceId, workspaceId),
                gte(dispatchJobs.createdAt, cutoff),
              ),
            )
            .groupBy(dispatchJobs.destination),

          // ── 3. Attribution coverage ──────────────────────────────────────
          // Leads from Lead events in period → check fbclid and UTM source.
          // Uses NOT EXISTS / EXISTS subqueries to avoid cross-product from
          // multiple attribution rows per lead (multi-launch scenario).
          db
            .select({
              totalLeads: sql<number>`COUNT(DISTINCT ${events.leadId})::int`,
              leadsWithFbclid: sql<number>`COUNT(DISTINCT ${events.leadId}) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM lead_attributions _la
                  WHERE _la.lead_id = ${events.leadId}
                    AND _la.workspace_id = ${events.workspaceId}
                    AND _la.fbclid IS NOT NULL
                )
              )::int`,
              leadsWithoutSource: sql<number>`COUNT(DISTINCT ${events.leadId}) FILTER (
                WHERE NOT EXISTS (
                  SELECT 1 FROM lead_attributions _la
                  WHERE _la.lead_id = ${events.leadId}
                    AND _la.workspace_id = ${events.workspaceId}
                    AND _la.source IS NOT NULL
                )
              )::int`,
            })
            .from(events)
            .where(
              and(
                eq(events.workspaceId, workspaceId),
                eq(events.eventName, 'Lead'),
                gte(events.receivedAt, cutoff),
                eq(events.isTest, false),
                isNotNull(events.leadId),
              ),
            ),

          // ── 4. Per-launch breakdown (live + recently ended) ──────────────
          db
            .select({
              publicId: launches.publicId,
              name: launches.name,
              status: launches.status,
              leads: sql<number>`COUNT(DISTINCT CASE WHEN ${events.eventName} = 'Lead' THEN ${events.leadId} END)::int`,
              buyers: sql<number>`COUNT(DISTINCT CASE WHEN ${events.eventName} = 'Purchase' THEN ${events.leadId} END)::int`,
              revenue: sql<string>`COALESCE(SUM(
                CASE WHEN ${events.eventName} = 'Purchase' THEN
                  ${purchaseValueExpr(sql`${events.customData}`)}
                ELSE NULL END
              ), 0)::text`,
            })
            .from(launches)
            .leftJoin(
              events,
              and(
                eq(events.launchId, launches.id),
                gte(events.receivedAt, cutoff),
                eq(events.isTest, false),
              ),
            )
            .where(
              and(
                eq(launches.workspaceId, workspaceId),
                sql`${launches.status} IN ('live', 'ended', 'configuring')`,
              ),
            )
            .groupBy(launches.id, launches.publicId, launches.name, launches.status)
            .limit(20),

          // ── 5. Ad spend (for ROAS) ───────────────────────────────────────
          db
            .select({
              totalSpend: sql<string>`COALESCE(
                SUM(${adSpendDaily.spendCentsNormalized}),
                SUM(${adSpendDaily.spendCents}),
                0
              )::text`,
            })
            .from(adSpendDaily)
            .where(
              and(
                eq(adSpendDaily.workspaceId, workspaceId),
                gte(
                  sql`${adSpendDaily.date}::date`,
                  sql`${cutoff.toISOString().slice(0, 10)}::date`,
                ),
              ),
            ),
        ]);

      // ── Shape results ──────────────────────────────────────────────────

      const f = funnelRows[0];
      const leadsUnique = Number(f?.leadsUnique ?? 0);
      const icUnique = Number(f?.icUnique ?? 0);
      const buyersUnique = Number(f?.buyersUnique ?? 0);
      const revenue = Number(f?.revenue ?? 0);

      let totalDispatches = 0;
      let succeededDispatches = 0;
      let deadLetterCount = 0;
      for (const row of dispatchRows) {
        totalDispatches += Number(row.total ?? 0);
        succeededDispatches += Number(row.succeeded ?? 0);
        deadLetterCount += Number(row.deadLetter ?? 0);
      }
      const dispatchSuccessRate =
        totalDispatches > 0 ? succeededDispatches / totalDispatches : null;

      const a = attrRows[0];
      const attrTotal = Number(a?.totalLeads ?? 0);
      const leadsWithFbclid = Number(a?.leadsWithFbclid ?? 0);
      const leadsWithoutSource = Number(a?.leadsWithoutSource ?? 0);

      const launchStats: LaunchStat[] = launchRows
        .map((r) => ({
          public_id: String(r.publicId),
          name: String(r.name),
          status: String(r.status),
          leads: Number(r.leads ?? 0),
          buyers: Number(r.buyers ?? 0),
          revenue: Number(r.revenue ?? 0),
        }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);

      const spendCents = Number(spendRows[0]?.totalSpend ?? 0);
      const roas =
        spendCents > 0 && revenue > 0 ? revenue / (spendCents / 100) : null;

      const body: DashboardStatsResponse = {
        period: periodParam,
        business: {
          revenue,
          buyers_unique: buyersUnique,
          avg_ticket: buyersUnique > 0 ? revenue / buyersUnique : 0,
          conversion_rate: leadsUnique > 0 ? buyersUnique / leadsUnique : 0,
        },
        funnel: {
          leads: leadsUnique,
          initiate_checkout: icUnique,
          buyers: buyersUnique,
          lead_to_checkout_rate:
            leadsUnique > 0 ? icUnique / leadsUnique : 0,
          checkout_to_buyer_rate: icUnique > 0 ? buyersUnique / icUnique : 0,
        },
        tracking: {
          dispatch_success_rate: dispatchSuccessRate,
          dead_letter_count: deadLetterCount,
          leads_with_fbclid_pct:
            attrTotal > 0 ? leadsWithFbclid / attrTotal : null,
          leads_without_source_pct:
            attrTotal > 0 ? leadsWithoutSource / attrTotal : null,
        },
        roas,
        spend: spendCents / 100,
        launches: launchStats,
      };

      return c.json(body, 200, {
        'X-Request-Id': requestId,
        'Cache-Control': 'private, max-age=60',
      });
    } catch (err) {
      safeLog('error', {
        event: 'dashboard_stats_error',
        request_id: requestId,
        error_type: err instanceof Error ? err.constructor.name : typeof err,
        error_msg: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { code: 'internal_error', request_id: requestId },
        500,
        { 'X-Request-Id': requestId },
      );
    }
  });

  return route;
}
