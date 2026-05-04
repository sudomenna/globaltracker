/**
 * Integration tests — POST /v1/launches
 *
 * T-FUNIL-011 (Sprint 10)
 *
 * Covers:
 *   401 — missing Authorization: Bearer header
 *   400 — invalid JSON body
 *   400 — missing required fields (public_id, name)
 *   400 — extra unknown fields (strict schema)
 *   503 — DB not configured (no getDb injected)
 *   201 — happy path (launch created, no template)
 *   201 — happy path with funnel_template_slug (scaffolded: true in response)
 *   409 — conflict on duplicate public_id
 *   200 — X-Request-Id header present on all responses
 *
 * BR-PRIVACY-001: no PII in logs or error responses.
 * BR-RBAC-002: workspace isolation enforced.
 * INV-LAUNCH-001: (workspace_id, public_id) unique.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createLaunchesRoute } from '../launches.js';

// ---------------------------------------------------------------------------
// Types
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

/** Build a Hono test app with the route mounted at /v1/launches */
function buildApp(getDb?: Parameters<typeof createLaunchesRoute>[0]) {
  const app = new Hono<MockEnv>();
  app.route('/v1/launches', createLaunchesRoute(getDb));
  return app;
}

/** Minimal mock DB that succeeds on execute() */
function createSuccessDb() {
  return {
    execute: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Minimal mock executionCtx for waitUntil
// ---------------------------------------------------------------------------

function mockExCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('POST /v1/launches', () => {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 when Authorization header is absent', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_id: 'my-launch', name: 'My Launch' }),
      }),
      createMockBindings({ DEV_WORKSPACE_ID: undefined }),
    );
    expect(res.status).toBe(401);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('unauthorized');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns 401 when Bearer token is empty', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer   ',
        },
        body: JSON.stringify({ public_id: 'my-launch', name: 'My Launch' }),
      }),
      createMockBindings({ DEV_WORKSPACE_ID: undefined }),
    );
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  it('returns 400 when body is invalid JSON', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: 'not json{{',
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; details: string }>();
    expect(body.error).toBe('validation_error');
    expect(body.details).toBe('invalid json');
  });

  it('returns 400 when required field public_id is missing', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ name: 'My Launch' }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 when required field name is missing', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ public_id: 'my-launch' }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when public_id is too short (< 3 chars)', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ public_id: 'ab', name: 'My Launch' }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when unknown fields are present (strict schema)', async () => {
    const app = buildApp();
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({
          public_id: 'my-launch',
          name: 'My Launch',
          unknown_field: 'should-fail',
        }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // DB not configured
  // -------------------------------------------------------------------------

  it('returns 503 when DB is not configured (no getDb)', async () => {
    const app = buildApp(undefined);
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ public_id: 'my-launch', name: 'My Launch' }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(503);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('service_unavailable');
  });

  // -------------------------------------------------------------------------
  // Happy path — no template
  // -------------------------------------------------------------------------

  it('returns 201 with launch object when no funnel_template_slug', async () => {
    const mockDb = createSuccessDb();
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({
          public_id: 'my-launch',
          name: 'My Launch',
          timezone: 'America/New_York',
        }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{
      launch: {
        id: string;
        public_id: string;
        name: string;
        timezone: string;
        status: string;
      };
      scaffolded?: boolean;
    }>();
    expect(body.launch.public_id).toBe('my-launch');
    expect(body.launch.name).toBe('My Launch');
    expect(body.launch.timezone).toBe('America/New_York');
    expect(body.launch.status).toBe('draft');
    expect(body.scaffolded).toBeUndefined(); // not set when no template
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    expect(mockDb.execute).toHaveBeenCalledOnce();
  });

  it('defaults timezone to America/Sao_Paulo when not provided', async () => {
    const mockDb = createSuccessDb();
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ public_id: 'my-launch-2', name: 'Another' }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{ launch: { timezone: string } }>();
    expect(body.launch.timezone).toBe('America/Sao_Paulo');
  });

  // -------------------------------------------------------------------------
  // Happy path — with template scaffolding
  // -------------------------------------------------------------------------

  it('returns 201 with scaffolded: true when funnel_template_slug is provided', async () => {
    // scaffoldLaunch is async via waitUntil — we just need execute() to work for insert
    const mockDb = {
      execute: vi.fn().mockResolvedValue([]),
      transaction: vi.fn().mockResolvedValue({ pagesCreated: 2, audiencesCreated: 1 }),
    };
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({
          public_id: 'my-launch-3',
          name: 'Templated Launch',
          funnel_template_slug: 'basic-launch',
        }),
      }),
      createMockBindings(),
      mockExCtx(),
    );
    expect(res.status).toBe(201);
    const body = await res.json<{
      launch: { public_id: string };
      scaffolded: boolean;
    }>();
    expect(body.launch.public_id).toBe('my-launch-3');
    expect(body.scaffolded).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Conflict
  // -------------------------------------------------------------------------

  it('returns 409 when DB throws unique constraint violation', async () => {
    const conflictErr = new Error(
      'duplicate key value violates unique constraint "uq_launches_workspace_public_id"',
    );
    const mockDb = {
      execute: vi.fn().mockRejectedValue(conflictErr),
    };
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ public_id: 'existing-launch', name: 'Dup' }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('conflict');
  });

  it('returns 500 when DB throws a non-conflict error', async () => {
    const mockDb = {
      execute: vi.fn().mockRejectedValue(new Error('connection timeout')),
    };
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request('http://localhost/v1/launches', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ public_id: 'my-launch', name: 'My Launch' }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(500);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('internal_error');
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/launches/:id — T-FUNIL-013 (Sprint 10)
// ---------------------------------------------------------------------------

describe('PATCH /v1/launches/:id', () => {
  const LAUNCH_ID = '11111111-1111-1111-1111-111111111111';

  it('returns 401 when Authorization header is absent', async () => {
    const app = buildApp(undefined);
    const res = await app.fetch(
      new Request(`http://localhost/v1/launches/${LAUNCH_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ funnel_blueprint: {} }),
      }),
      createMockBindings({ DEV_WORKSPACE_ID: undefined }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when body is invalid JSON', async () => {
    const app = buildApp(undefined);
    const res = await app.fetch(
      new Request(`http://localhost/v1/launches/${LAUNCH_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: 'not-json',
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 when funnel_blueprint is missing from body', async () => {
    const app = buildApp(undefined);
    const res = await app.fetch(
      new Request(`http://localhost/v1/launches/${LAUNCH_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ other_field: 'value' }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('validation_error');
  });

  it('returns 503 when no DB configured', async () => {
    const app = buildApp(undefined);
    const res = await app.fetch(
      new Request(`http://localhost/v1/launches/${LAUNCH_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ funnel_blueprint: { stages: [] } }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(503);
  });

  it('returns 404 when DB returns no updated rows', async () => {
    const mockDb = {
      execute: vi.fn().mockResolvedValue([]),
    };
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request(`http://localhost/v1/launches/${LAUNCH_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ funnel_blueprint: { stages: [] } }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 with { launch: { id, public_id } } when DB mock succeeds', async () => {
    const mockDb = {
      execute: vi
        .fn()
        .mockResolvedValue([{ id: LAUNCH_ID, public_id: 'test-launch' }]),
    };
    const app = buildApp(() => mockDb as never);
    const res = await app.fetch(
      new Request(`http://localhost/v1/launches/${LAUNCH_ID}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEV_WS_ID}`,
        },
        body: JSON.stringify({ funnel_blueprint: { stages: [] } }),
      }),
      createMockBindings(),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ launch: { id: string; public_id: string } }>();
    expect(body.launch.id).toBe(LAUNCH_ID);
    expect(body.launch.public_id).toBe('test-launch');
  });
});
