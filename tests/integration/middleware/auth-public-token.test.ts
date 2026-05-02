/**
 * Integration tests — auth-public-token middleware
 *
 * Covers:
 *   INV-PAGE-007 — token binds request to an isolated workspace
 *   INV-PAGE-005 — revoked token returns 401
 *   Happy path    — active token sets workspace_id + page_id in context
 *   401 cases     — missing token, unknown token hash
 *   403 is NOT expected here (that is origin/CORS — tested in cors.test.ts)
 *
 * BR-PRIVACY-001 — zero PII in error response bodies and logs
 *
 * Uses a real Hono app with an injected mock DB lookup function.
 * No external DB required — tests run with vitest in node environment.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type LookupPageTokenFn,
  type PageTokenRow,
  authPublicToken,
} from '../../../apps/edge/src/middleware/auth-public-token.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex of a string — mirrors middleware internal logic. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Build a minimal Hono app with the middleware + a probe handler. */
function buildApp(lookup: LookupPageTokenFn) {
  const app = new Hono();
  app.use('/v1/*', authPublicToken(lookup));
  app.get('/v1/probe', (c) => {
    return c.json({
      workspace_id: c.get('workspace_id'),
      page_id: c.get('page_id'),
    });
  });
  return app;
}

const ACTIVE_ROW: PageTokenRow = {
  workspaceId: 'ws-aaa-111',
  pageId: 'pg-bbb-222',
  status: 'active',
};

const ROTATING_ROW: PageTokenRow = {
  workspaceId: 'ws-aaa-111',
  pageId: 'pg-bbb-222',
  status: 'rotating',
};

const REVOKED_ROW: PageTokenRow = {
  workspaceId: 'ws-aaa-111',
  pageId: 'pg-bbb-222',
  status: 'revoked',
};

const CLEAR_TOKEN = 'pk_live_test_secret_token_abc123';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth-public-token middleware', () => {
  // -------------------------------------------------------------------------
  // 401 — missing token
  // -------------------------------------------------------------------------
  it('returns 401 when no token header is provided', async () => {
    const lookup: LookupPageTokenFn = async () => null;
    const app = buildApp(lookup);

    const res = await app.request('/v1/probe', { method: 'GET' });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('missing_token');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/@/);
  });

  // -------------------------------------------------------------------------
  // 401 — token present but not found in DB (unknown hash)
  // -------------------------------------------------------------------------
  it('returns 401 when token hash is not in DB', async () => {
    const lookup: LookupPageTokenFn = async () => null;
    const app = buildApp(lookup);

    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { 'X-Funil-Site': 'pk_live_unknown_token' },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('invalid_token');
    // BR-PRIVACY-001: raw token must NOT appear in response
    expect(JSON.stringify(body)).not.toContain('pk_live_unknown_token');
  });

  // -------------------------------------------------------------------------
  // 401 — revoked token (INV-PAGE-005)
  // -------------------------------------------------------------------------
  it('returns 401 for a revoked token — INV-PAGE-005', async () => {
    const tokenHash = await sha256Hex(CLEAR_TOKEN);
    const lookup: LookupPageTokenFn = async (hash) =>
      hash === tokenHash ? REVOKED_ROW : null;
    const app = buildApp(lookup);

    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { 'X-Funil-Site': CLEAR_TOKEN },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('invalid_token');
    // INV-PAGE-005: revoked, not 403
    expect(res.status).not.toBe(403);
  });

  // -------------------------------------------------------------------------
  // 200 — active token sets workspace_id + page_id (INV-PAGE-007)
  // -------------------------------------------------------------------------
  it('populates workspace_id and page_id for active token — INV-PAGE-007', async () => {
    const tokenHash = await sha256Hex(CLEAR_TOKEN);
    const lookup: LookupPageTokenFn = async (hash) =>
      hash === tokenHash ? ACTIVE_ROW : null;
    const app = buildApp(lookup);

    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { 'X-Funil-Site': CLEAR_TOKEN },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // INV-PAGE-007: token binds request to workspace — workspace_id must match token's workspace
    expect(body.workspace_id).toBe(ACTIVE_ROW.workspaceId);
    expect(body.page_id).toBe(ACTIVE_ROW.pageId);
  });

  // -------------------------------------------------------------------------
  // 200 — rotating token also authenticates
  // -------------------------------------------------------------------------
  it('allows rotating token to authenticate (overlap window)', async () => {
    const tokenHash = await sha256Hex(CLEAR_TOKEN);
    const lookup: LookupPageTokenFn = async (hash) =>
      hash === tokenHash ? ROTATING_ROW : null;
    const app = buildApp(lookup);

    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { 'X-Funil-Site': CLEAR_TOKEN },
    });

    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // INV-PAGE-007 — different tokens → different workspaces (isolation)
  // -------------------------------------------------------------------------
  it('INV-PAGE-007: two tokens bind to different workspaces — no cross-workspace access', async () => {
    const token1 = 'pk_live_workspace_one';
    const token2 = 'pk_live_workspace_two';
    const hash1 = await sha256Hex(token1);
    const hash2 = await sha256Hex(token2);

    const rows: Record<string, PageTokenRow> = {
      [hash1]: { workspaceId: 'ws-one', pageId: 'pg-one', status: 'active' },
      [hash2]: { workspaceId: 'ws-two', pageId: 'pg-two', status: 'active' },
    };
    const lookup: LookupPageTokenFn = async (hash) => rows[hash] ?? null;
    const app = buildApp(lookup);

    const res1 = await app.request('/v1/probe', {
      method: 'GET',
      headers: { 'X-Funil-Site': token1 },
    });
    const res2 = await app.request('/v1/probe', {
      method: 'GET',
      headers: { 'X-Funil-Site': token2 },
    });

    const body1 = (await res1.json()) as Record<string, unknown>;
    const body2 = (await res2.json()) as Record<string, unknown>;

    expect(body1.workspace_id).toBe('ws-one');
    expect(body2.workspace_id).toBe('ws-two');
    // Workspaces must be isolated
    expect(body1.workspace_id).not.toBe(body2.workspace_id);
  });

  // -------------------------------------------------------------------------
  // Authorization header (Bearer scheme) also accepted
  // -------------------------------------------------------------------------
  it('accepts token via Authorization: Bearer header', async () => {
    const tokenHash = await sha256Hex(CLEAR_TOKEN);
    const lookup: LookupPageTokenFn = async (hash) =>
      hash === tokenHash ? ACTIVE_ROW : null;
    const app = buildApp(lookup);

    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { Authorization: `Bearer ${CLEAR_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspace_id).toBe(ACTIVE_ROW.workspaceId);
  });

  // -------------------------------------------------------------------------
  // X-Request-Id present in error responses
  // -------------------------------------------------------------------------
  it('includes X-Request-Id header in 401 response', async () => {
    const lookup: LookupPageTokenFn = async () => null;
    const app = buildApp(lookup);

    const res = await app.request('/v1/probe', { method: 'GET' });
    expect(res.status).toBe(401);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001 — error response body contains no PII patterns
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: 401 body never contains raw token, email, or IP', async () => {
    const lookup: LookupPageTokenFn = async () => null;
    const app = buildApp(lookup);

    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: {
        'X-Funil-Site': 'pk_live_test_secret',
        'CF-Connecting-IP': '192.168.1.1',
      },
    });

    const body = await res.text();
    expect(body).not.toContain('pk_live_test_secret');
    expect(body).not.toContain('192.168.1.1');
    expect(body).not.toMatch(/@[a-zA-Z]/); // no email pattern
  });

  // -------------------------------------------------------------------------
  // DB error → 500 (not 401/403) — prevents info leakage
  // -------------------------------------------------------------------------
  it('returns 500 on DB lookup failure without leaking details', async () => {
    const lookup: LookupPageTokenFn = async () => {
      throw new Error('DB connection refused');
    };
    const app = buildApp(lookup);

    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { 'X-Funil-Site': CLEAR_TOKEN },
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('internal_error');
    // DB error message must not leak to caller
    expect(JSON.stringify(body)).not.toContain('connection refused');
  });
});
