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
  pages,
  workspaceMembers,
  type Db,
} from '@globaltracker/db';
import { and, eq, gte, isNotNull, like, sql } from 'drizzle-orm';
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

export type InboundWebhookHealth = {
  provider: 'guru' | 'onprofit' | 'sendflow' | 'hotmart' | 'kiwify' | 'stripe';
  last_received_at: string | null;
  minutes_since_last: number | null;
  count_1h: number;
  count_24h: number;
  /**
   * Health bucket. Thresholds:
   *   - ok:   last_received < 2h
   *   - warn: last_received in [2h, 6h)
   *   - down: last_received >= 6h AND count_7d >= 5 (had regular activity recently)
   * Providers with count_7d < 5 are omitted from response (never active enough to flag).
   */
  state: 'ok' | 'warn' | 'down';
};

export type DispatchHealthByDestination = {
  destination: string;
  total: number;
  succeeded: number;
  failed: number;
  dead_letter: number;
  success_rate: number | null;
  state: 'ok' | 'warn' | 'down';
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
    page_views: number;
    click_buy: number;
    leads: number;
    buyers: number;
  };
  tracking: {
    dispatch_success_rate: number | null;
    dead_letter_count: number;
    leads_with_fbclid_pct: number | null;
    leads_without_source_pct: number | null;
  };
  /**
   * Inbound/outbound integration health snapshot.
   * Used by the "Saúde Integrações" card on the dashboard home (ADR-046 follow-up).
   */
  integrations: {
    inbound: InboundWebhookHealth[];
    outbound: DispatchHealthByDestination[];
  };
  roas: number | null;
  spend: number;
  avg_daily_spend: number | null;
  /** Number of distinct dates in `ad_spend_daily` matching the period window. */
  spend_coverage_days: number;
  /** Calendar days the selected period nominally covers (1 for today, 7 for 7d, 30 for 30d). */
  period_days: number;
  /**
   * Subset of business metrics restricted to Meta-attributable buyers.
   * A buyer is Meta-attributable if any of their lead_attributions rows has
   * fbclid OR source IN ('meta','facebook','instagram','ig').
   */
  ads_meta: {
    revenue: number;
    buyers_unique: number;
    roas: number | null;
    share_of_revenue: number | null;
    share_of_buyers: number | null;
  };
  launches: LaunchStat[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function periodToCutoff(period: string): Date {
  const now = new Date();
  if (period === 'today') {
    // Start of today in BRT (UTC-3): midnight BRT = 03:00 UTC
    const brtNow = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    return new Date(Date.UTC(
      brtNow.getUTCFullYear(),
      brtNow.getUTCMonth(),
      brtNow.getUTCDate(),
      3, 0, 0, 0,
    ));
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

function periodToDays(period: string): number {
  if (period === 'today') return 1;
  if (period === '30d') return 30;
  return 7;
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
      const [
        funnelRows,
        pageViewRows,
        dispatchRows,
        attrRows,
        launchRows,
        spendRows,
        inboundRows,
        dispatchAllDestRows,
        metaAttrRows,
      ] =
        await Promise.all([
          // ── 1. Funnel (identified events) ────────────────────────────────
          db
            .select({
              clickBuyUnique: sql<number>`COUNT(DISTINCT ${events.leadId}) FILTER (
                WHERE ${events.eventName} LIKE 'custom:click_buy%'
              )::int`,
              leadsUnique: sql<number>`COUNT(DISTINCT ${events.leadId}) FILTER (WHERE ${events.eventName} = 'Lead')::int`,
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

          // ── 1b. PageViews únicos (sales pages, includes anonymous) ───────
          // Separate query: no isNotNull(leadId) — anonymous visitors counted via
          // COALESCE(lead_id, visitor_id, event pk) using raw SQL to avoid
          // Drizzle FILTER+EXISTS generation issues.
          db.execute<{ page_views_unique: number }>(sql`
            SELECT COUNT(DISTINCT COALESCE(
              e.lead_id::text,
              e.visitor_id,
              e.id::text
            ))::int AS page_views_unique
            FROM events e
            INNER JOIN pages p ON p.id = e.page_id AND p.role = 'sales'
            WHERE e.workspace_id = ${workspaceId}
              AND e.event_name = 'PageView'
              AND e.received_at >= ${cutoff.toISOString()}
              AND e.is_test = false
          `),

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

          // ── 5. Ad spend (for ROAS + avg daily) ──────────────────────────
          db
            .select({
              totalSpend: sql<string>`COALESCE(
                SUM(${adSpendDaily.spendCentsNormalized}),
                SUM(${adSpendDaily.spendCents}),
                0
              )::text`,
              daysWithSpend: sql<number>`COUNT(DISTINCT ${adSpendDaily.date})::int`,
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

          // ── 6. Inbound webhook heartbeats (always 7d window, period-independent) ──
          //
          // Provider classified via payload marker injected by each webhook handler:
          //   - Guru:     payload._guru_event_id     (apps/edge/src/routes/webhooks/guru.ts)
          //   - OnProfit: payload._onprofit_event_type (apps/edge/src/routes/webhooks/onprofit.ts)
          //   - SendFlow: payload._provider = 'sendflow'
          //   - Hotmart:  payload._hotmart_event_type
          //
          // Window is fixed at 7d regardless of selected dashboard period because
          // integration health is operational state, not business window.
          db.execute<{
            provider: string;
            last_received_at: string | null;
            count_24h: number;
            count_1h: number;
            count_7d: number;
          }>(sql`
            WITH classified AS (
              SELECT
                CASE
                  WHEN payload ? '_guru_event_id' THEN 'guru'
                  WHEN payload ? '_onprofit_event_type' THEN 'onprofit'
                  WHEN payload->>'_provider' = 'sendflow' THEN 'sendflow'
                  WHEN payload ? '_hotmart_event_type' THEN 'hotmart'
                  WHEN payload ? '_kiwify_event_type' THEN 'kiwify'
                  WHEN payload ? '_stripe_event_type' THEN 'stripe'
                  ELSE NULL
                END AS provider,
                received_at
              FROM raw_events
              WHERE workspace_id = ${workspaceId}
                AND received_at >= NOW() - INTERVAL '7 days'
            )
            SELECT
              provider,
              MAX(received_at) AS last_received_at,
              COUNT(*) FILTER (WHERE received_at >= NOW() - INTERVAL '24 hours')::int AS count_24h,
              COUNT(*) FILTER (WHERE received_at >= NOW() - INTERVAL '1 hour')::int AS count_1h,
              COUNT(*)::int AS count_7d
            FROM classified
            WHERE provider IS NOT NULL
            GROUP BY provider
          `),

          // ── 7. Dispatch health by destination (last 24h, period-independent) ──
          // Mirrors the dispatch_jobs aggregation but fixed at 24h window for
          // operational state (vs business period window).
          db
            .select({
              destination: dispatchJobs.destination,
              succeeded: sql<number>`COUNT(*) FILTER (WHERE ${dispatchJobs.status} = 'succeeded')::int`,
              failed: sql<number>`COUNT(*) FILTER (WHERE ${dispatchJobs.status} = 'failed')::int`,
              deadLetter: sql<number>`COUNT(*) FILTER (WHERE ${dispatchJobs.status} = 'dead_letter')::int`,
              total: sql<number>`COUNT(*)::int`,
            })
            .from(dispatchJobs)
            .where(
              and(
                eq(dispatchJobs.workspaceId, workspaceId),
                gte(
                  dispatchJobs.createdAt,
                  sql`NOW() - INTERVAL '24 hours'`,
                ),
              ),
            )
            .groupBy(dispatchJobs.destination),

          // ── 8. Meta-attributable purchases (any-touch attribution) ────────
          // Lead is "Meta-atribuível" if it has ≥1 lead_attributions row with
          // fbclid OR source IN ('meta','facebook','instagram','ig'). Inclusive
          // model: includes both paid clicks (fbclid) and organic Meta/IG UTM.
          db.execute<{ buyers_unique: number; revenue: string }>(sql`
            SELECT
              COUNT(DISTINCT e.lead_id)::int AS buyers_unique,
              COALESCE(SUM(
                (SELECT NULLIF(v, '')::numeric
                 FROM (
                   SELECT
                     CASE
                       WHEN jsonb_typeof(e.custom_data) = 'object' THEN
                         COALESCE(e.custom_data ->> 'value', e.custom_data ->> 'amount', NULL)
                       WHEN jsonb_typeof(e.custom_data) = 'string' THEN
                         COALESCE(
                           (e.custom_data #>> '{}')::jsonb ->> 'value',
                           (e.custom_data #>> '{}')::jsonb ->> 'amount',
                           NULL
                         )
                       ELSE NULL
                     END AS v
                 ) sub)
              ), 0)::text AS revenue
            FROM events e
            WHERE e.workspace_id = ${workspaceId}
              AND e.event_name = 'Purchase'
              AND e.received_at >= ${cutoff.toISOString()}
              AND e.is_test = false
              AND e.lead_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM lead_attributions la
                WHERE la.lead_id = e.lead_id
                  AND (
                    la.fbclid IS NOT NULL
                    OR la.source IN ('meta', 'facebook', 'instagram', 'ig')
                  )
              )
          `),
        ]);

      // ── Shape results ──────────────────────────────────────────────────

      const f = funnelRows[0];
      const pageViewsUnique = Number(pageViewRows[0]?.page_views_unique ?? 0);
      const clickBuyUnique = Number(f?.clickBuyUnique ?? 0);
      const leadsUnique = Number(f?.leadsUnique ?? 0);
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

      // ── Integration health ──────────────────────────────────────────────
      //
      // Inbound: classify state by recency, omit providers with too little activity
      //          (count_7d < 5) — never enough signal to flag confidently.
      const inboundProviders: InboundWebhookHealth[] = [];
      const nowMs = Date.now();
      for (const row of inboundRows) {
        const count7d = Number(row.count_7d ?? 0);
        if (count7d < 5) continue; // signal too thin to evaluate

        const lastIso = row.last_received_at;
        const lastMs = lastIso ? new Date(lastIso).getTime() : null;
        const minutesSince =
          lastMs != null ? Math.round((nowMs - lastMs) / 60000) : null;

        let state: InboundWebhookHealth['state'];
        if (minutesSince == null || minutesSince > 360) state = 'down';
        else if (minutesSince > 120) state = 'warn';
        else state = 'ok';

        inboundProviders.push({
          provider: row.provider as InboundWebhookHealth['provider'],
          last_received_at: lastIso,
          minutes_since_last: minutesSince,
          count_1h: Number(row.count_1h ?? 0),
          count_24h: Number(row.count_24h ?? 0),
          state,
        });
      }
      // Stable order: down → warn → ok, alphabetical within bucket.
      const stateRank = { down: 0, warn: 1, ok: 2 } as const;
      inboundProviders.sort((a, b) => {
        const r = stateRank[a.state] - stateRank[b.state];
        if (r !== 0) return r;
        return a.provider.localeCompare(b.provider);
      });

      // Outbound: classify per destination.
      const outboundDestinations: DispatchHealthByDestination[] = dispatchAllDestRows
        .map((row) => {
          const total = Number(row.total ?? 0);
          const succeeded = Number(row.succeeded ?? 0);
          const failed = Number(row.failed ?? 0);
          const deadLetter = Number(row.deadLetter ?? 0);
          const denom = succeeded + failed;
          const successRate = denom > 0 ? succeeded / denom : null;
          let state: DispatchHealthByDestination['state'];
          if (deadLetter > 0 || (successRate != null && successRate < 0.9)) state = 'down';
          else if (successRate != null && successRate < 0.98) state = 'warn';
          else state = 'ok';
          return {
            destination: String(row.destination),
            total,
            succeeded,
            failed,
            dead_letter: deadLetter,
            success_rate: successRate,
            state,
          };
        })
        .sort((a, b) => {
          const r = stateRank[a.state] - stateRank[b.state];
          if (r !== 0) return r;
          return a.destination.localeCompare(b.destination);
        });

      const spendCents = Number(spendRows[0]?.totalSpend ?? 0);
      const daysWithSpend = Number(spendRows[0]?.daysWithSpend ?? 0);
      const spend = spendCents / 100;
      const roas = spendCents > 0 && revenue > 0 ? revenue / spend : null;
      const avgDailySpend = daysWithSpend > 0 ? spend / daysWithSpend : null;

      // ── Meta-attributable subset ─────────────────────────────────────────
      const metaRow = (metaAttrRows as unknown as Array<{ buyers_unique: number; revenue: string }>)[0];
      const metaRevenue = Number(metaRow?.revenue ?? 0);
      const metaBuyersUnique = Number(metaRow?.buyers_unique ?? 0);
      const metaRoas = spendCents > 0 && metaRevenue > 0 ? metaRevenue / spend : null;
      const metaRevenueShare = revenue > 0 ? metaRevenue / revenue : null;
      const metaBuyersShare = buyersUnique > 0 ? metaBuyersUnique / buyersUnique : null;

      const body: DashboardStatsResponse = {
        period: periodParam,
        business: {
          revenue,
          buyers_unique: buyersUnique,
          avg_ticket: buyersUnique > 0 ? revenue / buyersUnique : 0,
          conversion_rate: leadsUnique > 0 ? buyersUnique / leadsUnique : 0,
        },
        funnel: {
          page_views: pageViewsUnique,
          click_buy: clickBuyUnique,
          leads: leadsUnique,
          buyers: buyersUnique,
        },
        tracking: {
          dispatch_success_rate: dispatchSuccessRate,
          dead_letter_count: deadLetterCount,
          leads_with_fbclid_pct:
            attrTotal > 0 ? leadsWithFbclid / attrTotal : null,
          leads_without_source_pct:
            attrTotal > 0 ? leadsWithoutSource / attrTotal : null,
        },
        integrations: {
          inbound: inboundProviders,
          outbound: outboundDestinations,
        },
        roas,
        spend,
        avg_daily_spend: avgDailySpend,
        spend_coverage_days: daysWithSpend,
        period_days: periodToDays(periodParam),
        ads_meta: {
          revenue: metaRevenue,
          buyers_unique: metaBuyersUnique,
          roas: metaRoas,
          share_of_revenue: metaRevenueShare,
          share_of_buyers: metaBuyersShare,
        },
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
