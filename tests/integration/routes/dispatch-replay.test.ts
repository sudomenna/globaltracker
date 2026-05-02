/**
 * Integration tests — POST /v1/dispatch-jobs/:id/replay
 *
 * CONTRACT-api-dispatch-replay-v1
 * T-ID: T-8-009
 *
 * Covers:
 *   happy path: job in 'dead_letter' → 202, new_job_id, status='queued', audit recorded
 *   happy path: job in 'failed' → 202, new_job_id
 *   happy path: job in 'succeeded' → 202 (succeeded is replayable per ADR-025)
 *   not replayable: job in 'pending' → 409 not_replayable / job_in_progress
 *   not replayable: job in 'processing' → 409 not_replayable / job_in_progress
 *   not replayable: job in 'retrying' → 409 not_replayable / job_in_progress
 *   not found: job not in DB → 404 job_not_found
 *   missing justification → 400 validation_error
 *   body with extra field (.strict) → 400 validation_error
 *   body malformed JSON → 400 validation_error
 *   invalid UUID :id → 400 validation_error
 *   missing Authorization header → 401
 *   malformed Authorization header → 401
 *   X-Request-Id present on all responses
 *   audit action='replay_dispatch' with justification + original_job_id
 *   test_mode=true sets is_test:true in new job payload (tested via createReplayJob stub)
 *
 * Test approach: real Hono app, injected stub DB functions + env bindings.
 * No external DB or Cloudflare runtime required — runs with vitest node environment.
 *
 * ADR-025: creates new job child — does NOT reset the original.
 * BR-DISPATCH-001: replay idempotency_key is distinct from original.
 * BR-DISPATCH-005: dead_letter não reprocessa automaticamente.
 * BR-AUDIT-001: toda mutação sensível registra audit_log (action='replay_dispatch').
 * BR-PRIVACY-001: zero PII em logs e error responses.
 * BR-RBAC-002: workspace_id isolation via context variable.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  type CreateReplayJobFn,
  type DispatchJobForReplay,
  type GetDispatchJobFn,
  type InsertAuditEntryFn,
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
const NEW_JOB_ID = '22222222-2222-2222-2222-222222222222';
const VALID_WORKSPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VALID_JUSTIFICATION = 'Reprocessing after platform outage was resolved';

function makeJob(
  status: DispatchJobForReplay['status'] = 'dead_letter',
): DispatchJobForReplay {
  return {
    id: VALID_JOB_ID,
    workspace_id: VALID_WORKSPACE_ID,
    lead_id: null,
    event_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    event_workspace_id: VALID_WORKSPACE_ID,
    destination: 'meta_capi',
    destination_account_id: 'acct-123',
    destination_resource_id: 'pixel-456',
    destination_subresource: null,
    max_attempts: 5,
    payload: { event_name: 'Lead' },
    status,
  };
}

function makeCreateReplayJob(): CreateReplayJobFn {
  return vi.fn(async () => ({
    id: NEW_JOB_ID,
    destination: 'meta_capi',
  }));
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
// ---------------------------------------------------------------------------

function buildApp(opts: {
  workspaceId?: string;
  getDispatchJob?: GetDispatchJobFn;
  createReplayJob?: CreateReplayJobFn;
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
      createReplayJob: opts.createReplayJob,
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
      : JSON.stringify(
          opts.body ?? { justification: VALID_JUSTIFICATION },
        );

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

  it('returns 400 when body justification is missing', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer token',
      body: {},
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when justification is empty string', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer token',
      body: { justification: '' },
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when justification is too long (> 500 chars)', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer token',
      body: { justification: 'a'.repeat(501) },
    });

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when body has extra field (.strict)', async () => {
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });
    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer token',
      body: {
        justification: VALID_JUSTIFICATION,
        unexpected_field: 'value',
      },
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
    });

    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });

    expect(res.status).toBe(404);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('job_not_found');
  });
});

// ---------------------------------------------------------------------------
// 409 — not replayable (job in progress)
// ---------------------------------------------------------------------------

describe('POST /v1/dispatch-jobs/:id/replay — not replayable', () => {
  // ADR-025: pending/processing/retrying are in-progress — cannot create duplicate
  it.each(['pending', 'processing', 'retrying'] as const)(
    'returns 409 not_replayable when status is %s',
    async (status) => {
      const { app, env } = buildApp({
        workspaceId: VALID_WORKSPACE_ID,
        getDispatchJob: async () => makeJob(status),
        createReplayJob: makeCreateReplayJob(),
      });

      const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });

      expect(res.status).toBe(409);
      const body = await res.json<{ error: string; reason: string }>();
      expect(body.error).toBe('not_replayable');
      expect(body.reason).toBe('job_in_progress');
    },
  );
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('POST /v1/dispatch-jobs/:id/replay — happy path', () => {
  it('returns 202 with new_job_id for dead_letter job', async () => {
    const auditEntries: unknown[] = [];
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeJob('dead_letter'),
      createReplayJob: makeCreateReplayJob(),
      insertAuditEntry: vi.fn(async (entry) => {
        auditEntries.push(entry);
      }),
    });

    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
      body: { justification: VALID_JUSTIFICATION },
    });

    expect(res.status).toBe(202);
    const body = await res.json<{ new_job_id: string; status: string }>();
    expect(body.new_job_id).toBe(NEW_JOB_ID);
    expect(body.status).toBe('queued');
  });

  it('returns 202 with new_job_id for failed job', async () => {
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeJob('failed'),
      createReplayJob: makeCreateReplayJob(),
      insertAuditEntry: vi.fn(async () => {}),
    });

    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
      body: { justification: VALID_JUSTIFICATION },
    });

    expect(res.status).toBe(202);
    const body = await res.json<{ new_job_id: string; status: string }>();
    expect(body.new_job_id).toBe(NEW_JOB_ID);
    expect(body.status).toBe('queued');
  });

  it('returns 202 for succeeded job (succeeded is replayable per ADR-025)', async () => {
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeJob('succeeded'),
      createReplayJob: makeCreateReplayJob(),
      insertAuditEntry: vi.fn(async () => {}),
    });

    const res = await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
      body: { justification: VALID_JUSTIFICATION },
    });

    expect(res.status).toBe(202);
  });

  it('enqueues new_job_id to QUEUE_DISPATCH on success', async () => {
    const { app, env, queue } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeJob('dead_letter'),
      createReplayJob: makeCreateReplayJob(),
      insertAuditEntry: vi.fn(async () => {}),
    });

    await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
    });

    expect(queue.send).toHaveBeenCalledOnce();
    const callArg = (queue.send as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArg).toMatchObject({
      dispatch_job_id: NEW_JOB_ID,
      destination: 'meta_capi',
    });
  });

  it('records audit log with action=replay_dispatch and justification', async () => {
    const auditEntries: Array<{
      action: string;
      entity_type: string;
      entity_id: string;
      metadata: Record<string, unknown>;
    }> = [];

    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeJob('dead_letter'),
      createReplayJob: makeCreateReplayJob(),
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
      body: { justification: VALID_JUSTIFICATION },
    });

    expect(auditEntries).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: guarded by toHaveLength(1) assertion above
    const entry = auditEntries[0]!;
    // BR-AUDIT-001: action='replay_dispatch' per CONTRACT-api-dispatch-replay-v1
    expect(entry.action).toBe('replay_dispatch');
    expect(entry.entity_type).toBe('dispatch_job');
    expect(entry.entity_id).toBe(NEW_JOB_ID);
    // ADR-025: audit records both original and new job IDs
    expect(entry.metadata.original_job_id).toBe(VALID_JOB_ID);
    expect(entry.metadata.new_job_id).toBe(NEW_JOB_ID);
    expect(entry.metadata.justification).toBe(VALID_JUSTIFICATION);
    // BR-PRIVACY-001: no PII in audit metadata
    expect(JSON.stringify(entry)).not.toMatch(/email|phone|name/i);
  });

  it('passes test_mode=true in payload to createReplayJob when test_mode=true', async () => {
    const createReplayJob = vi.fn(async () => ({
      id: NEW_JOB_ID,
      destination: 'meta_capi',
    }));

    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeJob('dead_letter'),
      createReplayJob,
      insertAuditEntry: vi.fn(async () => {}),
    });

    await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
      body: { justification: VALID_JUSTIFICATION, test_mode: true },
    });

    expect(createReplayJob).toHaveBeenCalledOnce();
    const callArg = (createReplayJob as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { payload: Record<string, unknown> };
    expect(callArg.payload.is_test).toBe(true);
  });

  it('createReplayJob receives replayed_from_dispatch_job_id = original job id', async () => {
    const createReplayJob = vi.fn(async () => ({
      id: NEW_JOB_ID,
      destination: 'meta_capi',
    }));

    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeJob('dead_letter'),
      createReplayJob,
      insertAuditEntry: vi.fn(async () => {}),
    });

    await post(app, env, VALID_JOB_ID, {
      auth: 'Bearer operator-token',
      body: { justification: VALID_JUSTIFICATION },
    });

    expect(createReplayJob).toHaveBeenCalledOnce();
    const callArg = (createReplayJob as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as { replayed_from_dispatch_job_id: string };
    // ADR-025: new job must link back to the original
    expect(callArg.replayed_from_dispatch_job_id).toBe(VALID_JOB_ID);
  });

  it('returns X-Request-Id header on 202', async () => {
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeJob('dead_letter'),
      createReplayJob: makeCreateReplayJob(),
      insertAuditEntry: vi.fn(async () => {}),
    });

    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns 202 even when insertAuditEntry throws (audit soft-fail)', async () => {
    const { app, env } = buildApp({
      workspaceId: VALID_WORKSPACE_ID,
      getDispatchJob: async () => makeJob('dead_letter'),
      createReplayJob: makeCreateReplayJob(),
      insertAuditEntry: vi.fn(async () => {
        throw new Error('DB unavailable');
      }),
    });

    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });
    // BR-AUDIT-001: audit failure should NOT fail the request (job already enqueued)
    expect(res.status).toBe(202);
  });

  it('returns 202 with no DB deps injected (stub mode)', async () => {
    // When no deps are provided, route skips DB checks and goes straight
    // to queue.send — useful for smoke-testing the route wiring.
    const { app, env } = buildApp({ workspaceId: VALID_WORKSPACE_ID });

    const res = await post(app, env, VALID_JOB_ID, { auth: 'Bearer token' });
    expect(res.status).toBe(202);
    const body = await res.json<{ status: string }>();
    expect(body.status).toBe('queued');
  });
});
