/**
 * Integration tests — GET /v1/events?launch_id=
 *
 * T-ID: T-FUNIL-005
 * T-FUNIL-004: GET /v1/events with workspace isolation + cursor pagination.
 *
 * Covers:
 *   1. 401 when Authorization header is missing
 *   2. 400 when launch_id is absent
 *   3. 400 when launch_id is not a valid UUID
 *   4. 400 when launch_id is empty string
 *   5. 404 when launch does not belong to the authenticated workspace (cross-workspace isolation)
 *   6. 200 returns events belonging to the requested launch
 *   7. limit=2 returns 2 events + non-null next_cursor when more events exist
 *   8. next_cursor is null when returned events are fewer than limit
 *   9. 200 returns empty events array when launch has no events
 *  10. 200 response includes correct shape (events, total, next_cursor)
 *  11. X-Request-Id header is present in 200 responses
 *
 * Test approach:
 *   - Mock @globaltracker/db via relative filesystem path (packages/db/src/index.js)
 *     so createDb() returns a controllable mock without a real Postgres connection.
 *   - Real Hono app with createEventsRoute mounted.
 *   - Workspace isolation simulated via context variable injection (workspace_id).
 *   - DATABASE_URL injected in env bindings.
 *
 * BR-RBAC-002: workspace isolation — launch must belong to workspace in context.
 * BR-PRIVACY-001: no PII in error responses.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WS_A = '00000000-0000-0000-0000-000000000001';
const WS_B = '00000000-0000-0000-0000-000000000002';
const LAUNCH_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const LAUNCH_B = 'bbbbbbbb-0000-0000-0000-000000000002';

type EventRow = {
  id: string;
  eventName: string;
  createdAt: Date;
  leadId: string | null;
  pageId: string | null;
  launchId: string | null;
};

const EVENTS_LAUNCH_A: EventRow[] = [
  {
    id: 'evt-a-1',
    eventName: 'PageView',
    createdAt: new Date('2026-05-04T00:03:00.000Z'),
    leadId: null,
    pageId: 'pg-a',
    launchId: LAUNCH_A,
  },
  {
    id: 'evt-a-2',
    eventName: 'Lead',
    createdAt: new Date('2026-05-04T00:02:00.000Z'),
    leadId: null,
    pageId: 'pg-a',
    launchId: LAUNCH_A,
  },
  {
    id: 'evt-a-3',
    eventName: 'Purchase',
    createdAt: new Date('2026-05-04T00:01:00.000Z'),
    leadId: null,
    pageId: 'pg-a',
    launchId: LAUNCH_A,
  },
];

// ---------------------------------------------------------------------------
// Mock @globaltracker/db via relative filesystem path.
//
// Vitest normalises module IDs to real file paths. The symlink
//   apps/edge/node_modules/@globaltracker/db -> ../../../../packages/db
// resolves to packages/db/src/index.ts. Mocking that relative path
// intercepts all imports of @globaltracker/db regardless of import site.
// ---------------------------------------------------------------------------

// Current test's mock DB factory. Reset per-test via beforeEach.
let launchFound = false;
let eventRows: EventRow[] = [];
let totalCount = 0;

vi.mock('../../../../packages/db/src/index.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../../packages/db/src/index.js')>();

  return {
    ...original,
    createDb: (_connString: string) => {
      // Stateful mock controlled by the outer-scope variables.
      //
      // Call sequence from the GET handler:
      //   select #1: .select({id}).from(launches).where(...).limit(1)
      //              → launch ownership check
      //   select #2: .select({...}).from(events).where(...).orderBy().limit(n)
      //              → event rows
      //   select #3: .select({total:count()}).from(events).where(...)
      //              → total count (used as: const [countRow] = await ...)
      let selectCallIdx = 0;

      // biome-ignore lint/suspicious/noExplicitAny: mock drizzle query builder
      const db: any = {
        select: (_fields?: unknown) => {
          selectCallIdx++;
          const thisCall = selectCallIdx;

          if (thisCall === 1) {
            // Launch ownership check
            return {
              from: () => ({
                where: () => ({
                  limit: async (_n: number) =>
                    launchFound ? [{ id: LAUNCH_A }] : [],
                }),
              }),
            };
          }

          if (thisCall === 2) {
            // Event rows query
            return {
              from: () => ({
                where: () => ({
                  orderBy: () => ({
                    limit: async (n: number) => eventRows.slice(0, n),
                  }),
                }),
              }),
            };
          }

          // thisCall === 3: COUNT query
          // The handler does: const [countRow] = await dbConn.select({total:count()}).from(events).where(...)
          return {
            from: () => ({
              where: async () => [{ total: totalCount }],
            }),
          };
        },
      };

      return db;
    },
  };
});

// ---------------------------------------------------------------------------
// Mock KV + Queue helpers
// ---------------------------------------------------------------------------

function createMockKv(): KVNamespace {
  const store = new Map<string, string>();
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cursor: '' };
    },
    async getWithMetadata(key: string) {
      return { value: store.get(key) ?? null, metadata: null };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Bindings type (mirrors apps/edge/src/index.ts)
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DATABASE_URL: string;
  HYPERDRIVE: Hyperdrive;
  LEAD_TOKEN_SECRET?: string;
  DEV_WORKSPACE_ID?: string;
};

type Variables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
  lead_id?: string;
};

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

async function buildGetEventsApp(options: {
  workspaceId?: string;
}) {
  const { createEventsRoute } = await import(
    '../../../../apps/edge/src/routes/events.js'
  );

  const kv = createMockKv();

  const eventsRoute = createEventsRoute();

  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Inject context variables (simulates auth middleware)
  app.use('/v1/events/*', async (c, next) => {
    if (options.workspaceId) {
      c.set('workspace_id', options.workspaceId);
    }
    c.set('page_id', 'pg-test');
    c.set('request_id', 'req-test-get-events');
    await next();
  });

  app.route('/v1/events', eventsRoute);

  const mockEnv: Bindings = {
    GT_KV: kv,
    QUEUE_EVENTS: { send: async () => {} } as unknown as Queue,
    QUEUE_DISPATCH: {} as Queue,
    ENVIRONMENT: 'test',
    DATABASE_URL: 'postgresql://localhost/test',
    HYPERDRIVE: { connectionString: '' } as Hyperdrive,
  };

  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      return app.fetch(request, mockEnv);
    },
  };
}

const EVENTS_URL = 'http://localhost/v1/events';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/events — T-FUNIL-004', () => {
  beforeEach(() => {
    // Reset mock state before each test — deterministic, no shared state
    launchFound = false;
    eventRows = [];
    totalCount = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    launchFound = false;
    eventRows = [];
    totalCount = 0;
  });

  // -------------------------------------------------------------------------
  // Test 1: 401 when Authorization header is missing
  // -------------------------------------------------------------------------
  it('401: returns unauthorized when Authorization header is missing', async () => {
    launchFound = true;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(
      `${EVENTS_URL}?launch_id=${LAUNCH_A}`,
      // No Authorization header
    );

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('unauthorized');
  });

  // -------------------------------------------------------------------------
  // Test 2: 400 when launch_id is absent
  // -------------------------------------------------------------------------
  it('400: returns validation_error when launch_id is absent', async () => {
    launchFound = false;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(EVENTS_URL, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // Test 3: 400 when launch_id is not a valid UUID
  // -------------------------------------------------------------------------
  it('400: returns validation_error when launch_id is not a UUID', async () => {
    launchFound = false;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(`${EVENTS_URL}?launch_id=not-a-uuid`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // Test 4: 400 when launch_id is empty string (invalid UUID)
  // -------------------------------------------------------------------------
  it('400: returns validation_error when launch_id is an empty string', async () => {
    launchFound = false;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(`${EVENTS_URL}?launch_id=`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // Test 5: 404 when launch does not belong to the workspace (cross-workspace)
  //
  // BR-RBAC-002: workspace isolation — returns 404 (not 403) to avoid leaking existence.
  // Cross-launch isolation: WS_B's launch is not accessible from WS_A's context.
  // -------------------------------------------------------------------------
  it('404: returns launch_not_found when launch belongs to a different workspace (cross-workspace isolation)', async () => {
    // launchFound=false simulates the DB returning no row (launch WS_B not in WS_A)
    launchFound = false;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(`${EVENTS_URL}?launch_id=${LAUNCH_B}`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('launch_not_found');
    // BR-PRIVACY-001: no workspace IDs leaked in 404 response body
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain(WS_A);
    expect(bodyStr).not.toContain(WS_B);
    expect(bodyStr).not.toContain(LAUNCH_B);
  });

  // -------------------------------------------------------------------------
  // Test 6: 200 returns events for the correct launch
  // -------------------------------------------------------------------------
  it('200: returns events belonging to the requested launch with correct shape', async () => {
    launchFound = true;
    eventRows = EVENTS_LAUNCH_A;
    totalCount = EVENTS_LAUNCH_A.length;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(`${EVENTS_URL}?launch_id=${LAUNCH_A}`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<Record<string, unknown>>;
      total: number;
      next_cursor: string | null;
    };

    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBeGreaterThan(0);
    // All returned events must have launch_id = LAUNCH_A
    for (const evt of body.events) {
      expect(evt.launch_id).toBe(LAUNCH_A);
    }
    expect(body.total).toBe(EVENTS_LAUNCH_A.length);
  });

  // -------------------------------------------------------------------------
  // Test 7: Pagination — limit=2 returns 2 events and next_cursor when more exist
  //
  // The handler sets next_cursor when rows.length === limit.
  // -------------------------------------------------------------------------
  it('pagination: limit=2 returns 2 events and non-null next_cursor when more events exist', async () => {
    launchFound = true;
    eventRows = EVENTS_LAUNCH_A; // 3 events available
    totalCount = 3;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(
      `${EVENTS_URL}?launch_id=${LAUNCH_A}&limit=2`,
      { headers: { Authorization: 'Bearer test-token' } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<Record<string, unknown>>;
      total: number;
      next_cursor: string | null;
    };

    // limit=2 → 2 events returned (mock slices to limit)
    expect(body.events).toHaveLength(2);
    // rows.length (2) === limit (2) → next_cursor must be non-null
    expect(body.next_cursor).not.toBeNull();
    expect(typeof body.next_cursor).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Test 8: Pagination — next_cursor is null when page is smaller than limit
  // -------------------------------------------------------------------------
  it('pagination: next_cursor is null when returned events are fewer than limit', async () => {
    launchFound = true;
    eventRows = EVENTS_LAUNCH_A.slice(0, 2); // only 2 events
    totalCount = 2;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(
      `${EVENTS_URL}?launch_id=${LAUNCH_A}&limit=10`,
      { headers: { Authorization: 'Bearer test-token' } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<Record<string, unknown>>;
      total: number;
      next_cursor: string | null;
    };

    expect(body.events).toHaveLength(2);
    // rows.length (2) < limit (10) → next_cursor must be null
    expect(body.next_cursor).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 9: 200 empty result when launch has no events
  // -------------------------------------------------------------------------
  it('200: returns empty events array when launch has no events', async () => {
    launchFound = true;
    eventRows = [];
    totalCount = 0;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(`${EVENTS_URL}?launch_id=${LAUNCH_A}`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<unknown>;
      total: number;
      next_cursor: string | null;
    };

    expect(body.events).toHaveLength(0);
    expect(body.total).toBe(0);
    expect(body.next_cursor).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 10: 200 response has correct shape (events, total, next_cursor)
  // -------------------------------------------------------------------------
  it('200: response body includes events array, total count, and next_cursor', async () => {
    launchFound = true;
    eventRows = EVENTS_LAUNCH_A.slice(0, 1);
    totalCount = 1;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(`${EVENTS_URL}?launch_id=${LAUNCH_A}`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('events');
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('next_cursor');
    expect(Array.isArray(body.events)).toBe(true);

    // Each event must have required fields
    const firstEvent = (body.events as Array<Record<string, unknown>>)[0];
    expect(firstEvent).toHaveProperty('id');
    expect(firstEvent).toHaveProperty('event_name');
    expect(firstEvent).toHaveProperty('created_at');
    expect(firstEvent).toHaveProperty('launch_id');
    expect(firstEvent).toHaveProperty('page_id');
    expect(firstEvent).toHaveProperty('lead_public_id');
  });

  // -------------------------------------------------------------------------
  // Test 11: X-Request-Id header is present in 200 responses
  // -------------------------------------------------------------------------
  it('200: response includes X-Request-Id header', async () => {
    launchFound = true;
    eventRows = [];
    totalCount = 0;
    const app = await buildGetEventsApp({ workspaceId: WS_A });

    const res = await app.fetch(`${EVENTS_URL}?launch_id=${LAUNCH_A}`, {
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });
});
