/**
 * Integration tests — GET /v1/health/integrations + GET /v1/health/workspace
 *
 * CONTRACT-api-health-integrations-v1
 * CONTRACT-api-health-workspace-v1
 *
 * Covers:
 *   integrations — 200 unknown (no data)
 *   integrations — 200 healthy (all providers OK)
 *   integrations — 200 degraded (failure_rate in [0.01, 0.05))
 *   integrations — 200 unhealthy (DLQ > 0)
 *   integrations — 200 unhealthy (failure_rate >= 0.05)
 *   integrations — 401 missing Authorization
 *   integrations — 401 wrong Authorization format
 *   workspace    — 200 unknown (no dispatch rows, no pages)
 *   workspace    — 200 healthy (no incidents)
 *   workspace    — 200 degraded (page_no_ping warning)
 *   workspace    — 200 unhealthy (DLQ critical incident)
 *   workspace    — incidents list correct (DLQ + page_no_ping)
 *   workspace    — 401 missing Authorization
 *   both         — Cache-Control: max-age=30 present
 *   both         — X-Request-Id present in response
 *
 * Test approach: real Hono app, injected stub DB functions.
 * No external DB or Cloudflare runtime required — runs with vitest node environment.
 *
 * BR-PRIVACY-001: no PII in logs or error responses.
 * BR-RBAC-002: workspace_id isolation via context variable.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type DispatchHealthRow,
  type GetDispatchHealthFn,
  type GetPageNoPingFn,
  type IntegrationsHealthResponse,
  type PageNoPingRow,
  type WorkspaceHealthResponse,
  aggregateState,
  computeProviderState,
  createHealthCpRoute,
} from '../../../apps/edge/src/routes/health-cp.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
};

type Variables = {
  workspace_id: string;
  request_id: string;
};

// ---------------------------------------------------------------------------
// Helpers to build a minimal Hono test app
// ---------------------------------------------------------------------------

function buildApp(
  opts: {
    getDispatchHealth?: GetDispatchHealthFn;
    getPageNoPing?: GetPageNoPingFn;
    /** workspace_id to inject into context (simulates auth middleware) */
    workspaceId?: string;
  } = {},
): Hono<{ Bindings: Bindings; Variables: Variables }> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Simulate auth middleware injecting workspace_id
  if (opts.workspaceId) {
    app.use('*', async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- workspaceId is guaranteed by the opts.workspaceId guard above
      c.set('workspace_id', opts.workspaceId as string);
      await next();
    });
  }

  app.route(
    '/v1/health',
    createHealthCpRoute({
      getDispatchHealth: opts.getDispatchHealth,
      getPageNoPing: opts.getPageNoPing,
    }),
  );

  return app;
}

/** Helper: make a GET request with optional Authorization header */
async function get(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  opts: { auth?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) {
    headers.Authorization = opts.auth;
  }
  return app.request(path, { method: 'GET', headers });
}

// ---------------------------------------------------------------------------
// Unit tests for pure aggregation helpers
// ---------------------------------------------------------------------------

describe('computeProviderState', () => {
  it('returns healthy when no failures and no DLQ', () => {
    const row: DispatchHealthRow = {
      destination: 'meta_capi',
      succeeded: 100,
      failed: 0,
      skipped: 0,
      dlq_count: 0,
      total: 100,
    };
    expect(computeProviderState(row)).toBe('healthy');
  });

  it('returns degraded when failure_rate in [0.01, 0.05)', () => {
    const row: DispatchHealthRow = {
      destination: 'meta_capi',
      succeeded: 97,
      failed: 3,
      skipped: 0,
      dlq_count: 0,
      total: 100,
    };
    // failure_rate = 3/100 = 0.03 → degraded
    expect(computeProviderState(row)).toBe('degraded');
  });

  it('returns unhealthy when failure_rate >= 0.05', () => {
    const row: DispatchHealthRow = {
      destination: 'ga4_mp',
      succeeded: 90,
      failed: 10,
      skipped: 0,
      dlq_count: 0,
      total: 100,
    };
    // failure_rate = 10/100 = 0.10 → unhealthy
    expect(computeProviderState(row)).toBe('unhealthy');
  });

  it('returns unhealthy when dlq_count > 0 regardless of failure_rate', () => {
    const row: DispatchHealthRow = {
      destination: 'meta_capi',
      succeeded: 99,
      failed: 0,
      skipped: 0,
      dlq_count: 2,
      total: 101,
    };
    expect(computeProviderState(row)).toBe('unhealthy');
  });

  it('returns healthy when total=0 (no activity)', () => {
    const row: DispatchHealthRow = {
      destination: 'meta_capi',
      succeeded: 0,
      failed: 0,
      skipped: 0,
      dlq_count: 0,
      total: 0,
    };
    expect(computeProviderState(row)).toBe('healthy');
  });
});

describe('aggregateState', () => {
  it('returns unknown for empty list', () => {
    expect(aggregateState([])).toBe('unknown');
  });

  it('returns healthy when all providers healthy', () => {
    expect(aggregateState(['healthy', 'healthy'])).toBe('healthy');
  });

  it('returns degraded when any provider is degraded', () => {
    expect(aggregateState(['healthy', 'degraded', 'healthy'])).toBe('degraded');
  });

  it('returns unhealthy when any provider is unhealthy (even if others healthy)', () => {
    expect(aggregateState(['healthy', 'degraded', 'unhealthy'])).toBe(
      'unhealthy',
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests — GET /v1/health/integrations
// ---------------------------------------------------------------------------

describe('GET /v1/health/integrations', () => {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 when Authorization header is missing', async () => {
    const app = buildApp();
    const res = await get(app, '/v1/health/integrations');

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('unauthorized');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/email|phone|name/i);
  });

  it('returns 401 when Authorization header has wrong format', async () => {
    const app = buildApp();
    const res = await get(app, '/v1/health/integrations', {
      auth: 'Token abc123',
    });

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('unauthorized');
  });

  it('returns X-Request-Id on 401', async () => {
    const app = buildApp();
    const res = await get(app, '/v1/health/integrations');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Happy path — unknown (no data)
  // -------------------------------------------------------------------------

  it('returns state=unknown when no dispatch rows exist', async () => {
    const app = buildApp({
      workspaceId: 'ws-test-1',
      getDispatchHealth: async () => [],
    });

    const res = await get(app, '/v1/health/integrations', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<IntegrationsHealthResponse>();
    expect(body.state).toBe('unknown');
    expect(body.providers).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Happy path — healthy
  // -------------------------------------------------------------------------

  it('returns state=healthy when all providers are healthy', async () => {
    const rows: DispatchHealthRow[] = [
      {
        destination: 'meta_capi',
        succeeded: 100,
        failed: 0,
        skipped: 5,
        dlq_count: 0,
        total: 105,
      },
      {
        destination: 'ga4_mp',
        succeeded: 50,
        failed: 0,
        skipped: 0,
        dlq_count: 0,
        total: 50,
      },
    ];

    const app = buildApp({
      workspaceId: 'ws-test-2',
      getDispatchHealth: async () => rows,
    });

    const res = await get(app, '/v1/health/integrations', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<IntegrationsHealthResponse>();
    expect(body.state).toBe('healthy');
    expect(body.providers).toHaveLength(2);

    const meta = body.providers.find((p) => p.provider === 'meta_capi');
    expect(meta?.state).toBe('healthy');
    expect(meta?.events_24h).toBe(105);
    expect(meta?.failures_24h).toBe(0);
    expect(meta?.failure_rate).toBe(0);
    expect(meta?.dlq_count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Degraded
  // -------------------------------------------------------------------------

  it('returns state=degraded when a provider has failure_rate in [0.01, 0.05)', async () => {
    const rows: DispatchHealthRow[] = [
      {
        destination: 'meta_capi',
        succeeded: 97,
        failed: 3,
        skipped: 0,
        dlq_count: 0,
        total: 100,
      },
    ];

    const app = buildApp({
      workspaceId: 'ws-test-3',
      getDispatchHealth: async () => rows,
    });

    const res = await get(app, '/v1/health/integrations', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<IntegrationsHealthResponse>();
    expect(body.state).toBe('degraded');
    expect(body.providers[0]?.state).toBe('degraded');
  });

  // -------------------------------------------------------------------------
  // Unhealthy — DLQ
  // -------------------------------------------------------------------------

  it('returns state=unhealthy when a provider has DLQ > 0', async () => {
    const rows: DispatchHealthRow[] = [
      {
        destination: 'meta_capi',
        succeeded: 90,
        failed: 5,
        skipped: 0,
        dlq_count: 3,
        total: 95,
      },
    ];

    const app = buildApp({
      workspaceId: 'ws-test-4',
      getDispatchHealth: async () => rows,
    });

    const res = await get(app, '/v1/health/integrations', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<IntegrationsHealthResponse>();
    expect(body.state).toBe('unhealthy');
    expect(body.providers[0]?.state).toBe('unhealthy');
    expect(body.providers[0]?.dlq_count).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Unhealthy — high failure rate
  // -------------------------------------------------------------------------

  it('returns state=unhealthy when a provider has failure_rate >= 0.05', async () => {
    const rows: DispatchHealthRow[] = [
      {
        destination: 'google_ads_conversion',
        succeeded: 90,
        failed: 10,
        skipped: 0,
        dlq_count: 0,
        total: 100,
      },
    ];

    const app = buildApp({
      workspaceId: 'ws-test-5',
      getDispatchHealth: async () => rows,
    });

    const res = await get(app, '/v1/health/integrations', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<IntegrationsHealthResponse>();
    expect(body.state).toBe('unhealthy');
  });

  // -------------------------------------------------------------------------
  // Cache header
  // -------------------------------------------------------------------------

  it('returns Cache-Control: max-age=30', async () => {
    const app = buildApp({
      workspaceId: 'ws-test-6',
      getDispatchHealth: async () => [],
    });

    const res = await get(app, '/v1/health/integrations', {
      auth: 'Bearer some-jwt',
    });

    expect(res.headers.get('Cache-Control')).toBe('max-age=30');
  });

  // -------------------------------------------------------------------------
  // X-Request-Id on success
  // -------------------------------------------------------------------------

  it('returns X-Request-Id on 200', async () => {
    const app = buildApp({
      workspaceId: 'ws-test-7',
      getDispatchHealth: async () => [],
    });

    const res = await get(app, '/v1/health/integrations', {
      auth: 'Bearer some-jwt',
    });

    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — GET /v1/health/workspace
// ---------------------------------------------------------------------------

describe('GET /v1/health/workspace', () => {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 when Authorization header is missing', async () => {
    const app = buildApp();
    const res = await get(app, '/v1/health/workspace');

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('unauthorized');
  });

  it('returns 401 when Authorization is malformed', async () => {
    const app = buildApp();
    const res = await get(app, '/v1/health/workspace', { auth: 'Basic abc' });

    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Unknown — no data at all
  // -------------------------------------------------------------------------

  it('returns state=unknown when no dispatch rows and no pages', async () => {
    const app = buildApp({
      workspaceId: 'ws-test-10',
      getDispatchHealth: async () => [],
      getPageNoPing: async () => [],
    });

    const res = await get(app, '/v1/health/workspace', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<WorkspaceHealthResponse>();
    expect(body.state).toBe('unknown');
    expect(body.incidents).toHaveLength(0);
    expect(body.summary).toBe('Tudo OK');
  });

  // -------------------------------------------------------------------------
  // Healthy
  // -------------------------------------------------------------------------

  it('returns state=healthy when dispatch rows exist but no incidents', async () => {
    const rows: DispatchHealthRow[] = [
      {
        destination: 'meta_capi',
        succeeded: 200,
        failed: 0,
        skipped: 0,
        dlq_count: 0,
        total: 200,
      },
    ];

    const app = buildApp({
      workspaceId: 'ws-test-11',
      getDispatchHealth: async () => rows,
      getPageNoPing: async () => [],
    });

    const res = await get(app, '/v1/health/workspace', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<WorkspaceHealthResponse>();
    expect(body.state).toBe('healthy');
    expect(body.incidents).toHaveLength(0);
    expect(body.summary).toBe('Tudo OK');
  });

  // -------------------------------------------------------------------------
  // Degraded — page_no_ping
  // -------------------------------------------------------------------------

  it('returns state=degraded with page_no_ping incident when page has no ping', async () => {
    const pages: PageNoPingRow[] = [{ public_id: 'captura-v2' }];

    const app = buildApp({
      workspaceId: 'ws-test-12',
      getDispatchHealth: async () => [],
      getPageNoPing: async () => pages,
    });

    const res = await get(app, '/v1/health/workspace', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<WorkspaceHealthResponse>();
    expect(body.state).toBe('degraded');
    expect(body.incidents).toHaveLength(1);

    const incident = body.incidents[0] as NonNullable<
      (typeof body.incidents)[0]
    >;
    expect(incident.type).toBe('page_no_ping');
    expect(incident.severity).toBe('warning');
    expect(incident.target).toBe('captura-v2');
    expect(incident.message).toContain('captura-v2');
    expect(incident.link).toContain('/launches');
  });

  // -------------------------------------------------------------------------
  // Unhealthy — DLQ
  // -------------------------------------------------------------------------

  it('returns state=unhealthy when a provider has DLQ > 0', async () => {
    const rows: DispatchHealthRow[] = [
      {
        destination: 'meta_capi',
        succeeded: 95,
        failed: 3,
        skipped: 0,
        dlq_count: 5,
        total: 98,
      },
    ];

    const app = buildApp({
      workspaceId: 'ws-test-13',
      getDispatchHealth: async () => rows,
      getPageNoPing: async () => [],
    });

    const res = await get(app, '/v1/health/workspace', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<WorkspaceHealthResponse>();
    expect(body.state).toBe('unhealthy');
    expect(body.summary).toBe('Crítico');

    const dlqIncident = body.incidents.find((i) => i.type === 'dlq');
    expect(dlqIncident).toBeDefined();
    expect(dlqIncident?.severity).toBe('critical');
    expect(dlqIncident?.target).toBe('meta_capi');
    expect(dlqIncident?.message).toContain('5');
    expect(dlqIncident?.link).toBe('/integrations/meta_capi');
  });

  // -------------------------------------------------------------------------
  // Mixed incidents — DLQ + page_no_ping
  // -------------------------------------------------------------------------

  it('returns both DLQ and page_no_ping incidents', async () => {
    const rows: DispatchHealthRow[] = [
      {
        destination: 'ga4_mp',
        succeeded: 80,
        failed: 5,
        skipped: 0,
        dlq_count: 2,
        total: 85,
      },
    ];
    const pages: PageNoPingRow[] = [
      { public_id: 'thankyou-page' },
      { public_id: 'webinar-lp' },
    ];

    const app = buildApp({
      workspaceId: 'ws-test-14',
      getDispatchHealth: async () => rows,
      getPageNoPing: async () => pages,
    });

    const res = await get(app, '/v1/health/workspace', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<WorkspaceHealthResponse>();
    // Critical incident from DLQ → unhealthy
    expect(body.state).toBe('unhealthy');
    expect(body.summary).toBe('Crítico');

    // Should have 1 DLQ + 2 page incidents = 3 total
    expect(body.incidents).toHaveLength(3);

    const dlqIncidents = body.incidents.filter((i) => i.type === 'dlq');
    const pageIncidents = body.incidents.filter(
      (i) => i.type === 'page_no_ping',
    );
    expect(dlqIncidents).toHaveLength(1);
    expect(pageIncidents).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Summary — multiple incidents (non-critical)
  // -------------------------------------------------------------------------

  it('returns "N incidentes" summary for multiple warning incidents', async () => {
    // failure_rate = 5/100 = 0.05 → integration_failure incident with severity='warning'
    // page_no_ping → severity='warning'
    // Neither is 'critical' → workspace state = 'degraded', summary = "N incidentes"
    const rows: DispatchHealthRow[] = [
      {
        destination: 'meta_capi',
        succeeded: 95,
        failed: 5,
        skipped: 0,
        dlq_count: 0,
        total: 100,
      },
    ];
    const pages: PageNoPingRow[] = [{ public_id: 'captura-v1' }];

    const app = buildApp({
      workspaceId: 'ws-test-15',
      getDispatchHealth: async () => rows,
      getPageNoPing: async () => pages,
    });

    const res = await get(app, '/v1/health/workspace', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<WorkspaceHealthResponse>();
    // Both incidents are 'warning' severity → workspace state is 'degraded'
    expect(body.state).toBe('degraded');
    // Has 2 incidents (integration_failure + page_no_ping)
    expect(body.incidents).toHaveLength(2);
    // No critical → summary shows incident count
    expect(body.summary).toMatch(/2 incidentes/);
    // All incidents are warnings
    expect(body.incidents.every((i) => i.severity === 'warning')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Cache header + X-Request-Id
  // -------------------------------------------------------------------------

  it('returns Cache-Control: max-age=30', async () => {
    const app = buildApp({
      workspaceId: 'ws-test-16',
      getDispatchHealth: async () => [],
      getPageNoPing: async () => [],
    });

    const res = await get(app, '/v1/health/workspace', {
      auth: 'Bearer some-jwt',
    });

    expect(res.headers.get('Cache-Control')).toBe('max-age=30');
  });

  it('returns X-Request-Id on 200', async () => {
    const app = buildApp({
      workspaceId: 'ws-test-17',
      getDispatchHealth: async () => [],
      getPageNoPing: async () => [],
    });

    const res = await get(app, '/v1/health/workspace', {
      auth: 'Bearer some-jwt',
    });

    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Single incident summary
  // -------------------------------------------------------------------------

  it('returns "1 incidente" summary for exactly one incident', async () => {
    const pages: PageNoPingRow[] = [{ public_id: 'checkout-lp' }];

    const app = buildApp({
      workspaceId: 'ws-test-18',
      getDispatchHealth: async () => [],
      getPageNoPing: async () => pages,
    });

    const res = await get(app, '/v1/health/workspace', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<WorkspaceHealthResponse>();
    expect(body.incidents).toHaveLength(1);
    expect(body.summary).toBe('1 incidente');
  });
});
