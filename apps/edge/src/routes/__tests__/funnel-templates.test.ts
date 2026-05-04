/**
 * Integration tests — GET /v1/funnel-templates and GET /v1/funnel-templates/:slug
 *
 * T-FUNIL-011 (Sprint 10)
 *
 * Covers:
 *   401 — missing Authorization: Bearer header
 *   401 — empty / malformed Authorization: Bearer
 *   200 — list templates (happy path, empty list)
 *   200 — list templates (happy path, with rows)
 *   503 — DB not configured (no getDb injected)
 *   404 — template not found by slug
 *   200 — template found by slug
 *   200 — X-Request-Id header present on all responses
 *
 * BR-PRIVACY-001: no PII in logs or error responses.
 * BR-RBAC-002: workspace isolation enforced.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createFunnelTemplatesRoute } from '../funnel-templates.js';

// ---------------------------------------------------------------------------
// Minimal mock bindings
// ---------------------------------------------------------------------------

interface MockBindings {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  HYPERDRIVE?: Hyperdrive;
  DATABASE_URL?: string;
  DEV_WORKSPACE_ID?: string;
}

interface MockVariables {
  request_id: string;
  workspace_id: string;
}

type MockEnv = { Bindings: MockBindings; Variables: MockVariables };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEV_WS_ID = '00000000-0000-0000-0000-000000000001';

function createMockBindings(overrides: Partial<MockBindings> = {}): MockBindings {
  return {
    GT_KV: {} as KVNamespace,
    QUEUE_EVENTS: {} as Queue,
    QUEUE_DISPATCH: {} as Queue,
    ENVIRONMENT: 'test',
    DEV_WORKSPACE_ID: DEV_WS_ID,
    ...overrides,
  };
}

/** Mock DB that returns given rows for any execute() call */
function createMockDb(rows: unknown[]) {
  return {
    execute: vi.fn().mockResolvedValue(rows),
  };
}

/** Build a Hono test app with the route mounted at /v1/funnel-templates */
function buildApp(getDb?: Parameters<typeof createFunnelTemplatesRoute>[0]) {
  const app = new Hono<MockEnv>();
  app.route('/v1/funnel-templates', createFunnelTemplatesRoute(getDb));
  return app;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GET /v1/funnel-templates', () => {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 when Authorization header is absent', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates'),
      createMockBindings({ DEV_WORKSPACE_ID: undefined }),
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('unauthorized');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns 401 when Authorization header is empty Bearer', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates', {
        headers: { Authorization: 'Bearer ' },
      }),
      createMockBindings({ DEV_WORKSPACE_ID: undefined }),
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 when Authorization header has no Bearer prefix', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates', {
        headers: { Authorization: 'sometoken' },
      }),
      createMockBindings({ DEV_WORKSPACE_ID: undefined }),
    );
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // DB not configured
  // -------------------------------------------------------------------------

  it('returns 503 when DB is not configured (no getDb)', async () => {
    const app = buildApp(undefined); // no DB injected
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates', {
        headers: { Authorization: `Bearer ${DEV_WS_ID}` },
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('service_unavailable');
  });

  // -------------------------------------------------------------------------
  // Happy path — list
  // -------------------------------------------------------------------------

  it('returns 200 with empty templates list when DB returns no rows', async () => {
    const mockDb = createMockDb([]);
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates', {
        headers: { Authorization: `Bearer ${DEV_WS_ID}` },
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ templates: unknown[] }>();
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates).toHaveLength(0);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns 200 with template rows when DB returns results', async () => {
    const mockRows = [
      {
        id: 'aaaaaaaa-0000-0000-0000-000000000001',
        slug: 'basic-launch',
        name: 'Basic Launch',
        description: 'A simple launch template',
        blueprint: { version: '1', pages: [], audiences: [] },
        is_system: true,
      },
    ];
    const mockDb = createMockDb(mockRows);
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates', {
        headers: { Authorization: `Bearer ${DEV_WS_ID}` },
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ templates: typeof mockRows }>();
    expect(body.templates).toHaveLength(1);
    expect(body.templates[0]?.slug).toBe('basic-launch');
    expect(body.templates[0]?.is_system).toBe(true);
  });

  // -------------------------------------------------------------------------
  // DB error
  // -------------------------------------------------------------------------

  it('returns 500 when DB throws', async () => {
    const mockDb = { execute: vi.fn().mockRejectedValue(new TypeError('DB error')) };
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates', {
        headers: { Authorization: `Bearer ${DEV_WS_ID}` },
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('internal_error');
  });
});

describe('GET /v1/funnel-templates/:slug', () => {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 when Authorization header is absent', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates/basic-launch'),
      createMockBindings({ DEV_WORKSPACE_ID: undefined }),
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('unauthorized');
  });

  // -------------------------------------------------------------------------
  // 404 — not found
  // -------------------------------------------------------------------------

  it('returns 404 when template slug is not found', async () => {
    const mockDb = createMockDb([]); // empty result
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates/nonexistent-slug', {
        headers: { Authorization: `Bearer ${DEV_WS_ID}` },
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('not_found');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Happy path — single template
  // -------------------------------------------------------------------------

  it('returns 200 with template when slug is found', async () => {
    const mockRow = {
      id: 'bbbbbbbb-0000-0000-0000-000000000002',
      slug: 'webinar-launch',
      name: 'Webinar Launch',
      description: null,
      blueprint: {
        version: '1',
        pages: [{ role: 'capture', suggested_public_id: 'cap' }],
        audiences: [],
      },
      is_system: false,
    };
    const mockDb = createMockDb([mockRow]);
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates/webinar-launch', {
        headers: { Authorization: `Bearer ${DEV_WS_ID}` },
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ template: typeof mockRow }>();
    expect(body.template.slug).toBe('webinar-launch');
    expect(body.template.description).toBeNull();
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 503 — DB not configured
  // -------------------------------------------------------------------------

  it('returns 503 when DB is not configured for slug lookup', async () => {
    const app = buildApp(undefined);
    const res = await app.fetch(
      new Request('http://localhost/v1/funnel-templates/some-slug', {
        headers: { Authorization: `Bearer ${DEV_WS_ID}` },
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(503);
  });
});
