/**
 * Integration tests — /v1/orchestrator/workflows/*
 *
 * T-ID: T-7-004
 *
 * Covers:
 *   POST /:workflow/trigger
 *     1. setup-tracking: 202 with run_id
 *     2. deploy-lp: 202 with run_id
 *     3. 400 if body invalid (missing slug for deploy-lp)
 *     4. 401 if no Authorization header
 *     5. 409 if active run exists for same launch + workflow
 *
 *   GET /:run_id/status
 *     6. 200 with run data when found
 *     7. 404 if run_id unknown
 *     8. 401 if no auth
 *
 *   POST /:run_id/approve
 *     9.  200 when run in waiting_approval
 *    10.  409 if status ≠ waiting_approval
 *    11.  401 without auth
 *
 *   POST /:run_id/rollback
 *    12.  202 when rollbackable
 *    13.  409 already_rolled_back
 *    14.  409 not_rollbackable (e.g. status=running)
 *    15.  401 without auth
 *
 * Test approach:
 *   - Real Hono app with createOrchestratorRoute mounted.
 *   - All DB operations mocked via injected dependencies.
 *   - Trigger.dev fetch is mocked via vi.stubGlobal.
 *   - BR-PRIVACY-001: error responses must not contain PII.
 *   - BR-RBAC-002: workspace_id anchor enforced via dependency mock behaviour.
 *   - BR-AUDIT-001: audit entry inserted on every mutation.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FindActiveRunFn,
  type GetWorkflowRunFn,
  type InsertAuditEntryFn,
  type InsertWorkflowRunFn,
  type UpdateWorkflowRunFn,
  type WorkflowRunRow,
  createOrchestratorRoute,
} from '../../../apps/edge/src/routes/orchestrator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
  TRIGGER_SECRET_KEY?: string;
};

type Variables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TEST_RUN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const TEST_LAUNCH_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TEST_PAGE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const VALID_BEARER = 'Bearer test-api-key-123';

function makeRun(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: TEST_RUN_ID,
    workspace_id: TEST_WORKSPACE_ID,
    workflow: 'setup-tracking',
    status: 'running',
    trigger_run_id: 'run_trigger_123',
    trigger_payload: { page_id: TEST_PAGE_ID, launch_id: TEST_LAUNCH_ID },
    result: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function buildApp(deps?: {
  getWorkflowRun?: GetWorkflowRunFn;
  findActiveRun?: FindActiveRunFn;
  insertWorkflowRun?: InsertWorkflowRunFn;
  updateWorkflowRun?: UpdateWorkflowRunFn;
  insertAuditEntry?: InsertAuditEntryFn;
}) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Inject workspace_id into context (simulates auth middleware in production)
  app.use('*', async (c, next) => {
    c.set('workspace_id', TEST_WORKSPACE_ID);
    c.set('request_id', 'test-request-id');
    await next();
  });

  app.route('/v1/orchestrator/workflows', createOrchestratorRoute(deps));
  return app;
}

function makeEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    GT_KV: {} as KVNamespace,
    QUEUE_EVENTS: {} as Queue,
    QUEUE_DISPATCH: {} as Queue,
    ENVIRONMENT: 'test',
    TRIGGER_SECRET_KEY: undefined, // disabled by default so fetch mock isn't needed per test
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /:workflow/trigger', () => {
  it('returns 202 with run_id for setup-tracking', async () => {
    const insertWorkflowRun = vi
      .fn<InsertWorkflowRunFn>()
      .mockResolvedValue({ id: TEST_RUN_ID });
    const insertAuditEntry = vi
      .fn<InsertAuditEntryFn>()
      .mockResolvedValue(undefined);
    const app = buildApp({ insertWorkflowRun, insertAuditEntry });

    const req = new Request(
      'http://localhost/v1/orchestrator/workflows/setup-tracking/trigger',
      {
        method: 'POST',
        headers: {
          Authorization: VALID_BEARER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          page_id: TEST_PAGE_ID,
          launch_id: TEST_LAUNCH_ID,
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(202);
    expect(body.run_id).toBe(TEST_RUN_ID);
    expect(body.workflow).toBe('setup-tracking');
    expect(body.status).toBe('running');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    expect(insertAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow_triggered' }),
    );
  });

  it('returns 202 with run_id for deploy-lp', async () => {
    const insertWorkflowRun = vi
      .fn<InsertWorkflowRunFn>()
      .mockResolvedValue({ id: TEST_RUN_ID });
    const app = buildApp({ insertWorkflowRun });

    const req = new Request(
      'http://localhost/v1/orchestrator/workflows/deploy-lp/trigger',
      {
        method: 'POST',
        headers: {
          Authorization: VALID_BEARER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template: 'basic',
          launch_id: TEST_LAUNCH_ID,
          slug: 'my-lp',
          domain: 'example.com',
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(202);
    expect(body.workflow).toBe('deploy-lp');
    expect(body.run_id).toBeTruthy();
  });

  it('returns 400 if body is invalid (missing slug for deploy-lp)', async () => {
    const app = buildApp();

    const req = new Request(
      'http://localhost/v1/orchestrator/workflows/deploy-lp/trigger',
      {
        method: 'POST',
        headers: {
          Authorization: VALID_BEARER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          template: 'basic',
          launch_id: TEST_LAUNCH_ID,
          // slug missing
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(400);
    expect(body.code).toBe('validation_error');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/email|phone|name/i);
  });

  it('returns 401 if Authorization header is missing', async () => {
    const app = buildApp();

    const req = new Request(
      'http://localhost/v1/orchestrator/workflows/setup-tracking/trigger',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: TEST_PAGE_ID,
          launch_id: TEST_LAUNCH_ID,
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(401);
    expect(body.code).toBe('unauthorized');
  });

  it('returns 409 if an active run already exists for same launch + workflow', async () => {
    const findActiveRun = vi
      .fn<FindActiveRunFn>()
      .mockResolvedValue({ id: 'existing-run-id' });
    const app = buildApp({ findActiveRun });

    const req = new Request(
      'http://localhost/v1/orchestrator/workflows/setup-tracking/trigger',
      {
        method: 'POST',
        headers: {
          Authorization: VALID_BEARER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          page_id: TEST_PAGE_ID,
          launch_id: TEST_LAUNCH_ID,
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.code).toBe('conflict');
  });
});

describe('GET /:run_id/status', () => {
  it('returns 200 with run data when found', async () => {
    const run = makeRun({ status: 'waiting_approval' });
    const getWorkflowRun = vi.fn<GetWorkflowRunFn>().mockResolvedValue(run);
    const app = buildApp({ getWorkflowRun });

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/status`,
      {
        method: 'GET',
        headers: { Authorization: VALID_BEARER },
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.run_id).toBe(TEST_RUN_ID);
    expect(body.workflow).toBe('setup-tracking');
    expect(body.status).toBe('waiting_approval');
    expect(body.trigger_run_id).toBe('run_trigger_123');
  });

  it('returns 404 if run_id is unknown', async () => {
    const getWorkflowRun = vi.fn<GetWorkflowRunFn>().mockResolvedValue(null);
    const app = buildApp({ getWorkflowRun });

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/status`,
      {
        method: 'GET',
        headers: { Authorization: VALID_BEARER },
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(404);
    expect(body.code).toBe('run_not_found');
  });

  it('returns 401 without auth', async () => {
    const app = buildApp();

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/status`,
      {
        method: 'GET',
      },
    );

    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });
});

describe('POST /:run_id/approve', () => {
  it('returns 200 when run is in waiting_approval', async () => {
    const run = makeRun({ status: 'waiting_approval' });
    const getWorkflowRun = vi.fn<GetWorkflowRunFn>().mockResolvedValue(run);
    const updateWorkflowRun = vi
      .fn<UpdateWorkflowRunFn>()
      .mockResolvedValue(undefined);
    const insertAuditEntry = vi
      .fn<InsertAuditEntryFn>()
      .mockResolvedValue(undefined);
    const app = buildApp({
      getWorkflowRun,
      updateWorkflowRun,
      insertAuditEntry,
    });

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/approve`,
      {
        method: 'POST',
        headers: {
          Authorization: VALID_BEARER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          justification: 'Approved after review of all requirements.',
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.run_id).toBe(TEST_RUN_ID);
    expect(body.status).toBe('running');
    expect(updateWorkflowRun).toHaveBeenCalledWith(
      TEST_RUN_ID,
      TEST_WORKSPACE_ID,
      expect.objectContaining({ status: 'running' }),
    );
    expect(insertAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow_approved' }),
    );
  });

  it('returns 409 not_approvable if status is not waiting_approval', async () => {
    const run = makeRun({ status: 'completed' });
    const getWorkflowRun = vi.fn<GetWorkflowRunFn>().mockResolvedValue(run);
    const app = buildApp({ getWorkflowRun });

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/approve`,
      {
        method: 'POST',
        headers: {
          Authorization: VALID_BEARER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          justification: 'Approved after review of all requirements.',
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.code).toBe('not_approvable');
  });

  it('returns 401 without auth', async () => {
    const app = buildApp();

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/approve`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          justification: 'Approved after review of all requirements.',
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });
});

describe('POST /:run_id/rollback', () => {
  it('returns 202 when run is in a rollbackable status', async () => {
    const run = makeRun({ status: 'completed' });
    const getWorkflowRun = vi.fn<GetWorkflowRunFn>().mockResolvedValue(run);
    const updateWorkflowRun = vi
      .fn<UpdateWorkflowRunFn>()
      .mockResolvedValue(undefined);
    const insertAuditEntry = vi
      .fn<InsertAuditEntryFn>()
      .mockResolvedValue(undefined);
    const app = buildApp({
      getWorkflowRun,
      updateWorkflowRun,
      insertAuditEntry,
    });

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/rollback`,
      {
        method: 'POST',
        headers: {
          Authorization: VALID_BEARER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Rolling back due to configuration error discovered.',
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(202);
    expect(body.run_id).toBe(TEST_RUN_ID);
    expect(body.status).toBe('rolled_back');
    expect(updateWorkflowRun).toHaveBeenCalledWith(
      TEST_RUN_ID,
      TEST_WORKSPACE_ID,
      expect.objectContaining({ status: 'rolled_back' }),
    );
    expect(insertAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workflow_rollback' }),
    );
  });

  it('returns 409 already_rolled_back if status is rolled_back', async () => {
    const run = makeRun({ status: 'rolled_back' });
    const getWorkflowRun = vi.fn<GetWorkflowRunFn>().mockResolvedValue(run);
    const app = buildApp({ getWorkflowRun });

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/rollback`,
      {
        method: 'POST',
        headers: {
          Authorization: VALID_BEARER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Rolling back due to configuration error discovered.',
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.code).toBe('already_rolled_back');
  });

  it('returns 409 not_rollbackable if status is running', async () => {
    const run = makeRun({ status: 'running' });
    const getWorkflowRun = vi.fn<GetWorkflowRunFn>().mockResolvedValue(run);
    const app = buildApp({ getWorkflowRun });

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/rollback`,
      {
        method: 'POST',
        headers: {
          Authorization: VALID_BEARER,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Rolling back due to configuration error discovered.',
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body.code).toBe('not_rollbackable');
  });

  it('returns 401 without auth', async () => {
    const app = buildApp();

    const req = new Request(
      `http://localhost/v1/orchestrator/workflows/${TEST_RUN_ID}/rollback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: 'Rolling back due to configuration error discovered.',
        }),
      },
    );

    const res = await app.fetch(req, makeEnv());
    expect(res.status).toBe(401);
  });
});
