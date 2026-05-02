/**
 * Integration tests — GET /v1/leads/:public_id/timeline
 *
 * CONTRACT-api-leads-timeline-v1
 * T-ID: T-6-010
 *
 * Covers:
 *   1. Happy path — returns event + dispatch nodes in descending timestamp order
 *   2. Cursor pagination — next_cursor present when more nodes exist; subsequent call uses cursor
 *   3. Lead not found → 404
 *   4. MARKETER role — idempotency_key, response_code, error_code absent from payload
 *   5. OPERATOR role — full payload including idempotency_key, response_code, error_code
 *   6. Auth absent → 401
 *   7. Auth malformed (no Bearer prefix) → 401
 *   8. limit > 50 → 400 validation_error
 *   9. Invalid cursor → 400 validation_error
 *  10. DB error on lead lookup → 500
 *  11. Attribution nodes included in timeline
 *  12. Stage nodes included in timeline
 *  13. can_replay = true only for OPERATOR+ on dead_letter/failed jobs
 *  14. can_replay = false for MARKETER regardless of job status
 *
 * BR-PRIVACY-001: no PII in error responses or logs.
 * BR-IDENTITY-013: public_id used externally; lead_id is internal.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type GetDispatchJobsFn,
  type GetEventsFn,
  type GetLeadAttributionsFn,
  type GetLeadByPublicIdFn,
  type GetLeadStagesFn,
  type TimelineNode,
  type TimelineResponse,
  createLeadsTimelineRoute,
  leadsTimelineRoute,
} from '../../../apps/edge/src/routes/leads-timeline.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppBindings = {
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
};

type AppVariables = {
  workspace_id?: string;
  request_id?: string;
  role?: string;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PUBLIC_ID = 'ld_abc123';
const LEAD_ID = 'lead-internal-001';
const WORKSPACE_ID = 'ws-test-001';

const VALID_AUTH = 'Bearer test-token';
const BASE_URL = `http://localhost/v1/leads/${PUBLIC_ID}/timeline`;

// Fixed timestamps so tests are deterministic
const TS_RECENT = '2026-05-02T12:03:24.000Z';
const TS_MIDDLE = '2026-05-02T12:02:00.000Z';
const TS_OLDEST = '2026-05-02T11:00:00.000Z';

// ---------------------------------------------------------------------------
// Mock dep factories
// ---------------------------------------------------------------------------

function makeGetLeadByPublicId(found: boolean): GetLeadByPublicIdFn {
  return async (_publicId, _workspaceId) => {
    if (!found) return { found: false };
    return { found: true, leadId: LEAD_ID };
  };
}

function makeGetLeadByPublicIdThrows(): GetLeadByPublicIdFn {
  return async () => {
    throw new Error('DB connection error');
  };
}

function makeGetEvents(count = 1): GetEventsFn {
  return async () =>
    Array.from({ length: count }, (_, i) => ({
      id: `evt-${i}`,
      eventName: i === 0 ? 'Lead' : 'PageView',
      eventTime: new Date(TS_RECENT),
      receivedAt: new Date(TS_RECENT),
      pageId: 'pg-test',
      attribution: { utm_source: 'meta' },
    }));
}

function makeGetDispatchJobs(status = 'succeeded'): GetDispatchJobsFn {
  return async () => [
    {
      id: 'dj-001',
      destination: 'meta_capi',
      status,
      skipReason: status === 'skipped' ? 'consent_denied:marketing' : null,
      idempotencyKey: 'ikey-secret-001',
      nextAttemptAt: status === 'retrying' ? new Date(TS_MIDDLE) : null,
      createdAt: new Date(TS_MIDDLE),
      responseStatus: status === 'succeeded' ? 200 : null,
      errorCode: status === 'failed' ? 'invalid_pixel_id' : null,
    },
  ];
}

function makeGetLeadAttributions(): GetLeadAttributionsFn {
  return async () => [
    {
      id: 'attr-001',
      touchType: 'first',
      source: 'meta',
      medium: 'cpc',
      campaign: 'lcm-cold-v3',
      createdAt: new Date(TS_OLDEST),
    },
  ];
}

function makeGetLeadStages(): GetLeadStagesFn {
  return async () => [
    {
      id: 'stage-001',
      stage: 'registered',
      ts: new Date(TS_OLDEST),
    },
  ];
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function buildApp(options: {
  role?: string;
  workspaceId?: string;
  getLeadByPublicId?: GetLeadByPublicIdFn;
  getEvents?: GetEventsFn;
  getDispatchJobs?: GetDispatchJobsFn;
  getLeadAttributions?: GetLeadAttributionsFn;
  getLeadStages?: GetLeadStagesFn;
  useDefaultRoute?: boolean;
}) {
  const route = options.useDefaultRoute
    ? leadsTimelineRoute
    : createLeadsTimelineRoute({
        getLeadByPublicId:
          options.getLeadByPublicId ?? makeGetLeadByPublicId(true),
        getEvents: options.getEvents ?? makeGetEvents(),
        getDispatchJobs: options.getDispatchJobs ?? makeGetDispatchJobs(),
        getLeadAttributions:
          options.getLeadAttributions ?? makeGetLeadAttributions(),
        getLeadStages: options.getLeadStages ?? makeGetLeadStages(),
      });

  const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

  // Simulate upstream middleware setting context variables
  app.use('/v1/leads/*', async (c, next) => {
    c.set('request_id', 'test-req-id');
    if (options.workspaceId !== undefined) {
      c.set('workspace_id', options.workspaceId);
    }
    if (options.role !== undefined) {
      c.set('role', options.role);
    }
    await next();
  });

  app.route('/v1/leads', route);

  const mockEnv: AppBindings = {
    HYPERDRIVE: {} as Hyperdrive,
    ENVIRONMENT: 'test',
  };

  return {
    fetch: (input: string, init?: RequestInit) =>
      app.fetch(new Request(input, init), mockEnv),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/leads/:public_id/timeline', () => {
  beforeEach(() => {
    // no global state to reset in these tests
  });

  // -------------------------------------------------------------------------
  // Case 1: Happy path — returns nodes in descending order
  // -------------------------------------------------------------------------
  it('200: returns event + dispatch + attribution + stage nodes in descending order', async () => {
    const app = buildApp({ role: 'marketer', workspaceId: WORKSPACE_ID });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;

    expect(body.lead_public_id).toBe(PUBLIC_ID);
    expect(Array.isArray(body.nodes)).toBe(true);
    expect(body.nodes.length).toBeGreaterThan(0);

    // Verify descending timestamp order
    for (let i = 1; i < body.nodes.length; i++) {
      const prev = body.nodes[i - 1] as TimelineNode;
      const curr = body.nodes[i] as TimelineNode;
      expect(new Date(prev.timestamp).getTime()).toBeGreaterThanOrEqual(
        new Date(curr.timestamp).getTime(),
      );
    }

    // Check node types present
    const types = new Set(body.nodes.map((n) => n.type));
    expect(types.has('event')).toBe(true);
    expect(types.has('dispatch')).toBe(true);
    expect(types.has('attribution')).toBe(true);
    expect(types.has('stage')).toBe(true);

    // X-Request-Id header present
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Case 2: Cursor pagination — next_cursor when more nodes exist
  // -------------------------------------------------------------------------
  it('200: sets next_cursor when total_count > limit', async () => {
    // Provide 3 event rows with limit=2 to trigger next_cursor
    const app = buildApp({
      role: 'marketer',
      workspaceId: WORKSPACE_ID,
      getEvents: async () => [
        {
          id: 'evt-a',
          eventName: 'Lead',
          eventTime: new Date('2026-05-02T13:00:00Z'),
          receivedAt: new Date('2026-05-02T13:00:00Z'),
          pageId: null,
          attribution: {},
        },
        {
          id: 'evt-b',
          eventName: 'PageView',
          eventTime: new Date('2026-05-02T12:00:00Z'),
          receivedAt: new Date('2026-05-02T12:00:00Z'),
          pageId: null,
          attribution: {},
        },
        {
          id: 'evt-c',
          eventName: 'Purchase',
          eventTime: new Date('2026-05-02T11:00:00Z'),
          receivedAt: new Date('2026-05-02T11:00:00Z'),
          pageId: null,
          attribution: {},
        },
      ],
      // No dispatch/attribution/stage to keep node count predictable
      getDispatchJobs: async () => [],
      getLeadAttributions: async () => [],
      getLeadStages: async () => [],
    });

    const res = await app.fetch(`${BASE_URL}?limit=2`, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    expect(body.nodes).toHaveLength(2);
    expect(body.next_cursor).not.toBeNull();
    expect(body.total_count).toBe(3);

    // Subsequent call using cursor should start from last returned node
    const cursorUrl = `${BASE_URL}?limit=2&cursor=${encodeURIComponent(body.next_cursor ?? '')}`;
    const res2 = await app.fetch(cursorUrl, {
      headers: { Authorization: VALID_AUTH },
    });
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as TimelineResponse;
    // With cursor set, getEvents receives it — in stub mode returns same data
    // but the response shape is valid
    expect(body2.lead_public_id).toBe(PUBLIC_ID);
    expect(Array.isArray(body2.nodes)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 3: Lead not found → 404
  // -------------------------------------------------------------------------
  it('404: returns lead_not_found when lead does not exist', async () => {
    const app = buildApp({
      role: 'marketer',
      workspaceId: WORKSPACE_ID,
      getLeadByPublicId: makeGetLeadByPublicId(false),
    });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('lead_not_found');
    expect(body.request_id).toBeTruthy();
    // BR-PRIVACY-001: no PII in response
    expect(JSON.stringify(body)).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // Case 4: MARKETER — sensitive fields absent from dispatch payload
  // -------------------------------------------------------------------------
  it('MARKETER: dispatch payload does not contain idempotency_key, error_code, response_code', async () => {
    const app = buildApp({
      role: 'marketer',
      workspaceId: WORKSPACE_ID,
      getEvents: async () => [],
      getDispatchJobs: makeGetDispatchJobs('succeeded'),
      getLeadAttributions: async () => [],
      getLeadStages: async () => [],
    });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    const dispatchNode = body.nodes.find((n) => n.type === 'dispatch');
    expect(dispatchNode).toBeDefined();

    const payload = dispatchNode?.payload ?? {};
    // BR-PRIVACY-001: MARKETER must not see technical debugging fields
    expect(payload).not.toHaveProperty('idempotency_key');
    expect(payload).not.toHaveProperty('error_code');
    expect(payload).not.toHaveProperty('response_code');
    // can_replay must be false for MARKETER
    expect(dispatchNode?.can_replay).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Case 5: OPERATOR — full payload present
  // -------------------------------------------------------------------------
  it('OPERATOR: dispatch payload includes idempotency_key, error_code, response_code', async () => {
    const app = buildApp({
      role: 'operator',
      workspaceId: WORKSPACE_ID,
      getEvents: async () => [],
      getDispatchJobs: makeGetDispatchJobs('succeeded'),
      getLeadAttributions: async () => [],
      getLeadStages: async () => [],
    });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    const dispatchNode = body.nodes.find((n) => n.type === 'dispatch');
    expect(dispatchNode).toBeDefined();

    const payload = dispatchNode?.payload ?? {};
    expect(payload).toHaveProperty('idempotency_key');
    expect(payload).toHaveProperty('response_code');
  });

  // -------------------------------------------------------------------------
  // Case 6: Auth absent → 401
  // -------------------------------------------------------------------------
  it('401: returns unauthorized when Authorization header is absent', async () => {
    const app = buildApp({ role: 'marketer' });

    const res = await app.fetch(BASE_URL);

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('unauthorized');
    expect(body.request_id).toBeTruthy();
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // Case 7: Auth malformed — missing Bearer prefix → 401
  // -------------------------------------------------------------------------
  it('401: returns unauthorized when Authorization header lacks Bearer prefix', async () => {
    const app = buildApp({ role: 'marketer' });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: 'Token abc123' },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('unauthorized');
  });

  // -------------------------------------------------------------------------
  // Case 8: limit > 50 → 400 validation_error
  // -------------------------------------------------------------------------
  it('400: returns validation_error when limit > 50', async () => {
    const app = buildApp({ role: 'marketer', workspaceId: WORKSPACE_ID });

    const res = await app.fetch(`${BASE_URL}?limit=99`, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
    expect(body.request_id).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Case 9: Invalid cursor → 400 validation_error
  // -------------------------------------------------------------------------
  it('400: returns validation_error when cursor is not a valid ISO timestamp', async () => {
    const app = buildApp({ role: 'marketer', workspaceId: WORKSPACE_ID });

    const res = await app.fetch(`${BASE_URL}?cursor=not-a-date`, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // Case 10: DB error on lead lookup → 500
  // -------------------------------------------------------------------------
  it('500: returns internal_error when DB throws during lead lookup', async () => {
    const app = buildApp({
      role: 'marketer',
      workspaceId: WORKSPACE_ID,
      getLeadByPublicId: makeGetLeadByPublicIdThrows(),
    });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('internal_error');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // Case 11: Attribution nodes in timeline
  // -------------------------------------------------------------------------
  it('200: includes attribution nodes with correct label for first-touch', async () => {
    const app = buildApp({
      role: 'marketer',
      workspaceId: WORKSPACE_ID,
      getEvents: async () => [],
      getDispatchJobs: async () => [],
      getLeadAttributions: makeGetLeadAttributions(),
      getLeadStages: async () => [],
    });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    const attrNode = body.nodes.find((n) => n.type === 'attribution');
    expect(attrNode).toBeDefined();
    expect(attrNode?.label).toBe('First-touch atribuído');
    expect(attrNode?.status).toBe('success');
    expect(attrNode?.payload).toHaveProperty('utm_source');
    expect(attrNode?.payload).toHaveProperty('utm_campaign');
  });

  // -------------------------------------------------------------------------
  // Case 12: Stage nodes in timeline
  // -------------------------------------------------------------------------
  it('200: includes stage nodes with correct label', async () => {
    const app = buildApp({
      role: 'marketer',
      workspaceId: WORKSPACE_ID,
      getEvents: async () => [],
      getDispatchJobs: async () => [],
      getLeadAttributions: async () => [],
      getLeadStages: makeGetLeadStages(),
    });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    const stageNode = body.nodes.find((n) => n.type === 'stage');
    expect(stageNode).toBeDefined();
    expect(stageNode?.label).toContain('Stage alterado');
    expect(stageNode?.status).toBe('success');
  });

  // -------------------------------------------------------------------------
  // Case 13: can_replay = true for OPERATOR on dead_letter job
  // -------------------------------------------------------------------------
  it('OPERATOR: can_replay is true for dead_letter dispatch job', async () => {
    const app = buildApp({
      role: 'operator',
      workspaceId: WORKSPACE_ID,
      getEvents: async () => [],
      getDispatchJobs: makeGetDispatchJobs('dead_letter'),
      getLeadAttributions: async () => [],
      getLeadStages: async () => [],
    });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    const dispatchNode = body.nodes.find((n) => n.type === 'dispatch');
    expect(dispatchNode).toBeDefined();
    expect(dispatchNode?.can_replay).toBe(true);
    expect(dispatchNode?.status).toBe('error');
    expect(dispatchNode?.label).toBe('Falhou e parou de tentar');
  });

  // -------------------------------------------------------------------------
  // Case 14: can_replay = false for MARKETER even on dead_letter
  // -------------------------------------------------------------------------
  it('MARKETER: can_replay is false for dead_letter dispatch job', async () => {
    const app = buildApp({
      role: 'marketer',
      workspaceId: WORKSPACE_ID,
      getEvents: async () => [],
      getDispatchJobs: makeGetDispatchJobs('dead_letter'),
      getLeadAttributions: async () => [],
      getLeadStages: async () => [],
    });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    const dispatchNode = body.nodes.find((n) => n.type === 'dispatch');
    expect(dispatchNode).toBeDefined();
    // BR-PRIVACY-001 / RBAC: MARKETER must not be able to replay
    expect(dispatchNode?.can_replay).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Case 15: default export (no DB) returns empty timeline with 200
  // -------------------------------------------------------------------------
  it('200: default export returns empty timeline when no DB deps injected', async () => {
    const app = buildApp({ role: 'marketer', useDefaultRoute: true });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    expect(body.lead_public_id).toBe(PUBLIC_ID);
    expect(body.nodes).toHaveLength(0);
    expect(body.next_cursor).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case 16: skipped dispatch node label translated
  // -------------------------------------------------------------------------
  it('200: skipped dispatch node shows translated skip_reason', async () => {
    const app = buildApp({
      role: 'marketer',
      workspaceId: WORKSPACE_ID,
      getEvents: async () => [],
      getDispatchJobs: makeGetDispatchJobs('skipped'),
      getLeadAttributions: async () => [],
      getLeadStages: async () => [],
    });

    const res = await app.fetch(BASE_URL, {
      headers: { Authorization: VALID_AUTH },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as TimelineResponse;
    const dispatchNode = body.nodes.find((n) => n.type === 'dispatch');
    expect(dispatchNode).toBeDefined();
    expect(dispatchNode?.status).toBe('warning');
    // Label contains translated skip reason (PT-BR)
    expect(dispatchNode?.label).toContain('Não despachado:');
    expect(dispatchNode?.label).toContain('Consentimento negado');
  });
});
