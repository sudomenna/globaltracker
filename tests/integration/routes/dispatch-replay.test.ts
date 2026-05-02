/**
 * Integration tests — POST /v1/dispatch-jobs/:id/replay
 *
 * CONTRACT-api-dispatch-replay-v1
 * T-ID: T-6-008
 *
 * Covers:
 *   happy path: job in 'dead_letter' → 200, queued=true, audit recorded
 *   happy path: job in 'failed' → 200, queued=true
 *   not replayable: job in 'pending' → 409 job_not_replayable
 *   not replayable: job in 'processing' → 409 job_not_replayable
 *   not replayable: job in 'succeeded' → 409 job_not_replayable
 *   not found: job not in DB → 404 job_not_found
 *   concurrent modification: requeue returns null → 409 concurrent_modification
 *   invalid UUID :id → 400 validation_error
 *   body missing reason → 400 validation_error
 *   body reason too short → 400 validation_error
 *   body reason too long → 400 validation_error
 *   body with extra field (.strict) → 400 validation_error
 *   body malformed JSON → 400 validation_error
 *   missing Authorization header → 401
 *   malformed Authorization header → 401
 *   X-Request-Id present on all responses
 *
 * Test approach: real Hono app, injected stub DB functions + env bindings.
 * No external DB or Cloudflare runtime required — runs with vitest node environment.
 *
 * BR-DISPATCH-005: dead_letter não reprocessa automaticamente.
 * BR-AUDIT-001: toda mutação sensível registra audit_log (action='reprocess_dlq').
 * BR-PRIVACY-001: zero PII em logs e error responses.
 * BR-RBAC-002: workspace_id isolation via context variable.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  type DispatchJobForReplay,
  type GetDispatchJobFn,
  type InsertAuditEntryFn,
  type RequeueDispatchJobFn,
  createDispatchReplayRoute,
} from '../../../apps/edge/src/routes/dispatch-replay.js';

// ---------------------------------------------------------------------------
// Types for minimal Hono test app
// ---------------------------------------------------------------------------

type Bindings = {
  HYPERDRIVE: Hyperdrive;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
};

type Variables = {
  workspace_id: string;
  request_id: string;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_JOB_ID = '11111111-1111-1111-1111-111111111111';
const VALID_WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VALID_REASON = 'Reprocessing after platform outage was resolved';

function makeDeadLetterJob(
  status: 'dead_letter' | 'failed' = 'dead_letter',
): DispatchJobForReplay {
  return {
    id: VALID_JOB_ID,
    workspace_id: VALID_WORKSPACE_ID,
    destination: 'meta_capi',
    status,
  };
}

// ---------------------------------------------------------------------------
// Fake Queue binding
// ---------------------------------------------------------------------------

function makeFakeQueue(): Queue & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn(async (msg: unknown) => {
      sent.push(msg);
    }),
    sendBatch: vi.fn(async () => {}),
  } as unknown as Queue & { sent: unknown[] };
}

// ---------------------------------------------------------------------------
// App + env builder
// Following the pattern in tests/integration/routes/integrations-test.test.ts:
// env is passed as the third argument to app.request() — not via middleware.
// ---------------------------------------------------------------------------

function buildApp(opts: {
  workspaceId?: string;
  getDispatchJob?: GetDispatchJobFn;
  requeueDispatchJob?: RequeueDispatchJobFn;
  insertAuditEntry?: InsertAuditEntryFn;
  queue?: Queue & { sent: unknown[] };
}): {
  app: Hono<{ Bindings: Bindings; Variables: Variables }>;
  env: Bindings;
  queue: Queue & { sent: unknown[] };
} {
  const queue = opts.queue ?? makeFakeQueue();

  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Simulate auth middleware injecting workspace_id into context variables
  if (opts.workspaceId) {
    app.use('*', async (c, next) => {
      c.set('workspace_id', opts.workspaceId as string);
      await next();
    });
  }

  app.route(
    '/v1/dispatch-jobs',
    createDispatchReplayRoute({
      getDispatchJob: opts.getDispatchJob,
      requeueDispatchJob: opts.requeueDispatchJob,
      insertAuditEntry: opts.insertAuditEntry,
    }),
  );

  const env: Bindings = {
    HYPERDRIVE: {} as Hyperdrive,
    QUEUE_DISPATCH: queue,
    ENVIRONMENT: 'test',
  };

  return { app, env, queue };
}

/** Helper: POST /:id/replay with optional Authorization header and body */
async function post(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  env: Bindings,
  jobId: string,
  opts: {
    auth?: string;
    body?: unknown;
    rawBody?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.auth !== undefined) {
    headers.Authorization = opts.auth;
  }

  const bodyStr =
    opts.rawBody !== undefined
      ? opts.rawBody
      : JSON.stringify(opts.body ?? { reason: VALID_REASON });

  return app.request(
    `/v1/dispatch-jobs/${jobId}/replay`,
    {
      method: 'POST',
      headers,
      body: bodyStr,
    },
    env,
  );
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe('POST /v1/dispatch-jobs/:id/replay — auth', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, { auth: undefined });

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('unauthorized');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/email|phone|name/i);
  });

  it('returns 401 when Authorization header has wrong format', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, { auth: 'Token abc123' });

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('unauthorized');
  });

  it('returns 401 when Bearer token is empty', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer   ' });

    expect(res.status).toBe(401);
  });

  it('returns X-Request-Id on 401', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, { auth: undefined });
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe('POST /v1/dispatch-jobs/:id/replay — validation', () => {
  it('returns 400 when :id is not a valid UUID', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, 'not-a-uuid', { auth: 'Bearer token' });

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when body reason is missing', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer token',
      body: {},
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when reason is too short (< 10 chars)', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer token',
      body: { reason: 'short' },
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when reason is too long (> 500 chars)', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer token',
      body: { reason: 'a'.repeat(501) },
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when body has extra field (.strict)', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer token',
      body: { reason: VALID_REASON, unexpected_field: 'value' },
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when body is malformed JSON', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer token',
      rawBody: '{invalid json',
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns X-Request-Id on 400', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, 'not-a-uuid', { auth: 'Bearer token' });
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 404 — job not found
// ---------------------------------------------------------------------------

describe('POST /v1/dispatch-jobs/:id/replay — not found', () => {
  it('returns 404 when job does not exist in workspace', async () => {
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => null,
      requeueDispatchJob: async () => null,
    });

    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });

    expect(res.status).toBe(404);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('job_not_found');
  });
});

// ---------------------------------------------------------------------------
// 409 — not replayable
// ---------------------------------------------------------------------------

describe('POST /v1/dispatch-jobs/:id/replay — not replayable', () => {
  it.each([
    'pending',
    'processing',
    'succeeded',
    'skipped',
    'retrying',
  ] as const)(
    'returns 409 job_not_replayable when status is %s',
    async (status) => {
      const { app, env } = buildApp({
        workspaceId: VALID_WORKSPACE_ID,
        getDispatchJob: async () => ({
          ...makeDeadLetterJob(),
          status,
        }),
        requeueDispatchJob: async () => null,
      });

      const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });

      expect(res.status).toBe(409);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('job_not_replayable');
    },
  );

  it('returns 409 concurrent_modification when requeue returns null (race condition)', async () => {
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeDeadLetterJob('dead_letter'),
      // Simulates another process already changing status before our UPDATE
      requeueDispatchJob: async () => null,
    });

    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });

    expect(res.status).toBe(409);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('concurrent_modification');
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('POST /v1/dispatch-jobs/:id/replay — happy path', () => {
  it('returns 200 queued=true for dead_letter job', async () => {
    const auditEntries: unknown[] = [];
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeDeadLetterJob('dead_letter'),
      requeueDispatchJob: async (jobId) => ({
        id: jobId,
        destination: 'meta_capi',
        status: 'pending',
      }),
      insertAuditEntry: vi.fn(async (entry) => {
        auditEntries.push(entry);
      }),
    });

    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
      body: { reason: VALID_REASON },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{
      queued: boolean;
      job_id: string;
      destination: string;
      message: string;
    }>();

    expect(body.queued).toBe(true);
    expect(body.job_id).toBe(VALID_JOB_ID);
    expect(body.destination).toBe('meta_capi');
    expect(body.message).toBe('Job enfileirado para re-processamento');
  });

  it('returns 200 queued=true for failed job', async () => {
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeDeadLetterJob('failed'),
      requeueDispatchJob: async (jobId) => ({
        id: jobId,
        destination: 'ga4_mp',
        status: 'pending',
      }),
      insertAuditEntry: vi.fn(async () => {}),
    });

    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
      body: { reason: VALID_REASON },
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ queued: boolean; destination: string }>();
    expect(body.queued).toBe(true);
    expect(body.destination).toBe('ga4_mp');
  });

  it('enqueues message to QUEUE_DISPATCH on success', async () => {
    const { app, env, queue } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeDeadLetterJob('dead_letter'),
      requeueDispatchJob: async (jobId) => ({
        id: jobId,
        destination: 'meta_capi',
        status: 'pending',
      }),
      insertAuditEntry: vi.fn(async () => {}),
    });

    await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
    });

    expect(queue.send).toHaveBeenCalledOnce();
    const callArg = (queue.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg).toMatchObject({
      dispatch_job_id: VALID_JOB_ID,
      destination: 'meta_capi',
    });
  });

  it('records audit log with action=reprocess_dlq on success', async () => {
    const auditEntries: Array<{
      action: string;
      entity_type: string;
      entity_id: string;
      metadata: Record<string, unknown>;
    }> = [];

    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeDeadLetterJob('dead_letter'),
      requeueDispatchJob: async (jobId) => ({
        id: jobId,
        destination: 'meta_capi',
        status: 'pending',
      }),
      insertAuditEntry: vi.fn(async (entry) => {
        auditEntries.push(
          entry as {
            action: string;
            entity_type: string;
            entity_id: string;
            metadata: Record<string, unknown>;
          },
        );
      }),
    });

    await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
      body: { reason: VALID_REASON },
    });

    expect(auditEntries).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength(1) assertion above
    const entry = auditEntries[0]!;
    expect(entry.action).toBe('reprocess_dlq');
    expect(entry.entity_type).toBe('dispatch_job');
    expect(entry.entity_id).toBe(VALID_JOB_ID);
    expect(entry.metadata.reason).toBe(VALID_REASON);
    // BR-PRIVACY-001: no PII in audit metadata
    expect(JSON.stringify(entry)).not.toMatch(/email|phone|name/i);
  });

  it('returns X-Request-Id header on 200', async () => {
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeDeadLetterJob('dead_letter'),
      requeueDispatchJob: async (jobId) => ({
        id: jobId,
        destination: 'meta_capi',
        status: 'pending',
      }),
      insertAuditEntry: vi.fn(async () => {}),
    });

    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns 200 even when insertAuditEntry throws (audit soft-fail)', async () => {
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeDeadLetterJob('dead_letter'),
      requeueDispatchJob: async (jobId) => ({
        id: jobId,
        destination: 'meta_capi',
        status: 'pending',
      }),
      insertAuditEntry: vi.fn(async () => {
        throw new Error('DB unavailable');
      }),
    });

    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });
    // BR-AUDIT-001: audit failure should NOT fail the request (job already enqueued)
    expect(res.status).toBe(200);
  });

  it('returns 200 with no DB deps injected (stub mode)', async () => {
    // When no deps are provided, route skips DB checks and goes straight
    // to queue.send — useful for smoke-testing the route wiring.
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });

    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });
    expect(res.status).toBe(200);
    const body = await res.json<{ queued: boolean }>();
    expect(body.queued).toBe(true);
  });
});
