/**
 * Integration tests — GET /v1/pages/:public_id/status
 *
 * CONTRACT-api-pages-status-v1
 * T-ID: T-6-003
 *
 * Covers:
 *   1. Happy path — page found, active token, events: 200 with correct shape
 *   2. Happy path — health_state='unknown' when no events yet (never pinged)
 *   3. Happy path — health_state='healthy' (ping < 5min, active token, no issues)
 *   4. Happy path — health_state='degraded' (ping between 5min and 24h)
 *   5. Happy path — health_state='unhealthy' (no ping > 24h)
 *   6. Happy path — health_state='unhealthy' (token revoked)
 *   7. Happy path — health_state='degraded' (token rotating)
 *   8. Page not found → 404
 *   9. Auth header missing → 401
 *  10. Auth header present but empty Bearer → 401
 *  11. Invalid public_id (too long) → 400
 *  12. DB error on page lookup → 500
 *  13. Response contains X-Request-Id header
 *  14. Response contains Cache-Control: max-age=30
 *  15. BR-PRIVACY-001: error responses contain no PII
 *
 * Test approach: real Hono app with createPagesStatusRoute mounted.
 *   DB operations mocked via injected dependency functions.
 *   No external DB or Cloudflare runtime required — runs with vitest node environment.
 *
 * BR-PRIVACY-001: error responses must not contain PII.
 * BR-RBAC-002: workspace isolation (token auth deferred to Sprint 6).
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type GetActivePageTokenFn,
  type GetPageByPublicIdFn,
  type GetPageEventStatsFn,
  type PageEventStats,
  type PageStatusResponse,
  type PageStatusRow,
  type PageTokenRow,
  computeHealthState,
  createPagesStatusRoute,
} from '../../../apps/edge/src/routes/pages-status.js';

// ---------------------------------------------------------------------------
// Types (mirror apps/edge/src/index.ts)
// ---------------------------------------------------------------------------

type Bindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
};

type Variables = {
  request_id: string;
  workspace_id?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_BEARER = 'Bearer test-token-value';

function buildApp(deps?: {
  getPageByPublicId?: GetPageByPublicIdFn;
  getActivePageToken?: GetActivePageTokenFn;
  getPageEventStats?: GetPageEventStatsFn;
}): Hono<{ Bindings: Bindings; Variables: Variables }> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route('/v1/pages', createPagesStatusRoute(deps));
  return app;
}

/** Minimal valid page row. */
const MOCK_PAGE: PageStatusRow = {
  id: 'page-uuid-001',
  workspaceId: 'ws-uuid-001',
  publicId: 'captura-v1',
};

/** Minimal valid active token row. */
const MOCK_TOKEN_ACTIVE: PageTokenRow = {
  status: 'active',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  rotatedAt: null,
  revokedAt: null,
};

const MOCK_TOKEN_ROTATING: PageTokenRow = {
  status: 'rotating',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  rotatedAt: new Date('2026-04-28T12:00:00Z'),
  revokedAt: null,
};

const MOCK_TOKEN_REVOKED: PageTokenRow = {
  status: 'revoked',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  rotatedAt: new Date('2026-03-01T00:00:00Z'),
  revokedAt: new Date('2026-04-01T00:00:00Z'),
};

/** Stats with a recent ping (3 minutes ago). */
function recentPingStats(): PageEventStats {
  return {
    eventsToday: 42,
    eventsLast24h: 100,
    lastPingAt: new Date(Date.now() - 3 * 60 * 1000),
  };
}

/** Stats with a ping that is 10 minutes old. */
function stalePingStats(): PageEventStats {
  return {
    eventsToday: 10,
    eventsLast24h: 20,
    lastPingAt: new Date(Date.now() - 10 * 60 * 1000),
  };
}

/** Stats with no ping at all. */
const noPingStats: PageEventStats = {
  eventsToday: 0,
  eventsLast24h: 0,
  lastPingAt: null,
};

/** Stats with last ping > 24h. */
function oldPingStats(): PageEventStats {
  return {
    eventsToday: 0,
    eventsLast24h: 0,
    lastPingAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
  };
}

async function requestStatus(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  publicId: string,
  authHeader?: string,
): Promise<Response> {
  const headers: HeadersInit = {};
  if (authHeader !== undefined) {
    headers.Authorization = authHeader;
  }
  return app.request(`/v1/pages/${publicId}/status`, { headers });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/pages/:public_id/status', () => {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  describe('authentication', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => noPingStats,
      });

      const res = await requestStatus(app, 'captura-v1');
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.code).toBe('unauthorized');
      expect(body.request_id).toBeDefined();
    });

    it('returns 401 when Authorization header is "Bearer " with no value', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => noPingStats,
      });

      const res = await requestStatus(app, 'captura-v1', 'Bearer ');
      expect(res.status).toBe(401);

      const body = await res.json();
      expect(body.code).toBe('unauthorized');
    });

    it('returns 401 when Authorization header does not start with "Bearer "', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => noPingStats,
      });

      const res = await requestStatus(app, 'captura-v1', 'Basic abc123');
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  describe('validation', () => {
    it('returns 400 when public_id is longer than 64 characters', async () => {
      const app = buildApp({
        getPageByPublicId: async () => null,
        getActivePageToken: async () => null,
        getPageEventStats: async () => noPingStats,
      });

      const longId = 'a'.repeat(65);
      const res = await requestStatus(app, longId, VALID_BEARER);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.code).toBe('validation_error');
      expect(body.request_id).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Not found
  // -------------------------------------------------------------------------

  describe('not found', () => {
    it('returns 404 when page does not exist', async () => {
      const app = buildApp({
        getPageByPublicId: async () => null,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => noPingStats,
      });

      const res = await requestStatus(app, 'non-existent-page', VALID_BEARER);
      expect(res.status).toBe(404);

      const body = await res.json();
      expect(body.code).toBe('page_not_found');
      expect(body.request_id).toBeDefined();
    });

    it('returns 404 when no DB dependency is injected (no-op stubs)', async () => {
      // Default route has no-op stubs — getPageByPublicId returns null
      const app = buildApp();

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      expect(res.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — correct shape
  // -------------------------------------------------------------------------

  describe('happy path — response shape', () => {
    it('returns 200 with full PageStatusResponse shape', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => recentPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      expect(res.status).toBe(200);

      const body = (await res.json()) as PageStatusResponse;

      // Verify all required fields are present
      expect(body.page_public_id).toBe('captura-v1');
      expect(['healthy', 'degraded', 'unhealthy', 'unknown']).toContain(
        body.health_state,
      );
      expect(typeof body.events_today).toBe('number');
      expect(typeof body.events_last_24h).toBe('number');
      expect(['active', 'rotating', 'expired', 'revoked']).toContain(
        body.token_status,
      );
      expect(Array.isArray(body.recent_issues)).toBe(true);
    });

    it('includes X-Request-Id response header', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => recentPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      expect(res.headers.get('X-Request-Id')).toBeTruthy();
    });

    it('includes Cache-Control: max-age=30 on success', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => recentPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      expect(res.headers.get('Cache-Control')).toBe('max-age=30');
    });

    it('returns last_ping_at as ISO 8601 string when ping exists', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => recentPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      expect(body.last_ping_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('returns last_ping_at as null when no events yet', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => noPingStats,
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      expect(body.last_ping_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — health_state calculation
  // -------------------------------------------------------------------------

  describe('happy path — health_state', () => {
    it('returns health_state="unknown" when page has never received a ping', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => noPingStats,
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      expect(body.health_state).toBe('unknown');
    });

    it('returns health_state="healthy" when ping is recent, token active', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => recentPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      expect(body.health_state).toBe('healthy');
      expect(body.token_status).toBe('active');
    });

    it('returns health_state="degraded" when ping is between 5min and 24h', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => stalePingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      expect(body.health_state).toBe('degraded');
    });

    it('returns health_state="unhealthy" when no ping for > 24h', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => oldPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      expect(body.health_state).toBe('unhealthy');
    });

    it('returns health_state="unhealthy" when token is revoked', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_REVOKED,
        getPageEventStats: async () => recentPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      expect(body.health_state).toBe('unhealthy');
      expect(body.token_status).toBe('revoked');
    });

    it('returns health_state="degraded" when token is rotating', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ROTATING,
        getPageEventStats: async () => recentPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      expect(body.health_state).toBe('degraded');
      expect(body.token_status).toBe('rotating');
    });

    it('returns token_rotates_at when token is rotating', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ROTATING,
        getPageEventStats: async () => recentPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      // token_rotates_at = rotatedAt + 14 days
      expect(body.token_rotates_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    });

    it('returns token_rotates_at=null when token is active (no rotation in progress)', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => recentPingStats(),
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      const body = (await res.json()) as PageStatusResponse;

      expect(body.token_rotates_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns 500 when DB throws on page lookup', async () => {
      const app = buildApp({
        getPageByPublicId: async () => {
          throw new Error('DB connection failed');
        },
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => noPingStats,
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.code).toBe('internal_error');
      // BR-PRIVACY-001: no PII in error response
      expect(JSON.stringify(body)).not.toContain('@');
      expect(JSON.stringify(body)).not.toContain('password');
    });

    it('returns 200 (degraded) even when token DB lookup fails (non-fatal)', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => {
          throw new Error('Token DB error');
        },
        getPageEventStats: async () => recentPingStats(),
      });

      // Token status falls back to 'expired' → degraded or worse
      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      expect(res.status).toBe(200);

      const body = (await res.json()) as PageStatusResponse;
      expect(body.token_status).toBe('expired');
    });

    it('returns 200 (with zero stats) even when stats DB lookup fails (non-fatal)', async () => {
      const app = buildApp({
        getPageByPublicId: async () => MOCK_PAGE,
        getActivePageToken: async () => MOCK_TOKEN_ACTIVE,
        getPageEventStats: async () => {
          throw new Error('Stats DB error');
        },
      });

      const res = await requestStatus(app, 'captura-v1', VALID_BEARER);
      expect(res.status).toBe(200);

      const body = (await res.json()) as PageStatusResponse;
      expect(body.events_today).toBe(0);
      expect(body.events_last_24h).toBe(0);
      expect(body.last_ping_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001: zero PII in error responses
  // -------------------------------------------------------------------------

  describe('BR-PRIVACY-001 — no PII in responses', () => {
    it('401 response contains no PII', async () => {
      const app = buildApp();
      const res = await requestStatus(app, 'captura-v1');
      const body = await res.json();

      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toContain('@');
      expect(bodyStr).not.toContain('email');
      expect(bodyStr).not.toContain('phone');
    });

    it('404 response contains no PII', async () => {
      const app = buildApp({
        getPageByPublicId: async () => null,
      });
      const res = await requestStatus(app, 'non-existent', VALID_BEARER);
      const body = await res.json();

      const bodyStr = JSON.stringify(body);
      expect(bodyStr).not.toContain('@');
      expect(bodyStr).not.toContain('email');
      expect(bodyStr).not.toContain('phone');
    });
  });
});

// ---------------------------------------------------------------------------
// Unit tests for computeHealthState
// ---------------------------------------------------------------------------

describe('computeHealthState', () => {
  const NOW = new Date('2026-05-02T12:00:00Z');

  it('returns "unknown" when lastPingAt is null', () => {
    expect(computeHealthState(null, 'active', null, [], NOW)).toBe('unknown');
  });

  it('returns "healthy" for recent ping + active token + no issues', () => {
    const twoMinAgo = new Date(NOW.getTime() - 2 * 60 * 1000);
    expect(computeHealthState(twoMinAgo, 'active', null, [], NOW)).toBe(
      'healthy',
    );
  });

  it('returns "degraded" for ping 10 minutes ago + active token', () => {
    const tenMinAgo = new Date(NOW.getTime() - 10 * 60 * 1000);
    expect(computeHealthState(tenMinAgo, 'active', null, [], NOW)).toBe(
      'degraded',
    );
  });

  it('returns "degraded" for recent ping + rotating token', () => {
    const twoMinAgo = new Date(NOW.getTime() - 2 * 60 * 1000);
    expect(computeHealthState(twoMinAgo, 'rotating', null, [], NOW)).toBe(
      'degraded',
    );
  });

  it('returns "unhealthy" for ping > 24h ago', () => {
    const twoDaysAgo = new Date(NOW.getTime() - 48 * 60 * 60 * 1000);
    expect(computeHealthState(twoDaysAgo, 'active', null, [], NOW)).toBe(
      'unhealthy',
    );
  });

  it('returns "unhealthy" for revoked token (even with recent ping)', () => {
    const twoMinAgo = new Date(NOW.getTime() - 2 * 60 * 1000);
    expect(computeHealthState(twoMinAgo, 'revoked', null, [], NOW)).toBe(
      'unhealthy',
    );
  });

  it('returns "unhealthy" for origin_not_allowed issue (even with recent ping + active token)', () => {
    const twoMinAgo = new Date(NOW.getTime() - 2 * 60 * 1000);
    const issues = [
      {
        type: 'origin_not_allowed' as const,
        domain: 'staging.cliente.com',
        count: 5,
        last_seen_at: NOW.toISOString(),
      },
    ];
    expect(computeHealthState(twoMinAgo, 'active', null, issues, NOW)).toBe(
      'unhealthy',
    );
  });
});
