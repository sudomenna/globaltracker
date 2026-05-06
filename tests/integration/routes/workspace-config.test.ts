/**
 * Integration tests — routes/workspace-config.ts
 *
 * GET  /v1/workspace/config  (read current workspaces.config)
 * PATCH /v1/workspace/config (partial merge into workspaces.config)
 *
 * T-ID: T-13-016a (extends T-FUNIL-021/024 with sendflow.campaign_map + GET)
 *
 * Coverage:
 *   PATCH:
 *     - sendflow.campaign_map valid entry → 200, merged config returned
 *     - sendflow.campaign_map entry missing required field (launch/stage/event_name) → 400
 *     - sendflow.<unknown_key> → 400 (strict)
 *     - top-level unknown_top_level field → 400 (strict)
 *   GET:
 *     - missing Authorization → 401
 *     - valid auth + existing workspace config → 200 with { config }
 *     - valid auth + workspace with null/undefined config → 200 with { config: {} }
 *
 * BRs applied:
 *   BR-RBAC-002: workspace_id from auth context — never from body/query
 *   BR-AUDIT-001: GET is read-only (no audit), PATCH writes audit
 *   BR-PRIVACY-001: zero PII in logs/error responses
 *
 * Test approach: real Hono app, mock Db (Drizzle-shaped fluent stub),
 * inject getDb via createWorkspaceConfigRoute deps. No real Postgres.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type InsertAuditEntryFn,
  createWorkspaceConfigRoute,
} from '../../../apps/edge/src/routes/workspace-config.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../apps/edge/src/middleware/sanitize-logs.js', () => ({
  safeLog: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-config-int-0001';
const ACTOR_ID = 'actor-token-int-001';

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Drizzle-shaped DB mock for workspace config tests.
 * Supports both:
 *   SELECT { config } FROM workspaces WHERE id = ? LIMIT 1
 *   UPDATE workspaces SET config = ? WHERE id = ?
 *
 * @param currentConfig value returned by SELECT (use `null`/`undefined` to
 *   simulate workspace.config being NULL).
 */
function makeDbMock(
  currentConfig: Record<string, unknown> | null | undefined = {},
) {
  const updateFn = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  });

  const db = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ config: currentConfig }]),
        }),
      }),
    }),
    update: updateFn,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
    _updateFn: updateFn,
  };

  return db as unknown as import('@globaltracker/db').Db & {
    _updateFn: ReturnType<typeof vi.fn>;
  };
}

/**
 * Creates a DB mock that returns no rows (workspace not found).
 */
function makeDbMockEmpty() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as import('@globaltracker/db').Db;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

/**
 * Builds a Hono app with workspace_id injected as context variable
 * (simulating auth middleware — BR-RBAC-002).
 */
function buildApp(
  db: import('@globaltracker/db').Db,
  insertAuditEntry?: InsertAuditEntryFn,
): Hono {
  const app = new Hono<{
    Bindings: {
      GT_KV: KVNamespace;
      HYPERDRIVE: unknown;
      ENVIRONMENT: string;
      DEV_WORKSPACE_ID: string;
    };
    Variables: { workspace_id: string; request_id: string };
  }>();

  // Simulate auth middleware injecting workspace_id (BR-RBAC-002)
  app.use('*', async (c, next) => {
    c.set('workspace_id', WORKSPACE_ID);
    c.set('request_id', 'req-int-001');
    await next();
  });

  const route = createWorkspaceConfigRoute({
    getDb: () => db,
    insertAuditEntry,
  });

  app.route('/v1/workspace', route);

  return app as unknown as Hono;
}

// ---------------------------------------------------------------------------
// PATCH /v1/workspace/config — sendflow.campaign_map
// ---------------------------------------------------------------------------

describe('PATCH /v1/workspace/config — sendflow.campaign_map (T-13-016a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts valid sendflow.campaign_map entry and returns merged config', async () => {
    const db = makeDbMock({});
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ACTOR_ID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sendflow: {
          campaign_map: {
            abc: {
              launch: 'wkshop-cs-jun26',
              stage: 'wpp_joined',
              event_name: 'Contact',
            },
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const config = body.config as Record<string, unknown>;
    const sendflow = config.sendflow as Record<string, unknown>;
    const map = sendflow?.campaign_map as Record<string, unknown>;

    expect(map).toBeDefined();
    expect(map.abc).toMatchObject({
      launch: 'wkshop-cs-jun26',
      stage: 'wpp_joined',
      event_name: 'Contact',
    });
  });

  it('rejects sendflow.campaign_map entry missing required fields with 400', async () => {
    const db = makeDbMock({});
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ACTOR_ID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sendflow: {
          campaign_map: {
            abc: {}, // missing launch / stage / event_name
          },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/@/);
  });

  it('rejects unknown nested key under sendflow with 400 (strict schema)', async () => {
    const db = makeDbMock({});
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ACTOR_ID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sendflow: {
          unknown_key: { foo: 'bar' },
        },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  it('rejects unknown top-level field with 400 (strict schema still enforced)', async () => {
    const db = makeDbMock({});
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ACTOR_ID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sendflow: { campaign_map: {} },
        unknown_top_level: { anything: true },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });
});

// ---------------------------------------------------------------------------
// PATCH /v1/workspace/config — null as tombstone (T-13-016d)
//
// BR-API-PATCH-NULL: `null` em qualquer chave do body é interpretado como
// tombstone — remove a chave do JSONB em vez de armazenar null.
// ---------------------------------------------------------------------------

describe('PATCH /v1/workspace/config — null as tombstone (T-13-016d)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes a campaign_map entry when value is null (tombstone)', async () => {
    const existing = {
      sendflow: {
        campaign_map: {
          abc: {
            launch: 'wkshop-cs-jun26',
            stage: 'wpp_joined',
            event_name: 'Contact',
          },
        },
      },
    };
    const db = makeDbMock(existing);
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ACTOR_ID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sendflow: {
          campaign_map: {
            abc: null,
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const config = body.config as Record<string, unknown>;
    const sendflow = config.sendflow as Record<string, unknown>;
    const map = sendflow?.campaign_map as Record<string, unknown>;

    expect(map).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(map, 'abc')).toBe(false);
  });

  it('preserves other entries while removing the null-targeted one', async () => {
    const existing = {
      sendflow: {
        campaign_map: {
          abc: {
            launch: 'wkshop-cs-jun26',
            stage: 'wpp_joined',
            event_name: 'Contact',
          },
          old: {
            launch: 'wkshop-cs-may26',
            stage: 'wpp_joined',
            event_name: 'Contact',
          },
        },
      },
    };
    const db = makeDbMock(existing);
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ACTOR_ID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sendflow: {
          campaign_map: {
            abc: null,
            xyz: {
              launch: 'wkshop-cs-jun26',
              stage: 'wpp_joined',
              event_name: 'Lead',
            },
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const config = body.config as Record<string, unknown>;
    const sendflow = config.sendflow as Record<string, unknown>;
    const map = sendflow?.campaign_map as Record<string, unknown>;

    expect(map).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(map, 'abc')).toBe(false);
    expect(map.old).toMatchObject({
      launch: 'wkshop-cs-may26',
      event_name: 'Contact',
    });
    expect(map.xyz).toMatchObject({
      launch: 'wkshop-cs-jun26',
      event_name: 'Lead',
    });
  });

  it('is a no-op when null targets a key that does not exist', async () => {
    const existing = {
      sendflow: {
        campaign_map: {
          old: {
            launch: 'wkshop-cs-may26',
            stage: 'wpp_joined',
            event_name: 'Contact',
          },
        },
      },
    };
    const db = makeDbMock(existing);
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${ACTOR_ID}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sendflow: {
          campaign_map: {
            does_not_exist: null,
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const config = body.config as Record<string, unknown>;
    const sendflow = config.sendflow as Record<string, unknown>;
    const map = sendflow?.campaign_map as Record<string, unknown>;

    expect(map).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(map, 'does_not_exist')).toBe(
      false,
    );
    expect(map.old).toMatchObject({ launch: 'wkshop-cs-may26' });
  });
});

// ---------------------------------------------------------------------------
// GET /v1/workspace/config
// ---------------------------------------------------------------------------

describe('GET /v1/workspace/config (T-13-016a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const db = makeDbMock({});
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('unauthorized');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/@/);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns 200 with current config when workspace exists and is authenticated', async () => {
    const existing = {
      integrations: {
        guru: {
          product_launch_map: {
            'prod-001': {
              launch_public_id: 'lp-2026',
              funnel_role: 'main_offer',
            },
          },
        },
      },
      sendflow: {
        campaign_map: {
          abc: {
            launch: 'wkshop-cs-jun26',
            stage: 'wpp_joined',
            event_name: 'Contact',
          },
        },
      },
    };

    const db = makeDbMock(existing);
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ACTOR_ID}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.config).toEqual(existing);
    expect(body.request_id).toBeDefined();
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns 200 with { config: {} } when workspace.config is null', async () => {
    const db = makeDbMock(null);
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ACTOR_ID}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.config).toEqual({});
  });

  it('returns 200 with { config: {} } when workspace row not found (no rows)', async () => {
    const db = makeDbMockEmpty();
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ACTOR_ID}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.config).toEqual({});
  });

  it('parses jsonb defensively when driver returns config as JSON string', async () => {
    const stringified = JSON.stringify({
      sendflow: {
        campaign_map: {
          abc: {
            launch: 'lp-x',
            stage: 'wpp_joined',
            event_name: 'Contact',
          },
        },
      },
    });

    // Simulate driver returning string instead of parsed object
    const db = makeDbMock(stringified as unknown as Record<string, unknown>);
    const app = buildApp(db);

    const res = await app.request('/v1/workspace/config', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ACTOR_ID}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const config = body.config as Record<string, unknown>;
    const sendflow = config.sendflow as Record<string, unknown>;
    const map = sendflow?.campaign_map as Record<string, unknown>;
    expect(map?.abc).toMatchObject({ launch: 'lp-x' });
  });
});
