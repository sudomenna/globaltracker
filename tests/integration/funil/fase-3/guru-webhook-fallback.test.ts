/**
 * Integration tests — Guru webhook handler with strategy=last_attribution (fallback)
 *
 * T-ID: T-FUNIL-024 (Sprint 11, Onda 3)
 *
 * Scenario: Webhook Guru Purchase with product_id NOT in product_launch_map,
 *   but lead has existing lead_attribution
 *   → raw_event inserted with launch_id from attribution and funnel_role: null
 *   → audit_log records strategy='last_attribution'
 *
 * BRs applied:
 *   BR-WEBHOOK-001: token validated before processing
 *   BR-WEBHOOK-002: event_id deterministic
 *   BR-WEBHOOK-004: lead_hints extracted from payload
 *   BR-AUDIT-001: guru_launch_resolved logged with strategy field
 *   BR-PRIVACY-001: no PII in logs; lead hints hashed before DB lookup
 *   BR-EVENT-001: raw_events insert awaited before 202
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuruWebhookRoute } from '../../../../apps/edge/src/routes/webhooks/guru.js';

// ---------------------------------------------------------------------------
// Mocks
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

const WORKSPACE_ID = 'ws-guru-fallback-0001';
const LAUNCH_UUID_FROM_ATTRIBUTION = 'launch-uuid-attribution-0001';
const RAW_EVENT_UUID = 'raw-event-fallback-0001';
const LEAD_UUID = 'lead-uuid-fallback-0001';
const GURU_API_TOKEN = 'guru-api-token-fallback-xyz789';
const PRODUCT_ID_NOT_IN_MAP = 'prod-unknown-xyz';

// ---------------------------------------------------------------------------
// DB mock factory for strategy=last_attribution scenario
//
// Call order in guru.ts + resolveLaunchForGuruEvent:
//   1. db.query.workspaceIntegrations.findFirst → workspace auth
//   2. resolveLaunchForGuruEvent strategy 1:
//      a. select workspaces (config with EMPTY map — product not found)
//      (strategy 1 fails — productId not in map or no launch found)
//   3. resolveLaunchForGuruEvent strategy 2:
//      b. select lead_aliases by email hash → returns lead
//      c. select lead_attributions by lead_id → returns attribution with launch_id
//   4. db.insert(rawEvents).values(...).returning
// ---------------------------------------------------------------------------

function makeFallbackStrategyDb() {
  const insertedRawEvents: Record<string, unknown>[] = [];

  // Config with empty product_launch_map so product_id is NOT found
  const workspaceConfigEmptyMap = {
    integrations: {
      guru: {
        product_launch_map: {
          // PRODUCT_ID_NOT_IN_MAP is absent
          'prod-some-other': {
            launch_public_id: 'lcm-other',
            funnel_role: 'other',
          },
        },
      },
    },
  };

  let selectCallCount = 0;

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
        // workspaces config query — product_id NOT in map
        return makeChain([{ config: workspaceConfigEmptyMap }]);
      }

      if (selectCallCount === 2) {
        // lead_aliases query (email hash lookup) → lead found
        return makeChain([{ leadId: LEAD_UUID }]);
      }

      if (selectCallCount === 3) {
        // lead_attributions query → returns attribution with launch_id
        return makeChain([{ launchId: LAUNCH_UUID_FROM_ATTRIBUTION }]);
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

function makeQueueMock() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue;
}

function buildGuruApp(db: import('@globaltracker/db').Db): Hono {
  const queue = makeQueueMock();

  const app = new Hono<{ Bindings: { QUEUE_EVENTS: Queue } }>();

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
// Fixture: Guru transaction with product_id NOT in map but lead has attribution
// ---------------------------------------------------------------------------

function makeTransactionPayloadWithUnmappedProduct(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    webhook_type: 'transaction',
    api_token: GURU_API_TOKEN,
    id: 'fallback-tx-7777-8888-9999-aabbccddeeff',
    type: 'producer',
    status: 'approved',
    created_at: '2024-02-20T14:00:00Z',
    confirmed_at: '2024-02-20T14:01:00Z',
    contact: {
      name: 'Lead Retornante',
      email: 'retornante@example.com',
      phone_number: '11988887777',
      phone_local_code: '55',
    },
    payment: {
      method: 'pix',
      total: 49700,
      gross: 49700,
      net: 43000,
      currency: 'BRL',
    },
    product: {
      id: PRODUCT_ID_NOT_IN_MAP,
      name: 'Produto Sem Mapeamento',
      type: 'product',
    },
    source: {
      utm_source: 'google',
      utm_campaign: 'retargeting_001',
      utm_medium: 'cpc',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/webhook/guru — strategy=last_attribution (product_id not in map)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 202 when product_id is not in map but lead has attribution', async () => {
    const db = makeFallbackStrategyDb();
    const app = buildGuruApp(db);

    const res = await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithUnmappedProduct()),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.received).toBe(true);
  });

  it('inserts raw_event with launch_id from lead attribution (strategy=last_attribution)', async () => {
    const db = makeFallbackStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithUnmappedProduct()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    // launch_id must come from last_attribution (not from product_launch_map)
    expect(payload?.launch_id).toBe(LAUNCH_UUID_FROM_ATTRIBUTION);
  });

  it('inserts raw_event with funnel_role: null for strategy=last_attribution', async () => {
    const db = makeFallbackStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithUnmappedProduct()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    // For last_attribution, funnel_role is always null (no explicit mapping)
    // The field should not be injected (undefined) since resolver returns funnel_role=null
    // Per guru.ts: `...(resolvedFunnelRole !== null && { funnel_role: resolvedFunnelRole })`
    expect(payload?.funnel_role).toBeUndefined();
  });

  it('safeLog records guru_launch_resolved with strategy=last_attribution (BR-AUDIT-001)', async () => {
    const { safeLog } = await import('../../../../apps/edge/src/middleware/sanitize-logs.js');
    vi.clearAllMocks();

    const db = makeFallbackStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithUnmappedProduct()),
    });

    const calls = (safeLog as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];
    const resolvedLog = calls.find(([, entry]) => entry.event === 'guru_launch_resolved');

    expect(resolvedLog).toBeDefined();
    const [level, entry] = resolvedLog!;
    expect(level).toBe('info');
    expect(entry.strategy).toBe('last_attribution');
    expect(entry.launch_id).toBe(LAUNCH_UUID_FROM_ATTRIBUTION);

    // BR-PRIVACY-001: no PII in log entry
    expect(entry.email).toBeUndefined();
    expect(entry.phone).toBeUndefined();
  });

  it('inserts raw_event with processingStatus=pending', async () => {
    const db = makeFallbackStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithUnmappedProduct()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];

    expect(lastRow?.processingStatus).toBe('pending');
  });

  it('does NOT store api_token in raw_event payload (BR-PRIVACY-001)', async () => {
    const db = makeFallbackStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadWithUnmappedProduct()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    expect(payload?.api_token).toBeUndefined();
  });
});
