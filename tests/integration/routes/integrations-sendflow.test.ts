/**
 * Integration tests — GET/PATCH /v1/integrations/sendflow/credentials
 *
 * T-ID: T-13-016b (Sprint 13)
 * CONTRACT: docs/30-contracts/05-api-server-actions.md
 *
 * Test cases:
 *   GET 401 — missing Bearer
 *   GET 200 — workspace with no sendtok stored → has_sendtok=false
 *   GET 200 — workspace with sendtok → masked (prefix + length only); raw NEVER in body
 *   PATCH 401 — missing Bearer
 *   PATCH 400 — empty sendtok
 *   PATCH 400 — sendtok shorter than 16 chars
 *   PATCH 400 — sendtok longer than 200 chars
 *   PATCH 400 — extra field (.strict())
 *   PATCH 400 — invalid JSON body
 *   PATCH 200 — successful upsert (insert path); audit captured;
 *               raw token NEVER in audit metadata or response
 *   PATCH 200 — successful upsert called twice (insert then update); both 200
 *
 * BR-PRIVACY-001: response and audit metadata NEVER contain the raw token —
 *   only `prefix` (first 4 chars) + `length`.
 * BR-AUDIT-001: PATCH writes audit_log action='workspace_sendflow_sendtok_updated'.
 * BR-RBAC-002: workspace_id from auth context — never from body.
 * INV-WI-001: upsert by unique workspace_id.
 *
 * Approach: real Hono app, injected fake DB (in-memory store) and fake
 * insertAuditEntry. No external Postgres or Cloudflare runtime required.
 *
 * NOTE on @globaltracker/db: mocked module-level (mirrors pattern from
 *   tests/integration/audience/*.test.ts). The test only depends on the
 *   route's injected `getDb` + `insertAuditEntry`, so the schema refs need
 *   not be real Drizzle objects.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

// Mock @globaltracker/db (root tests/ dir does not have workspace symlink to
// packages/db; mirrors pattern from tests/integration/audience/*.test.ts).
vi.mock('@globaltracker/db', () => ({
  workspaceIntegrations: { __mockTag: 'workspace_integrations' },
  auditLog: { __mockTag: 'audit_log' },
  createDb: vi.fn(),
}));

import {
  type InsertAuditEntryFn,
  createIntegrationsSendflowRoute,
} from '../../../apps/edge/src/routes/integrations-sendflow.js';

// ---------------------------------------------------------------------------
// In-memory fake DB
// ---------------------------------------------------------------------------

type FakeRow = {
  workspaceId: string;
  sendflowSendtok: string | null;
};

interface FakeDbState {
  integrations: Map<string, FakeRow>;
  // Route filters by workspace_id from auth context. The test sets this
  // before issuing requests — the fake .where() ignores its argument and
  // uses this value as the lookup key.
  pendingWorkspaceId: string | null;
}

function createFakeDb(state: FakeDbState) {
  function makeSelectChain() {
    return {
      from(_table: unknown) {
        return {
          where(_cond: unknown) {
            return {
              async limit(_n: number) {
                const wsId = state.pendingWorkspaceId;
                if (wsId === null) return [];
                const row = state.integrations.get(wsId);
                if (!row) return [];
                return [{ sendflowSendtok: row.sendflowSendtok }];
              },
            };
          },
        };
      },
    };
  }

  return {
    select(_cols: unknown) {
      return makeSelectChain();
    },
    insert(_table: unknown) {
      return {
        values(input: unknown) {
          const insertValues = input as {
            workspaceId: string;
            sendflowSendtok: string | null;
          };
          return {
            async onConflictDoUpdate(opts: {
              target: unknown;
              set: { sendflowSendtok: string | null; updatedAt: unknown };
            }) {
              const existing = state.integrations.get(insertValues.workspaceId);
              if (existing) {
                existing.sendflowSendtok = opts.set.sendflowSendtok;
              } else {
                state.integrations.set(insertValues.workspaceId, {
                  workspaceId: insertValues.workspaceId,
                  sendflowSendtok: insertValues.sendflowSendtok,
                });
              }
            },
          };
        },
      };
    },
  } as unknown;
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-test-sendflow-aaa';
const ACTOR_TOKEN = WORKSPACE_ID; // dev fallback: workspace_id = bearer token

const REAL_TOKEN = 'ADF590B72BCFCB64E98982B73C9ECB613A30DC5EC9'; // 42 chars

function buildApp(initialIntegrations?: Iterable<[string, FakeRow]>) {
  const state: FakeDbState = {
    integrations: new Map(initialIntegrations ?? []),
    pendingWorkspaceId: WORKSPACE_ID,
  };

  const auditCalls: Parameters<InsertAuditEntryFn>[0][] = [];
  const insertAuditEntry: InsertAuditEntryFn = async (entry) => {
    auditCalls.push(entry);
  };

  const route = createIntegrationsSendflowRoute({
    getDb: () => createFakeDb(state) as never,
    insertAuditEntry,
  });

  const app = new Hono();

  // Simulate auth middleware: inject workspace_id into context so the route
  // does not fall back to c.env.DEV_WORKSPACE_ID (env is undefined when
  // app.request() is called without explicit env). BR-RBAC-002.
  app.use('*', async (c, next) => {
    c.set('workspace_id', WORKSPACE_ID);
    c.set('request_id', 'req-int-sendflow-001');
    await next();
  });

  app.route('/v1/integrations/sendflow', route);

  return { app, state, auditCalls };
}

function makeRequest(
  app: Hono,
  method: 'GET' | 'PATCH',
  options: {
    body?: unknown;
    bodyText?: string;
    authHeader?: string | null;
  } = {},
) {
  const { body, bodyText, authHeader = `Bearer ${ACTOR_TOKEN}` } = options;
  const headers: Record<string, string> = {};
  if (authHeader !== null) headers.Authorization = authHeader;

  const init: RequestInit = { method, headers };
  if (method === 'PATCH') {
    headers['Content-Type'] = 'application/json';
    if (bodyText !== undefined) {
      init.body = bodyText;
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
  }

  return app.request('/v1/integrations/sendflow/credentials', init);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/integrations/sendflow/credentials', () => {
  it('401 when Authorization header is missing', async () => {
    const { app } = buildApp();
    const res = await makeRequest(app, 'GET', { authHeader: null });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('unauthorized');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('200 with has_sendtok=false when workspace has no sendtok stored', async () => {
    const { app } = buildApp();
    const res = await makeRequest(app, 'GET');

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.has_sendtok).toBe(false);
    expect(body.prefix).toBeNull();
    expect(body.length).toBeNull();
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('200 with masked sendtok (prefix + length); response NEVER contains raw token', async () => {
    const { app } = buildApp([
      [
        WORKSPACE_ID,
        { workspaceId: WORKSPACE_ID, sendflowSendtok: REAL_TOKEN },
      ],
    ]);

    const res = await makeRequest(app, 'GET');

    expect(res.status).toBe(200);
    const text = await res.text();

    // BR-PRIVACY-001: raw token MUST NOT appear in the response body.
    expect(text).not.toContain('B72BCFCB');
    expect(text).not.toContain('ECB613');
    expect(text).not.toContain(REAL_TOKEN);

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.has_sendtok).toBe(true);
    expect(body.prefix).toBe('ADF5');
    expect(body.length).toBe(42);
  });
});

describe('PATCH /v1/integrations/sendflow/credentials', () => {
  it('401 when Authorization header is missing', async () => {
    const { app } = buildApp();
    const res = await makeRequest(app, 'PATCH', {
      authHeader: null,
      body: { sendtok: REAL_TOKEN },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('unauthorized');
  });

  it('400 when sendtok is empty string', async () => {
    const { app } = buildApp();
    const res = await makeRequest(app, 'PATCH', { body: { sendtok: '' } });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  it('400 when sendtok is shorter than 16 chars', async () => {
    const { app } = buildApp();
    const res = await makeRequest(app, 'PATCH', {
      body: { sendtok: 'short-token-12' }, // 14 chars
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  it('400 when sendtok exceeds 200 chars', async () => {
    const { app } = buildApp();
    const res = await makeRequest(app, 'PATCH', {
      body: { sendtok: 'a'.repeat(201) },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  it('400 when body has unknown extra fields (strict)', async () => {
    const { app } = buildApp();
    const res = await makeRequest(app, 'PATCH', {
      body: { sendtok: REAL_TOKEN, foo: 'bar' },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  it('400 when body is not valid JSON', async () => {
    const { app } = buildApp();
    const res = await makeRequest(app, 'PATCH', { bodyText: 'not-json{' });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  it('200 on first PATCH (insert path); upserts DB; audit captured; raw token NEVER in audit metadata or response', async () => {
    const { app, state, auditCalls } = buildApp();

    const newToken = 'NEWTOKEN'.padEnd(20, 'X'); // 20 chars
    const res = await makeRequest(app, 'PATCH', {
      body: { sendtok: newToken },
    });

    expect(res.status).toBe(200);

    const text = await res.text();
    // BR-PRIVACY-001: raw token never echoed in response.
    expect(text).not.toContain(newToken);

    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.has_sendtok).toBe(true);
    expect(body.prefix).toBe('NEWT');
    expect(body.length).toBe(20);
    expect(body.request_id).toBeTruthy();

    // DB upserted.
    const stored = state.integrations.get(WORKSPACE_ID);
    expect(stored).toBeDefined();
    expect(stored?.sendflowSendtok).toBe(newToken);

    // Audit captured with correct action.
    expect(auditCalls).toHaveLength(1);
    const audit = auditCalls[0];
    expect(audit?.action).toBe('workspace_sendflow_sendtok_updated');
    expect(audit?.workspace_id).toBe(WORKSPACE_ID);
    expect(audit?.entity_type).toBe('workspace_integration');
    expect(audit?.entity_id).toBe(WORKSPACE_ID);

    // BR-PRIVACY-001: audit metadata MUST contain only prefix + length.
    const meta = audit?.metadata ?? {};
    expect(meta.prefix).toBe('NEWT');
    expect(meta.length).toBe(20);
    // Raw value MUST NOT appear anywhere in audit entry.
    expect(JSON.stringify(audit)).not.toContain(newToken);
  });

  it('200 on PATCH twice (insert then update); both succeed; final value is the second token', async () => {
    const { app, state, auditCalls } = buildApp();

    const tokenA = 'TOKENAAAAAAAAAAAAAAA'; // 20 chars
    const tokenB = 'TOKENBBBBBBBBBBBBBBB'; // 20 chars

    const res1 = await makeRequest(app, 'PATCH', { body: { sendtok: tokenA } });
    expect(res1.status).toBe(200);
    expect(state.integrations.get(WORKSPACE_ID)?.sendflowSendtok).toBe(tokenA);

    const res2 = await makeRequest(app, 'PATCH', { body: { sendtok: tokenB } });
    expect(res2.status).toBe(200);
    expect(state.integrations.get(WORKSPACE_ID)?.sendflowSendtok).toBe(tokenB);

    // Two audit entries recorded.
    expect(auditCalls).toHaveLength(2);
    expect(auditCalls[0]?.metadata.prefix).toBe('TOKE');
    expect(auditCalls[1]?.metadata.prefix).toBe('TOKE');
  });
});
