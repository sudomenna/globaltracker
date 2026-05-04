/**
 * Integration tests — Guru webhook handler with strategy=mapping (product_launch_map)
 *
 * T-ID: T-FUNIL-024 (Sprint 11, Onda 3)
 *
 * Scenario: Webhook Guru Purchase with product_id present in product_launch_map
 *   → raw_event inserted with launch_id (UUID) and funnel_role in payload
 *   → audit_log records action='guru_launch_resolved' with strategy='mapping'
 *
 * BRs applied:
 *   BR-WEBHOOK-001: token validated via constant-time comparison before processing
 *   BR-WEBHOOK-002: event_id derived deterministically from platform fields
 *   BR-WEBHOOK-004: lead_hints extracted per hierarchy (email → phone → visitorId)
 *   BR-AUDIT-001: guru_launch_resolved logged with strategy field
 *   BR-PRIVACY-001: api_token, email, phone never logged; no PII in error responses
 *   BR-EVENT-001: raw_events insert awaited before 202
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuruWebhookRoute } from '../../../../apps/edge/src/routes/webhooks/guru.js';

// ---------------------------------------------------------------------------
// Mock safeLog and pii helpers to keep tests hermetic
// ---------------------------------------------------------------------------

vi.mock('../../../../apps/edge/src/middleware/sanitize-logs.js', () => ({
  safeLog: vi.fn(),
}));

vi.mock('../../../../apps/edge/src/lib/pii.js', () => ({
  hashPii: vi.fn(async (value: string, _workspaceId: string) => `hash:${value}`),
}));

vi.mock('../../../../apps/edge/src/lib/lead-resolver.js', () => ({
  normalizeEmail: vi.fn((e: string) => e.toLowerCase().trim()),
  normalizePhone: vi.fn((p: string) => p.replace(/\D/g, '')),
}));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-guru-resolved-0001';
const LAUNCH_UUID = 'launch-uuid-fase3-0001';
const RAW_EVENT_UUID = 'raw-event-uuid-0001';
const GURU_API_TOKEN = 'guru-api-token-abc123456789';
const PRODUCT_ID = 'prod-workshop-001';
const LAUNCH_PUBLIC_ID = 'lcm-maio-2026';
const FUNNEL_ROLE = 'workshop';

// ---------------------------------------------------------------------------
// DB mock factory for strategy=mapping scenario
// ---------------------------------------------------------------------------

/**
 * Creates a state-tracking mock DB for the guru webhook route.
 *
 * Call order in guru.ts (when product_id is in map):
 *   1. db.query.workspaceIntegrations.findFirst → workspace auth
 *   2. resolveLaunchForGuruEvent:
 *      a. select workspaces (config with product_launch_map)
 *      b. select launches (by public_id) → returns launch UUID
 *   3. db.insert(rawEvents).values(...).returning → inserts raw_event
 *   4. c.env.QUEUE_EVENTS.send (mocked in Hono env)
 */
function makeMappingStrategyDb() {
  const insertedRawEvents: Record<string, unknown>[] = [];

  let selectCallCount = 0;

  const workspaceConfig = {
    integrations: {
      guru: {
        product_launch_map: {
          [PRODUCT_ID]: {
            launch_public_id: LAUNCH_PUBLIC_ID,
            funnel_role: FUNNEL_ROLE,
          },
        },
      },
    },
  };

  const db = {
    query: {
      workspaceIntegrations: {
        findFirst: vi.fn().mockResolvedValue({
          workspaceId: WORKSPACE_ID,
          guruApiToken: GURU_API_TOKEN,
        }),
      },
    },

    select: vi.fn(() => {
      selectCallCount++;

      if (selectCallCount === 1) {
        // workspaces config query (from resolveLaunchForGuruEvent strategy 1)
        return makeChain([{ config: workspaceConfig }]);
      }

      if (selectCallCount === 2) {
        // launches query by public_id
        return makeChain([{ id: LAUNCH_UUID }]);
      }

      return makeChain([]);
    }),

    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        const row = { ...data, id: RAW_EVENT_UUID };
        insertedRawEvents.push(row);
        return {
          returning: vi.fn().mockResolvedValue([{ id: RAW_EVENT_UUID }]),
        };
      }),
    }),

    _insertedRawEvents: insertedRawEvents,
  };

  return db as unknown as import('@globaltracker/db').Db & {
    _insertedRawEvents: Record<string, unknown>[];
  };
}

function makeChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
}

// ---------------------------------------------------------------------------
// Queue mock
// ---------------------------------------------------------------------------

function makeQueueMock() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function buildGuruApp(db: import('@globaltracker/db').Db): Hono {
  const queue = makeQueueMock();

  const app = new Hono<{
    Bindings: { QUEUE_EVENTS: Queue };
  }>();

  // Inject queue binding
  app.use('*', async (c, next) => {
    // @ts-expect-error -- patching env for test purposes
    c.env = { QUEUE_EVENTS: queue };
    await next();
  });

  const route = createGuruWebhookRoute(db);
  app.route('/v1/webhook/guru', route);

  return app as unknown as Hono;
}

// ---------------------------------------------------------------------------
// Fixture: valid Guru transaction payload with product_id in map
// ---------------------------------------------------------------------------

function makeTransactionPayloadWithProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    webhook_type: 'transaction',
    api_token: GURU_API_TOKEN,
    id: '9081534a-7512-4dab-9172-218c1dc1f263',
    type: 'producer',
    status: 'approved',
    created_at: '2024-01-15T10:30:00Z',
    confirmed_at: '2024-01-15T10:31:00Z',
    contact: {
      name: 'Comprador Teste',
      email: 'comprador@example.com',
      phone_number: '11999999999',
      phone_local_code: '55',
    },
    payment: {
      method: 'credit_card',
      total: 29700,
      gross: 29700,
      net: 25245,
      currency: 'BRL',
      installments: { qty: 1, value: 29700 },
    },
    product: {
      id: PRODUCT_ID,
      name: 'Workshop Avançado',
      type: 'product',
    },
    source: {
      utm_source: 'facebook',
      utm_campaign: 'camp_123',
      utm_medium: 'paid',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/webhook/guru — strategy=mapping (product_id in product_launch_map)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 202 when product_id is present in product_launch_map', async () => {
    const db = makeMappingStrategyDb();
    const app = buildGuruApp(db);

    const res = await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithProduct()),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.received).toBe(true);
  });

  it('inserts raw_event with launch_id (UUID) in payload when product_id maps to a launch', async () => {
    const db = makeMappingStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithProduct()),
    });

    // Verify raw_event was inserted with launch_id
    const insertCalls = (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert.mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);

    // The last insert call (for pending raw_event) should have enriched payload
    const lastInsertCall = insertCalls[insertCalls.length - 1];
    const insertedTable = lastInsertCall?.[0];
    // Verify the insert() was called with rawEvents table (object has workspaceId shape)

    const valuesCall = (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert.mock.results[
      insertCalls.length - 1
    ]?.value;
    expect(valuesCall).toBeDefined();

    // Check via inserted raw events state
    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    expect(insertedRows.length).toBeGreaterThan(0);

    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    // BR-EVENT-001: launch_id must be in payload
    expect(payload?.launch_id).toBe(LAUNCH_UUID);
  });

  it('inserts raw_event with funnel_role in payload when product_id maps to a launch', async () => {
    const db = makeMappingStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithProduct()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    // funnel_role must be injected by resolver (strategy=mapping)
    expect(payload?.funnel_role).toBe(FUNNEL_ROLE);
  });

  it('inserts raw_event with processingStatus=pending', async () => {
    const db = makeMappingStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithProduct()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];

    expect(lastRow?.processingStatus).toBe('pending');
  });

  it('does NOT store api_token in raw_event payload (BR-PRIVACY-001)', async () => {
    const db = makeMappingStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithProduct()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    // BR-PRIVACY-001: api_token must be stripped from stored payload
    expect(payload?.api_token).toBeUndefined();
  });

  it('safeLog records guru_launch_resolved with strategy=mapping (BR-AUDIT-001)', async () => {
    const { safeLog } = await import('../../../../apps/edge/src/middleware/sanitize-logs.js');
    vi.clearAllMocks();

    const db = makeMappingStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithProduct()),
    });

    // Find the guru_launch_resolved log entry
    const calls = (safeLog as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];
    const resolvedLog = calls.find(([, entry]) => entry.event === 'guru_launch_resolved');

    expect(resolvedLog).toBeDefined();
    const [level, entry] = resolvedLog!;
    expect(level).toBe('info');
    expect(entry.strategy).toBe('mapping');
    expect(entry.launch_id).toBe(LAUNCH_UUID);

    // BR-PRIVACY-001: no PII in log entry
    expect(entry.email).toBeUndefined();
    expect(entry.phone).toBeUndefined();
  });
});
