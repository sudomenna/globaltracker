/**
 * Integration tests — GET /v1/onboarding/state + PATCH /v1/onboarding/state
 *
 * CONTRACT-api-onboarding-state-v1
 *
 * Covers:
 *   GET  — 200 happy path (returns onboarding_state)
 *   GET  — 404 when workspace not found
 *   GET  — 401 missing Authorization
 *   GET  — 401 malformed Authorization
 *   GET  — X-Request-Id present
 *   PATCH — step='meta' → merges step_meta correctly
 *   PATCH — step='skip_all' → sets skipped_at in fragment
 *   PATCH — step='complete' → sets completed_at in fragment
 *   PATCH — step='launch' → merges step_launch with launch_id
 *   PATCH — step='install' → sets started_at when not already set
 *   PATCH — body validation error → 400
 *   PATCH — unknown field rejected (.strict()) → 400
 *   PATCH — 401 missing Authorization
 *   PATCH — audit entry recorded on success
 *   PATCH — audit failure does not fail the request
 *
 * Test approach: real Hono app, injected stub DB functions.
 * No external DB or Cloudflare runtime required — runs with vitest node environment.
 *
 * BR-PRIVACY-001: no PII in logs or error responses.
 * BR-RBAC-002: workspace_id isolation via context variable.
 * BR-AUDIT-001: every mutation generates an audit log entry.
 * INV-WORKSPACE-003: onboarding_state shape validated by Zod.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  type GetOnboardingStateFn,
  type InsertAuditEntryFn,
  type MergeOnboardingStateFn,
  buildMergeFragment,
  createOnboardingStateRoute,
} from '../../../apps/edge/src/routes/onboarding-state.js';
import type { OnboardingState } from '../../../packages/shared/src/schemas/onboarding-state.js';

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
    getState?: GetOnboardingStateFn;
    mergeState?: MergeOnboardingStateFn;
    insertAuditEntry?: InsertAuditEntryFn;
    workspaceId?: string;
  } = {},
): Hono<{ Bindings: Bindings; Variables: Variables }> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Simulate auth middleware injecting workspace_id
  if (opts.workspaceId) {
    app.use('*', async (c, next) => {
      c.set('workspace_id', opts.workspaceId as string);
      await next();
    });
  }

  app.route(
    '/v1/onboarding',
    createOnboardingStateRoute({
      getState: opts.getState,
      mergeState: opts.mergeState,
      insertAuditEntry: opts.insertAuditEntry,
    }),
  );

  return app;
}

/** Make a GET request with optional Authorization header */
async function get(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  opts: { auth?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.auth !== undefined) headers.Authorization = opts.auth;
  return app.request(path, { method: 'GET', headers });
}

/** Make a PATCH request with JSON body and optional Authorization header */
async function patch(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  body: unknown,
  opts: { auth?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.auth !== undefined) headers.Authorization = opts.auth;
  return app.request(path, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Unit tests for buildMergeFragment
// ---------------------------------------------------------------------------

describe('buildMergeFragment', () => {
  it('builds step_meta fragment with completed_at and validated', () => {
    const body = {
      step: 'meta' as const,
      completed_at: '2024-01-15T10:00:00.000Z',
      validated: true,
    };
    const fragment = buildMergeFragment(body, undefined);
    expect(fragment.step_meta).toEqual({
      completed_at: '2024-01-15T10:00:00.000Z',
      validated: true,
    });
    // started_at injected since currentStartedAt is null
    expect(typeof fragment.started_at).toBe('string');
  });

  it('builds step_meta fragment with capi_token', () => {
    const body = {
      step: 'meta' as const,
      completed_at: '2024-01-15T10:00:00.000Z',
      pixel_id: '123456789012345',
      capi_token: 'EAAxxxxxx',
      validated: true,
    };
    const fragment = buildMergeFragment(body, '2024-01-10T00:00:00.000Z');
    const stepMeta = fragment.step_meta as Record<string, unknown>;
    expect(stepMeta.pixel_id).toBe('123456789012345');
    expect(stepMeta.capi_token).toBe('EAAxxxxxx');
    expect(stepMeta.validated).toBe(true);
  });

  it('builds step_ga4 fragment with api_secret', () => {
    const body = {
      step: 'ga4' as const,
      measurement_id: 'G-XXXXXXXXXX',
      api_secret: 'supersecret',
      validated: true,
    };
    const fragment = buildMergeFragment(body, '2024-01-14T00:00:00.000Z');
    const stepGa4 = fragment.step_ga4 as Record<string, unknown>;
    expect(stepGa4.measurement_id).toBe('G-XXXXXXXXXX');
    expect(stepGa4.api_secret).toBe('supersecret');
    expect(stepGa4.validated).toBe(true);
  });

  it('builds step_ga4 fragment', () => {
    const body = { step: 'ga4' as const, validated: false };
    const fragment = buildMergeFragment(body, '2024-01-14T00:00:00.000Z');
    expect(fragment.step_ga4).toEqual({ validated: false });
    // started_at not injected since already set
    expect(fragment.started_at).toBeUndefined();
  });

  it('builds step_launch fragment with launch_public_id', () => {
    const launchPublicId = 'wkshop-cs-jun26';
    const body = {
      step: 'launch' as const,
      completed_at: '2024-01-15T10:00:00.000Z',
      launch_public_id: launchPublicId,
    };
    const fragment = buildMergeFragment(body, null);
    expect(fragment.step_launch).toEqual({
      completed_at: '2024-01-15T10:00:00.000Z',
      launch_public_id: launchPublicId,
    });
    expect(typeof fragment.started_at).toBe('string');
  });

  it('builds step_page fragment with page_public_id', () => {
    const pagePublicId = 'minha-lp-inscricao';
    const body = { step: 'page' as const, page_public_id: pagePublicId };
    const fragment = buildMergeFragment(body, null);
    expect(fragment.step_page).toEqual({ page_public_id: pagePublicId });
  });

  it('builds step_install fragment with first_ping_at', () => {
    const body = {
      step: 'install' as const,
      first_ping_at: '2024-01-15T12:00:00.000Z',
    };
    const fragment = buildMergeFragment(body, null);
    expect(fragment.step_install).toEqual({
      first_ping_at: '2024-01-15T12:00:00.000Z',
    });
  });

  it('builds skip_all fragment with skipped_at from body', () => {
    const skippedAt = '2024-01-15T14:00:00.000Z';
    const body = { step: 'skip_all' as const, skipped_at: skippedAt };
    const fragment = buildMergeFragment(body, null);
    expect(fragment.skipped_at).toBe(skippedAt);
    // started_at injected since currentStartedAt is null
    expect(typeof fragment.started_at).toBe('string');
  });

  it('skip_all uses NOW() when no skipped_at in body', () => {
    const body = { step: 'skip_all' as const };
    const fragment = buildMergeFragment(body, null);
    expect(typeof fragment.skipped_at).toBe('string');
  });

  it('skip_all does NOT inject started_at when already set', () => {
    const body = { step: 'skip_all' as const };
    const fragment = buildMergeFragment(body, '2024-01-10T00:00:00.000Z');
    expect(fragment.started_at).toBeUndefined();
  });

  it('builds complete fragment with completed_at from body', () => {
    const completedAt = '2024-01-20T18:00:00.000Z';
    const body = { step: 'complete' as const, completed_at: completedAt };
    const fragment = buildMergeFragment(body, '2024-01-10T00:00:00.000Z');
    expect(fragment.completed_at).toBe(completedAt);
  });

  it('complete uses NOW() when no completed_at in body', () => {
    const body = { step: 'complete' as const };
    const fragment = buildMergeFragment(body, '2024-01-10T00:00:00.000Z');
    expect(typeof fragment.completed_at).toBe('string');
  });

  it('does NOT inject started_at for skip_all/complete when already set', () => {
    const existingStartedAt = '2024-01-01T00:00:00.000Z';
    const fragmentSkip = buildMergeFragment(
      { step: 'skip_all' as const },
      existingStartedAt,
    );
    expect(fragmentSkip.started_at).toBeUndefined();

    const fragmentComplete = buildMergeFragment(
      { step: 'complete' as const },
      existingStartedAt,
    );
    expect(fragmentComplete.started_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — GET /v1/onboarding/state
// ---------------------------------------------------------------------------

describe('GET /v1/onboarding/state', () => {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 when Authorization header is missing', async () => {
    const app = buildApp();
    const res = await get(app, '/v1/onboarding/state');

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('unauthorized');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/email|phone|name/i);
  });

  it('returns 401 when Authorization has wrong format', async () => {
    const app = buildApp();
    const res = await get(app, '/v1/onboarding/state', {
      auth: 'Token abc123',
    });

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('unauthorized');
  });

  it('returns X-Request-Id on 401', async () => {
    const app = buildApp();
    const res = await get(app, '/v1/onboarding/state');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Happy path — 200
  // -------------------------------------------------------------------------

  it('returns 200 with onboarding_state when workspace exists', async () => {
    const mockState: OnboardingState = {
      started_at: '2024-01-10T00:00:00.000Z',
      step_meta: { completed_at: '2024-01-10T01:00:00.000Z', validated: true },
    };

    const app = buildApp({
      workspaceId: 'ws-onb-001',
      getState: async () => mockState,
    });

    const res = await get(app, '/v1/onboarding/state', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ onboarding_state: OnboardingState }>();
    expect(body.onboarding_state).toEqual(mockState);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns 200 with empty state when workspace has no steps yet', async () => {
    const app = buildApp({
      workspaceId: 'ws-onb-002',
      getState: async () => ({}),
    });

    const res = await get(app, '/v1/onboarding/state', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(200);
    const body = await res.json<{ onboarding_state: OnboardingState }>();
    expect(body.onboarding_state).toEqual({});
  });

  // -------------------------------------------------------------------------
  // 404 — workspace not found
  // -------------------------------------------------------------------------

  it('returns 404 when workspace does not exist', async () => {
    const app = buildApp({
      workspaceId: 'ws-missing',
      getState: async () => null,
    });

    const res = await get(app, '/v1/onboarding/state', {
      auth: 'Bearer some-jwt',
    });

    expect(res.status).toBe(404);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('workspace_not_found');
    // BR-PRIVACY-001: no PII in 404 response
    expect(JSON.stringify(body)).not.toMatch(/email|phone|name/i);
  });

  // -------------------------------------------------------------------------
  // X-Request-Id on success
  // -------------------------------------------------------------------------

  it('returns X-Request-Id on 200', async () => {
    const app = buildApp({
      workspaceId: 'ws-onb-003',
      getState: async () => ({}),
    });

    const res = await get(app, '/v1/onboarding/state', {
      auth: 'Bearer some-jwt',
    });

    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — PATCH /v1/onboarding/state
// ---------------------------------------------------------------------------

describe('PATCH /v1/onboarding/state', () => {
  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 when Authorization header is missing', async () => {
    const app = buildApp();
    const res = await patch(app, '/v1/onboarding/state', { step: 'meta' });

    expect(res.status).toBe(401);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('unauthorized');
  });

  // -------------------------------------------------------------------------
  // Validation errors — 400
  // -------------------------------------------------------------------------

  it('returns 400 when body is missing step', async () => {
    const app = buildApp({ workspaceId: 'ws-onb-010' });
    const res = await patch(
      app,
      '/v1/onboarding/state',
      { validated: true },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when step is invalid enum value', async () => {
    const app = buildApp({ workspaceId: 'ws-onb-011' });
    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'unknown_step' },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when body contains unknown field (.strict())', async () => {
    const app = buildApp({ workspaceId: 'ws-onb-012' });
    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'meta', unknown_field: 'value' },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(400);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when body is not valid JSON', async () => {
    const app = buildApp({ workspaceId: 'ws-onb-013' });
    const res = await app.request('/v1/onboarding/state', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer some-jwt',
        'Content-Type': 'application/json',
      },
      body: 'not-json',
    });

    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Happy path — step='meta'
  // -------------------------------------------------------------------------

  it('step=meta merges step_meta into onboarding_state', async () => {
    const initialState: OnboardingState = {};
    const updatedState: OnboardingState = {
      started_at: '2024-01-15T10:00:00.000Z',
      step_meta: { completed_at: '2024-01-15T10:00:00.000Z', validated: true },
    };

    const mergeState = vi.fn<MergeOnboardingStateFn>(async () => updatedState);
    const getState = vi.fn<GetOnboardingStateFn>(async () => initialState);

    const app = buildApp({
      workspaceId: 'ws-onb-020',
      getState,
      mergeState,
    });

    const res = await patch(
      app,
      '/v1/onboarding/state',
      {
        step: 'meta',
        completed_at: '2024-01-15T10:00:00.000Z',
        validated: true,
      },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ onboarding_state: OnboardingState }>();
    expect(body.onboarding_state).toEqual(updatedState);

    // Verify mergeState was called with a fragment containing step_meta
    expect(mergeState).toHaveBeenCalledOnce();
    const [_workspaceId, fragment] = mergeState.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fragment).toHaveProperty('step_meta');
    const stepMeta = fragment.step_meta as Record<string, unknown>;
    expect(stepMeta.validated).toBe(true);
    expect(stepMeta.completed_at).toBe('2024-01-15T10:00:00.000Z');

    // started_at injected since initialState had no started_at
    expect(typeof fragment.started_at).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Happy path — step='skip_all'
  // -------------------------------------------------------------------------

  it('step=skip_all sets skipped_at in merged state', async () => {
    const initialState: OnboardingState = {};
    const skippedAt = '2024-01-15T14:00:00.000Z';
    const updatedState: OnboardingState = {
      started_at: '2024-01-15T14:00:00.000Z',
      skipped_at: skippedAt,
    };

    const mergeState = vi.fn<MergeOnboardingStateFn>(async () => updatedState);
    const getState = vi.fn<GetOnboardingStateFn>(async () => initialState);

    const app = buildApp({
      workspaceId: 'ws-onb-021',
      getState,
      mergeState,
    });

    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'skip_all', skipped_at: skippedAt },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ onboarding_state: OnboardingState }>();
    expect(body.onboarding_state.skipped_at).toBe(skippedAt);

    // Verify fragment contains skipped_at
    const [, fragment] = mergeState.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fragment.skipped_at).toBe(skippedAt);
    // started_at injected since no initial started_at
    expect(typeof fragment.started_at).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Happy path — step='complete'
  // -------------------------------------------------------------------------

  it('step=complete sets completed_at in merged state', async () => {
    const completedAt = '2024-01-20T18:00:00.000Z';
    const initialState: OnboardingState = {
      started_at: '2024-01-15T00:00:00.000Z',
    };
    const updatedState: OnboardingState = {
      ...initialState,
      completed_at: completedAt,
    };

    const mergeState = vi.fn<MergeOnboardingStateFn>(async () => updatedState);
    const getState = vi.fn<GetOnboardingStateFn>(async () => initialState);

    const app = buildApp({
      workspaceId: 'ws-onb-022',
      getState,
      mergeState,
    });

    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'complete', completed_at: completedAt },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ onboarding_state: OnboardingState }>();
    expect(body.onboarding_state.completed_at).toBe(completedAt);
  });

  // -------------------------------------------------------------------------
  // Happy path — step='launch'
  // -------------------------------------------------------------------------

  it('step=launch merges step_launch with launch_public_id', async () => {
    const launchPublicId = 'wkshop-cs-jun26';
    const initialState: OnboardingState = {
      started_at: '2024-01-15T00:00:00.000Z',
    };
    const updatedState: OnboardingState = {
      ...initialState,
      step_launch: { launch_public_id: launchPublicId },
    };

    const mergeState = vi.fn<MergeOnboardingStateFn>(async () => updatedState);
    const getState = vi.fn<GetOnboardingStateFn>(async () => initialState);

    const app = buildApp({
      workspaceId: 'ws-onb-023',
      getState,
      mergeState,
    });

    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'launch', launch_public_id: launchPublicId },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ onboarding_state: OnboardingState }>();
    expect(body.onboarding_state.step_launch?.launch_public_id).toBe(launchPublicId);

    const [, fragment] = mergeState.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const stepLaunch = fragment.step_launch as Record<string, unknown>;
    expect(stepLaunch.launch_public_id).toBe(launchPublicId);
    // started_at NOT injected since already set
    expect(fragment.started_at).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // started_at injection when null
  // -------------------------------------------------------------------------

  it('step=install injects started_at when not already set', async () => {
    const initialState: OnboardingState = {};
    const updatedState: OnboardingState = {
      started_at: '2024-01-15T10:00:00.000Z',
      step_install: { first_ping_at: '2024-01-15T10:30:00.000Z' },
    };

    const mergeState = vi.fn<MergeOnboardingStateFn>(async () => updatedState);
    const getState = vi.fn<GetOnboardingStateFn>(async () => initialState);

    const app = buildApp({
      workspaceId: 'ws-onb-024',
      getState,
      mergeState,
    });

    const res = await patch(
      app,
      '/v1/onboarding/state',
      {
        step: 'install',
        first_ping_at: '2024-01-15T10:30:00.000Z',
      },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(200);

    const [, fragment] = mergeState.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    // started_at injected since initialState had no started_at
    expect(typeof fragment.started_at).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Audit log recorded
  // -------------------------------------------------------------------------

  it('records audit entry with action=onboarding_step_updated on success', async () => {
    const insertAuditEntry = vi.fn<InsertAuditEntryFn>(async () => undefined);
    const initialState: OnboardingState = {};
    const updatedState: OnboardingState = {
      step_meta: { validated: false },
    };

    const app = buildApp({
      workspaceId: 'ws-onb-030',
      getState: async () => initialState,
      mergeState: async () => updatedState,
      insertAuditEntry,
    });

    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'meta', validated: false },
      { auth: 'Bearer test-token' },
    );

    expect(res.status).toBe(200);
    expect(insertAuditEntry).toHaveBeenCalledOnce();
    const [auditEntry] = insertAuditEntry.mock.calls[0] as [
      Parameters<InsertAuditEntryFn>[0],
    ];
    expect(auditEntry.action).toBe('onboarding_step_updated');
    expect(auditEntry.entity_type).toBe('workspace');
    expect(auditEntry.metadata).toMatchObject({
      step: 'meta',
      workspace_id: 'ws-onb-030',
    });
  });

  it('does not fail the request when audit insert throws', async () => {
    const insertAuditEntry = vi.fn<InsertAuditEntryFn>(async () => {
      throw new Error('DB unavailable');
    });
    const initialState: OnboardingState = {};
    const updatedState: OnboardingState = { step_ga4: { validated: true } };

    const app = buildApp({
      workspaceId: 'ws-onb-031',
      getState: async () => initialState,
      mergeState: async () => updatedState,
      insertAuditEntry,
    });

    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'ga4', validated: true },
      { auth: 'Bearer some-jwt' },
    );

    // BR-AUDIT-001: audit failure must not fail the mutation
    expect(res.status).toBe(200);
    const body = await res.json<{ onboarding_state: OnboardingState }>();
    expect(body.onboarding_state).toEqual(updatedState);
  });

  // -------------------------------------------------------------------------
  // 404 — workspace not found during PATCH
  // -------------------------------------------------------------------------

  it('returns 404 when workspace not found during getState', async () => {
    const app = buildApp({
      workspaceId: 'ws-missing-patch',
      getState: async () => null,
      mergeState: async () => null,
    });

    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'meta' },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(404);
    const body = await res.json<{ code: string }>();
    expect(body.code).toBe('workspace_not_found');
  });

  // -------------------------------------------------------------------------
  // X-Request-Id on all responses
  // -------------------------------------------------------------------------

  it('returns X-Request-Id on 200', async () => {
    const app = buildApp({
      workspaceId: 'ws-onb-040',
      getState: async () => ({}),
      mergeState: async () => ({}),
    });

    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'complete' },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns X-Request-Id on 400', async () => {
    const app = buildApp({ workspaceId: 'ws-onb-041' });
    const res = await patch(
      app,
      '/v1/onboarding/state',
      { step: 'bad_value' },
      { auth: 'Bearer some-jwt' },
    );

    expect(res.status).toBe(400);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});
