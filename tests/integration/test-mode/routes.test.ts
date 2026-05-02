/**
 * Integration tests — workspace-test-mode routes
 *
 * T-ID: T-8-006
 *
 * Covers:
 *   POST /test-mode with enabled=true  → 200 + active status
 *   POST /test-mode without Authorization → 401
 *   POST /test-mode with invalid body  → 400
 *   GET  /test-mode when inactive      → 200 + { enabled: false }
 *
 * Uses a real Hono app wired via createWorkspaceTestModeRoute() with injected
 * KV mock. No real DB or KV required — follows the same mock pattern as
 * auth-public-token.test.ts.
 *
 * BR-AUDIT-001: POST must call insertAuditEntry (verified via spy)
 * BR-RBAC-002:  workspace_id is the multi-tenant anchor (injected via context variable)
 * BR-PRIVACY-001: zero PII in error responses
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  type InsertAuditEntryFn,
  createWorkspaceTestModeRoute,
} from '../../../apps/edge/src/routes/workspace-test-mode.js';

// ---------------------------------------------------------------------------
// KV mock factory
// ---------------------------------------------------------------------------

function makeKvMock(getReturnValue: string | null = null): KVNamespace {
  return {
    get: vi.fn().mockResolvedValue(getReturnValue),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-test-integration-aaaa';

/**
 * Build a Hono app that mounts the workspace-test-mode route under /v1/workspace,
 * with workspace_id injected as a context variable (simulating auth middleware).
 */
function buildApp(
  kv: KVNamespace,
  insertAuditEntry?: InsertAuditEntryFn,
): Hono {
  const app = new Hono<{
    Bindings: { GT_KV: KVNamespace; HYPERDRIVE: unknown; ENVIRONMENT: string };
    Variables: { workspace_id: string; request_id: string };
  }>();

  // Simulate auth middleware setting workspace_id and request_id
  app.use('*', async (c, next) => {
    c.set('workspace_id', WORKSPACE_ID);
    c.set('request_id', 'req-test-001');
    await next();
  });

  // Inject KV binding
  app.use('*', async (c, next) => {
    // @ts-expect-error -- directly patching env for test purposes
    c.env = { GT_KV: kv, ENVIRONMENT: 'test' };
    await next();
  });

  const route = createWorkspaceTestModeRoute({ insertAuditEntry });
  app.route('/v1/workspace', route);

  return app as unknown as Hono;
}

// ---------------------------------------------------------------------------
// Tests — POST /v1/workspace/test-mode
// ---------------------------------------------------------------------------

describe('POST /v1/workspace/test-mode', () => {
  it('returns 200 with active status when enabled=true', async () => {
    const kv = makeKvMock();
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-abc-123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(typeof body.expires_at).toBe('string');
    expect(body.ttl_seconds).toBe(3600);
    // expires_at must be a valid ISO string
    const expiresAt = new Date(body.expires_at as string);
    expect(Number.isNaN(expiresAt.getTime())).toBe(false);
  });

  it('returns 200 with inactive status when enabled=false', async () => {
    const kv = makeKvMock();
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-abc-123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.expires_at).toBeNull();
    expect(body.ttl_seconds).toBeNull();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const kv = makeKvMock();
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(401);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('unauthorized');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/@/);
  });

  it('returns 401 when Authorization header has no Bearer token', async () => {
    const kv = makeKvMock();
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(401);
  });

  it('returns 400 when body is missing "enabled" field', async () => {
    const kv = makeKvMock();
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-abc-123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: 1800 }), // missing required 'enabled'
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  it('returns 400 when body has unknown keys (strict schema)', async () => {
    const kv = makeKvMock();
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-abc-123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true, unknown_field: 'should_fail' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 when body is invalid JSON', async () => {
    const kv = makeKvMock();
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-abc-123',
        'Content-Type': 'application/json',
      },
      body: 'not_valid_json{{{',
    });

    expect(res.status).toBe(400);
  });

  it('BR-AUDIT-001: calls insertAuditEntry on successful toggle', async () => {
    const kv = makeKvMock();
    const insertAuditEntry: InsertAuditEntryFn = vi.fn().mockResolvedValue(undefined);
    const app = buildApp(kv, insertAuditEntry);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-abc-123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);
    expect(insertAuditEntry).toHaveBeenCalledOnce();

    const auditCall = (insertAuditEntry as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(auditCall.action).toBe('toggle_test_mode');
    expect(auditCall.workspace_id).toBe(WORKSPACE_ID);
    expect(auditCall.entity_type).toBe('workspace');
  });

  it('includes X-Request-Id header in response', async () => {
    const kv = makeKvMock();
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer token-abc-123',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Tests — GET /v1/workspace/test-mode
// ---------------------------------------------------------------------------

describe('GET /v1/workspace/test-mode', () => {
  it('returns 200 with enabled=false when KV is empty (inactive)', async () => {
    const kv = makeKvMock(null); // KV returns null → inactive
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-abc-123' },
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.expires_at).toBeNull();
    expect(body.ttl_seconds).toBeNull();
  });

  it('returns 200 with enabled=true when KV has active record', async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 3600 * 1000);
    const record = JSON.stringify({
      activatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    const kv = makeKvMock(record);
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-abc-123' },
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(true);
    expect(typeof body.expires_at).toBe('string');
    expect(body.ttl_seconds).toBeGreaterThan(0);
  });

  it('returns 401 when Authorization header is missing', async () => {
    const kv = makeKvMock(null);
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'GET',
    });

    expect(res.status).toBe(401);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('unauthorized');
  });

  it('includes X-Request-Id header in response', async () => {
    const kv = makeKvMock(null);
    const app = buildApp(kv);

    const res = await app.request('/v1/workspace/test-mode', {
      method: 'GET',
      headers: { Authorization: 'Bearer token-abc-123' },
    });

    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});
