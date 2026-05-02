/**
 * routes/health-cp.ts — GET /v1/health/integrations + GET /v1/health/workspace
 *
 * Control Plane health endpoints. Aggregates dispatch_jobs and pages data to
 * compute health states for integrations and workspace.
 *
 * CONTRACT-api-health-integrations-v1
 * CONTRACT-api-health-workspace-v1
 *
 * ORCHESTRATOR MOUNT (adicionar em apps/edge/src/index.ts após as outras rotas):
 * import { healthCpRoute } from './routes/health-cp.js';
 * app.route('/v1/health', healthCpRoute);
 *
 * Auth (Sprint 6 placeholder — real JWT validation in auth-cp.ts middleware):
 *   Requires `Authorization: Bearer <token>` header.
 *   Missing / empty → 401.
 *
 * Cache: Cache-Control: max-age=30 on all successful responses (B.4 §7).
 *
 * BR-PRIVACY-001: zero PII in logs and error responses.
 * BR-RBAC-002: workspace_id is multi-tenant anchor — all queries scoped by workspace_id.
 */

import { Hono } from 'hono';
import { safeLog } from '../middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// Bindings / env types
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
};

type AppVariables = {
  workspace_id: string;
  request_id: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Health state enum
// ---------------------------------------------------------------------------

type HealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/**
 * Shape returned by GET /v1/health/integrations
 * CONTRACT-api-health-integrations-v1
 */
export type IntegrationsHealthResponse = {
  state: HealthState;
  providers: Array<{
    provider: string;
    state: HealthState;
    events_24h: number;
    failures_24h: number;
    skipped_24h: number;
    failure_rate: number;
    dlq_count: number;
  }>;
};

/**
 * Shape returned by GET /v1/health/workspace
 * CONTRACT-api-health-workspace-v1
 */
export type WorkspaceHealthResponse = {
  state: HealthState;
  /** PT-BR: "Tudo OK" | "N incidente(s)" | "Crítico" */
  summary: string;
  incidents: Array<{
    type:
      | 'integration_failure'
      | 'page_no_ping'
      | 'dlq'
      | 'audience_sync_failed';
    target: string;
    message: string;
    severity: 'warning' | 'critical';
    link: string;
  }>;
};

// ---------------------------------------------------------------------------
// Aggregated row returned from DB query
// ---------------------------------------------------------------------------

export type DispatchHealthRow = {
  destination: string;
  succeeded: number;
  failed: number;
  skipped: number;
  dlq_count: number;
  total: number;
};

export type PageNoPingRow = {
  public_id: string;
};

// ---------------------------------------------------------------------------
// Injected DB functions (for testability)
// ---------------------------------------------------------------------------

/**
 * Fetches dispatch_jobs aggregated by destination for the last 24h.
 * domain-author wires this via Drizzle + Hyperdrive.
 */
export type GetDispatchHealthFn = (
  workspaceId: string,
) => Promise<DispatchHealthRow[]>;

/**
 * Fetches pages with integration_mode='b_snippet' that have no ping in the
 * last 24h (or have never received a ping).
 * domain-author wires this via Drizzle + Hyperdrive.
 */
export type GetPageNoPingFn = (workspaceId: string) => Promise<PageNoPingRow[]>;

// ---------------------------------------------------------------------------
// Health aggregation logic
// ---------------------------------------------------------------------------

/**
 * Compute per-provider health state from dispatch stats.
 *
 * Rules (docs/70-ux/07-component-health-badges.md §3):
 * - unhealthy: dlq_count > 0 OR failure_rate >= 0.05
 * - degraded: failure_rate in [0.01, 0.05)
 * - healthy: otherwise
 * - unknown: no data (never used here — callers filter empty providers)
 */
export function computeProviderState(row: DispatchHealthRow): HealthState {
  const denominator = row.succeeded + row.failed;
  const failureRate = denominator > 0 ? row.failed / denominator : 0;

  // BR-DISPATCH-005: dead_letter is terminal failure state
  if (row.dlq_count > 0 || failureRate >= 0.05) return 'unhealthy';
  if (failureRate >= 0.01) return 'degraded';
  return 'healthy';
}

/**
 * Aggregate overall health state from a list of per-provider states.
 *
 * Rules (docs/70-ux/07-component-health-badges.md §3):
 * - unknown: no providers
 * - unhealthy: any provider unhealthy
 * - degraded: any provider degraded
 * - healthy: all providers healthy
 */
export function aggregateState(states: HealthState[]): HealthState {
  if (states.length === 0) return 'unknown';
  if (states.some((s) => s === 'unhealthy')) return 'unhealthy';
  if (states.some((s) => s === 'degraded')) return 'degraded';
  return 'healthy';
}

/**
 * Generate PT-BR summary string for workspace health.
 * docs/70-ux/07-component-health-badges.md §5
 */
function buildSummary(incidentCount: number, hasCritical: boolean): string {
  if (incidentCount === 0) return 'Tudo OK';
  if (hasCritical) return 'Crítico';
  if (incidentCount === 1) return '1 incidente';
  return `${incidentCount} incidentes`;
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the /v1/health sub-router with injected dependencies.
 *
 * Usage in index.ts (wired by orchestrator):
 * ```ts
 * import { createHealthCpRoute } from './routes/health-cp.js';
 * app.route('/v1/health', createHealthCpRoute({ getDispatchHealth, getPageNoPing }));
 * ```
 *
 * @param deps.getDispatchHealth - fetches dispatch aggregation for workspace
 * @param deps.getPageNoPing     - fetches pages without recent ping
 */
export function createHealthCpRoute(deps?: {
  getDispatchHealth?: GetDispatchHealthFn;
  getPageNoPing?: GetPageNoPingFn;
}): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // -------------------------------------------------------------------------
  // Shared auth guard (placeholder — Sprint 6 T-6-004)
  // TODO Sprint 6: replace with middleware auth-cp.ts that validates Supabase JWT
  // and injects workspace_id + role into context.
  // -------------------------------------------------------------------------
  route.use('*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // BR-PRIVACY-001: no PII in 401 response
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
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

    await next();
  });

  // -------------------------------------------------------------------------
  // GET /integrations
  // CONTRACT-api-health-integrations-v1
  // -------------------------------------------------------------------------
  route.get('/integrations', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // BR-RBAC-002: workspace_id from context (set by auth middleware)
    const workspaceId =
      (c.get('workspace_id') as string | undefined) ?? 'unknown';

    // -----------------------------------------------------------------------
    // Fetch dispatch stats
    // -----------------------------------------------------------------------
    let rows: DispatchHealthRow[] = [];

    if (deps?.getDispatchHealth) {
      try {
        rows = await deps.getDispatchHealth(workspaceId);
      } catch (err) {
        // BR-PRIVACY-001: no PII in logs
        safeLog('error', {
          event: 'health_cp_integrations_db_error',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });

        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to fetch integration health',
            request_id: requestId,
          },
          500,
          { 'X-Request-Id': requestId },
        );
      }
    }

    // -----------------------------------------------------------------------
    // Build per-provider stats
    // -----------------------------------------------------------------------
    const providers = rows.map((row) => {
      const denominator = row.succeeded + row.failed;
      const failureRate = denominator > 0 ? row.failed / denominator : 0;
      const state = computeProviderState(row);

      return {
        provider: row.destination,
        state,
        events_24h: row.total,
        failures_24h: row.failed,
        skipped_24h: row.skipped,
        failure_rate: failureRate,
        dlq_count: row.dlq_count,
      };
    });

    // Aggregate overall state
    // docs/70-ux/07-component-health-badges.md §3
    const overallState = aggregateState(providers.map((p) => p.state));

    const body: IntegrationsHealthResponse = {
      state: overallState,
      providers,
    };

    // Cache-Control: max-age=30 (docs/70-ux/07-component-health-badges.md §7)
    return c.json(body, 200, {
      'X-Request-Id': requestId,
      'Cache-Control': 'max-age=30',
    });
  });

  // -------------------------------------------------------------------------
  // GET /workspace
  // CONTRACT-api-health-workspace-v1
  // -------------------------------------------------------------------------
  route.get('/workspace', async (c) => {
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // BR-RBAC-002: workspace_id scoped by auth middleware
    const workspaceId =
      (c.get('workspace_id') as string | undefined) ?? 'unknown';

    // -----------------------------------------------------------------------
    // Fetch dispatch stats + pages without ping in parallel
    // -----------------------------------------------------------------------
    let dispatchRows: DispatchHealthRow[] = [];
    let noPingPages: PageNoPingRow[] = [];

    if (deps?.getDispatchHealth || deps?.getPageNoPing) {
      try {
        const [dispatchResult, noPingResult] = await Promise.all([
          deps.getDispatchHealth
            ? deps.getDispatchHealth(workspaceId)
            : Promise.resolve([]),
          deps.getPageNoPing
            ? deps.getPageNoPing(workspaceId)
            : Promise.resolve([]),
        ]);
        dispatchRows = dispatchResult;
        noPingPages = noPingResult;
      } catch (err) {
        // BR-PRIVACY-001: no PII in logs
        safeLog('error', {
          event: 'health_cp_workspace_db_error',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : typeof err,
        });

        return c.json(
          {
            code: 'internal_error',
            message: 'Failed to fetch workspace health',
            request_id: requestId,
          },
          500,
          { 'X-Request-Id': requestId },
        );
      }
    }

    // -----------------------------------------------------------------------
    // Build incidents list
    // docs/70-ux/07-component-health-badges.md §5
    // -----------------------------------------------------------------------
    const incidents: WorkspaceHealthResponse['incidents'] = [];

    for (const row of dispatchRows) {
      const denominator = row.succeeded + row.failed;
      const failureRate = denominator > 0 ? row.failed / denominator : 0;

      // Incident: DLQ (critical)
      // BR-DISPATCH-005: dead_letter is terminal failure → critical incident
      if (row.dlq_count > 0) {
        incidents.push({
          type: 'dlq',
          target: row.destination,
          message: `${row.dlq_count} evento${row.dlq_count !== 1 ? 's' : ''} falhou definitivamente para ${row.destination}`,
          severity: 'critical',
          link: `/integrations/${row.destination}`,
        });
      }

      // Incident: high failure rate (warning)
      // Only when not already flagged as DLQ to avoid double-counting
      if (row.dlq_count === 0 && failureRate >= 0.05) {
        const pct = Math.round(failureRate * 100);
        incidents.push({
          type: 'integration_failure',
          target: row.destination,
          message: `Taxa de falha de ${pct}% para ${row.destination} nas últimas 24h`,
          severity: 'warning',
          link: `/integrations/${row.destination}`,
        });
      }
    }

    // Incident: pages without ping (warning)
    // BR-PRIVACY-001: public_id is a non-PII slug
    for (const page of noPingPages) {
      incidents.push({
        type: 'page_no_ping',
        target: page.public_id,
        message: `Página ${page.public_id} sem pings há mais de 24h`,
        severity: 'warning',
        link: '/launches',
      });
    }

    // -----------------------------------------------------------------------
    // Compute overall state
    // -----------------------------------------------------------------------
    let overallState: HealthState;

    if (dispatchRows.length === 0 && noPingPages.length === 0) {
      // No integrations or pages configured → unknown
      overallState = 'unknown';
    } else if (incidents.some((i) => i.severity === 'critical')) {
      overallState = 'unhealthy';
    } else if (incidents.some((i) => i.severity === 'warning')) {
      overallState = 'degraded';
    } else if (incidents.length === 0) {
      overallState = 'healthy';
    } else {
      overallState = 'degraded';
    }

    const hasCritical = incidents.some((i) => i.severity === 'critical');
    const summary = buildSummary(incidents.length, hasCritical);

    const body: WorkspaceHealthResponse = {
      state: overallState,
      summary,
      incidents,
    };

    // Cache-Control: max-age=30 (docs/70-ux/07-component-health-badges.md §7)
    return c.json(body, 200, {
      'X-Request-Id': requestId,
      'Cache-Control': 'max-age=30',
    });
  });

  return route;
}

// ---------------------------------------------------------------------------
// Default export — convenience instance with no-op stubs.
// Callers should prefer createHealthCpRoute(deps) to wire real DB.
// ---------------------------------------------------------------------------

/**
 * Default healthCpRoute instance — DB lookups return empty arrays.
 *
 * Wire real dependencies in index.ts via:
 * ```ts
 * app.route('/v1/health', createHealthCpRoute({ getDispatchHealth, getPageNoPing }));
 * ```
 */
export const healthCpRoute = createHealthCpRoute();
