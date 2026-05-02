/**
 * Integration tests — DELETE /v1/admin/leads/:lead_id
 *
 * Covers:
 *   401 — missing Authorization header
 *   401 — empty / malformed Authorization header
 *   403 — X-Confirm-Erase header absent or not "true"
 *   400 — lead_id path param is not a valid UUID
 *   202 — happy path (job enqueued, queue.send called)
 *   404 — lead not found in DB (when DB stub returns { found: false })
 *   409 — lead already erased (BR-PRIVACY-003 idempotency)
 *
 * CONTRACT-api-admin-leads-erase-v1
 * BR-PRIVACY-001: zero PII in logs and error responses.
 * BR-AUDIT-001:   audit entry created on success.
 * BR-PRIVACY-003: 409 when lead is already erased.
 * BR-RBAC-005:    double-confirm header required.
 *
 * Uses a real Hono app with injected mock dependencies.
 * Bindings are injected via app.fetch(req, env) — the Cloudflare Workers pattern.
 * No external DB or Cloudflare runtime required — runs under vitest/node.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  type GetLeadStatusFn,
  type InsertAuditEntryFn,
  createAdminLeadsEraseRoute,
} from '../admin/leads-erase.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Bindings shape matching apps/edge/src/index.ts. */
interface MockBindings {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
}

/** Variables shape matching apps/edge/src/index.ts. */
interface MockVariables {
  workspace_id: string;
  page_id: string;
  request_id: string;
}

type MockEnv = { Bindings: MockBindings; Variables: MockVariables };

// ---------------------------------------------------------------------------
// Minimal mock Queue (replaces the Cloudflare Queue type in tests)
// ---------------------------------------------------------------------------

function createMockQueue() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

interface BuildAppOpts {
  queue?: Queue;
  db?: Fetcher;
  getLeadStatus?: GetLeadStatusFn;
  insertAuditEntry?: InsertAuditEntryFn;
  requestId?: string;
}

/**
 * Build a Hono test app + mock env that can be invoked via app.fetch(req, env).
 * Returns an object with a `fetch` helper that injects the mock env.
 */
function buildApp(opts: BuildAppOpts = {}) {
  const queue = opts.queue ?? createMockQueue();

  const mockEnv: MockBindings = {
    // KV namespace not needed for this route — cast as unknown
    GT_KV: {} as unknown as KVNamespace,
    QUEUE_EVENTS: {} as unknown as Queue,
    QUEUE_DISPATCH: queue,
    ENVIRONMENT: 'test',
    ...(opts.db !== undefined ? { DB: opts.db } : {}),
  };

  const eraseRoute = createAdminLeadsEraseRoute({
    getLeadStatus: opts.getLeadStatus,
    insertAuditEntry: opts.insertAuditEntry,
  });

  const app = new Hono<MockEnv>();

  // Inject request_id via middleware (normally done by sanitize-logs globally)
  app.use('*', async (c, next) => {
    c.set('request_id', opts.requestId ?? 'test-request-id-001');
    await next();
  });

  app.route('/v1/admin/leads', eraseRoute);

  return {
    /** Invoke the app with mock bindings injected as env. */
    fetch: (url: string, init?: RequestInit) => {
      const req = new Request(url, init);
      return app.fetch(req, mockEnv);
    },
    queue,
    mockEnv,
  };
}

/** Valid UUID for use as lead_id in tests. */
const VALID_LEAD_ID = '550e8400-e29b-41d4-a716-446655440000';

/** Valid Authorization header value. */
const VALID_AUTH = 'Bearer test-api-key-sprint1';

/** Base URL for constructing requests. */
const BASE = 'http://localhost';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DELETE /v1/admin/leads/:lead_id', () => {
  // -------------------------------------------------------------------------
  // 401 — missing Authorization header
  // -------------------------------------------------------------------------
  it('returns 401 when Authorization header is absent', async () => {
    const { fetch: testFetch } = buildApp();

    const res = await testFetch(`${BASE}/v1/admin/leads/${VALID_LEAD_ID}`, {
      method: 'DELETE',
      headers: {
        'X-Confirm-Erase': 'true',
      },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unauthorized');
    // X-Request-Id must always be present
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    // BR-PRIVACY-001: no PII in response
    expect(JSON.stringify(body)).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // 401 — Authorization header present but empty after "Bearer "
  // -------------------------------------------------------------------------
  it('returns 401 when Authorization header has empty Bearer value', async () => {
    const { fetch: testFetch } = buildApp();

    const res = await testFetch(`${BASE}/v1/admin/leads/${VALID_LEAD_ID}`, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer   ',
        'X-Confirm-Erase': 'true',
      },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unauthorized');
  });

  // -------------------------------------------------------------------------
  // 403 — X-Confirm-Erase header absent
  //        BR-RBAC-005: double-confirm required
  // -------------------------------------------------------------------------
  it('returns 403 when X-Confirm-Erase header is absent', async () => {
    const { fetch: testFetch } = buildApp();

    const res = await testFetch(`${BASE}/v1/admin/leads/${VALID_LEAD_ID}`, {
      method: 'DELETE',
      headers: {
        Authorization: VALID_AUTH,
        // X-Confirm-Erase intentionally omitted
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('missing_confirm_erase_header');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    // BR-PRIVACY-001: no PII in response
    expect(JSON.stringify(body)).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // 403 — X-Confirm-Erase header present but wrong value
  //        BR-RBAC-005: must be exactly "true"
  // -------------------------------------------------------------------------
  it('returns 403 when X-Confirm-Erase is not exactly "true"', async () => {
    const { fetch: testFetch } = buildApp();

    for (const badValue of ['yes', 'TRUE', '1', 'confirm', '']) {
      const res = await testFetch(`${BASE}/v1/admin/leads/${VALID_LEAD_ID}`, {
        method: 'DELETE',
        headers: {
          Authorization: VALID_AUTH,
          'X-Confirm-Erase': badValue,
        },
      });

      expect(
        res.status,
        `expected 403 for X-Confirm-Erase: "${badValue}"`,
      ).toBe(403);
    }
  });

  // -------------------------------------------------------------------------
  // 400 — lead_id is not a valid UUID
  // -------------------------------------------------------------------------
  it('returns 400 when lead_id is not a valid UUID', async () => {
    const { fetch: testFetch } = buildApp();

    const res = await testFetch(`${BASE}/v1/admin/leads/not-a-uuid`, {
      method: 'DELETE',
      headers: {
        Authorization: VALID_AUTH,
        'X-Confirm-Erase': 'true',
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('validation_error');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 400 — lead_id is a numeric string (not UUID)
  // -------------------------------------------------------------------------
  it('returns 400 when lead_id is a numeric string', async () => {
    const { fetch: testFetch } = buildApp();

    const res = await testFetch(`${BASE}/v1/admin/leads/12345`, {
      method: 'DELETE',
      headers: {
        Authorization: VALID_AUTH,
        'X-Confirm-Erase': 'true',
      },
    });

    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 202 — happy path (no DB stubs — optimistic accept)
  //        Verifies: job_id in response, status 'queued', queue.send called
  // -------------------------------------------------------------------------
  it('returns 202 with job_id and status "queued" — queue.send is called', async () => {
    const mockQueueRaw = createMockQueue();
    const { fetch: testFetch } = buildApp({ queue: mockQueueRaw });

    const res = await testFetch(`${BASE}/v1/admin/leads/${VALID_LEAD_ID}`, {
      method: 'DELETE',
      headers: {
        Authorization: VALID_AUTH,
        'X-Confirm-Erase': 'true',
      },
    });

    expect(res.status).toBe(202);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('queued');
    expect(typeof body.job_id).toBe('string');
    // job_id must be a UUID
    expect(body.job_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Queue send must have been called once
    // We rely on the mock installed by createMockQueue() being the same ref
    const mockSend = (
      mockQueueRaw as unknown as { send: ReturnType<typeof vi.fn> }
    ).send;
    expect(mockSend).toHaveBeenCalledOnce();
    const sentPayload = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sentPayload.type).toBe('lead_erase');
    expect(sentPayload.lead_id).toBe(VALID_LEAD_ID);
    expect(sentPayload.job_id).toBe(body.job_id);

    // X-Request-Id must be present
    expect(res.headers.get('X-Request-Id')).toBeTruthy();

    // BR-PRIVACY-001: response must not contain PII patterns
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // 202 — audit entry is created on success
  //        BR-AUDIT-001: every admin operation must generate an audit entry
  // -------------------------------------------------------------------------
  it('BR-AUDIT-001: insertAuditEntry is called on successful erase request', async () => {
    const mockAudit = vi.fn().mockResolvedValue(undefined);

    const { fetch: testFetch } = buildApp({ insertAuditEntry: mockAudit });

    const res = await testFetch(`${BASE}/v1/admin/leads/${VALID_LEAD_ID}`, {
      method: 'DELETE',
      headers: {
        Authorization: VALID_AUTH,
        'X-Confirm-Erase': 'true',
      },
    });

    expect(res.status).toBe(202);

    // Audit insert must be called
    expect(mockAudit).toHaveBeenCalledOnce();
    const auditCall = mockAudit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(auditCall.action).toBe('lead_erase_queued');
    expect(auditCall.actor_type).toBe('api_key');
    expect(auditCall.entity_type).toBe('lead');
    expect(auditCall.entity_id).toBe(VALID_LEAD_ID);
    // BR-PRIVACY-001: no PII in metadata — lead_id is opaque UUID
    const metadataStr = JSON.stringify(auditCall.metadata);
    expect(metadataStr).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // 409 — lead already erased (BR-PRIVACY-003 idempotency)
  // -------------------------------------------------------------------------
  it('returns 409 when lead is already erased — BR-PRIVACY-003', async () => {
    const mockQueueRaw = createMockQueue();

    // DB stub: lead exists and is already erased
    const getLeadStatus: GetLeadStatusFn = async (_leadId) => ({
      found: true,
      status: 'erased',
    });

    // Provide a truthy DB so the status check branch is entered in the handler
    const { fetch: testFetch } = buildApp({
      queue: mockQueueRaw,
      getLeadStatus,
      insertAuditEntry: vi.fn(),
      db: {} as unknown as Fetcher,
    });

    const res = await testFetch(`${BASE}/v1/admin/leads/${VALID_LEAD_ID}`, {
      method: 'DELETE',
      headers: {
        Authorization: VALID_AUTH,
        'X-Confirm-Erase': 'true',
      },
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('already_erased');
    // Queue must NOT have been called
    const mockSend = (
      mockQueueRaw as unknown as { send: ReturnType<typeof vi.fn> }
    ).send;
    expect(mockSend).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 404 — lead not found in DB
  // -------------------------------------------------------------------------
  it('returns 404 when lead is not found in DB', async () => {
    const mockQueueRaw = createMockQueue();

    const getLeadStatus: GetLeadStatusFn = async (_leadId) => ({
      found: false,
    });

    const { fetch: testFetch } = buildApp({
      queue: mockQueueRaw,
      getLeadStatus,
      insertAuditEntry: vi.fn(),
      db: {} as unknown as Fetcher,
    });

    const res = await testFetch(`${BASE}/v1/admin/leads/${VALID_LEAD_ID}`, {
      method: 'DELETE',
      headers: {
        Authorization: VALID_AUTH,
        'X-Confirm-Erase': 'true',
      },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('lead_not_found');
    // Queue must NOT have been called
    const mockSend = (
      mockQueueRaw as unknown as { send: ReturnType<typeof vi.fn> }
    ).send;
    expect(mockSend).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001 — error responses never contain PII
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: error responses never contain PII patterns', async () => {
    const errorCases: Array<{ headers: Record<string, string> }> = [
      // 401 — no auth
      { headers: { 'X-Confirm-Erase': 'true' } },
      // 403 — no confirm
      { headers: { Authorization: VALID_AUTH } },
    ];

    for (const { headers } of errorCases) {
      const { fetch: testFetch } = buildApp();
      const res = await testFetch(`${BASE}/v1/admin/leads/${VALID_LEAD_ID}`, {
        method: 'DELETE',
        headers,
      });

      const text = await res.text();
      // No email pattern
      expect(text).not.toMatch(/@[a-zA-Z]/);
      // No raw API key in response
      expect(text).not.toContain('test-api-key-sprint1');
      // No IP pattern
      expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    }
  });

  // -------------------------------------------------------------------------
  // X-Request-Id always present in responses
  // -------------------------------------------------------------------------
  it('always includes X-Request-Id header in responses', async () => {
    const { fetch: testFetch } = buildApp();

    const errorRes = await testFetch(
      `${BASE}/v1/admin/leads/${VALID_LEAD_ID}`,
      {
        method: 'DELETE',
        // No headers — should 401
      },
    );

    expect(errorRes.headers.get('X-Request-Id')).toBeTruthy();
  });
});
