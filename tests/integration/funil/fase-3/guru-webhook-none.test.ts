/**
 * Integration tests — Guru webhook handler with strategy=none
 *
 * T-ID: T-FUNIL-024 (Sprint 11, Onda 3)
 *
 * Scenario: Webhook Guru Purchase without product_id and without identifiable lead
 *   → raw_event inserted without launch_id and funnel_role: null
 *   → audit_log records strategy='none'
 *
 * BRs applied:
 *   BR-WEBHOOK-001: token validated before processing
 *   BR-WEBHOOK-002: event_id deterministic from platform fields
 *   BR-WEBHOOK-004: lead_hints hierarchy — no usable hints
 *   BR-AUDIT-001: guru_launch_resolved logged with strategy=none
 *   BR-PRIVACY-001: no PII in logs
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

const WORKSPACE_ID = 'ws-guru-none-0001';
const RAW_EVENT_UUID = 'raw-event-none-0001';
const GURU_API_TOKEN = 'guru-api-token-none-zzz111';

// ---------------------------------------------------------------------------
// DB mock factory for strategy=none scenario
//
// Call order:
//   1. db.query.workspaceIntegrations.findFirst → workspace auth
//   2. resolveLaunchForGuruEvent:
//      - productId is null (subscription) → strategy 1 skipped
//      - lead hint email → lead_aliases lookup returns NO rows
//      → strategy 2 fails
//      → falls to strategy 3: none
//   3. db.insert(rawEvents).values(...).returning
// ---------------------------------------------------------------------------

function makeNoneStrategyDb() {
  const insertedRawEvents: Record<string, unknown>[] = [];

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
      // For strategy=none: lead_aliases returns empty → no lead → strategy=none
      // (productId is null for subscription → no workspaces/launches select calls)
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
// Fixture: Guru subscription payload
// Subscriptions have no product_id → strategy 1 (mapping) is skipped
// No lead found → strategy 2 (last_attribution) fails → strategy 3 (none)
// ---------------------------------------------------------------------------

function makeSubscriptionPayloadNoLead(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    webhook_type: 'subscription',
    api_token: GURU_API_TOKEN,
    id: 'sub-uuid-none-1234-5678-abcd',
    // GuruSubscriptionPayload uses last_status (not status)
    last_status: 'active',
    subscriber: {
      name: 'Assinante Desconhecido',
      email: 'unknown-subscriber@example.com',
    },
    current_invoice: {
      id: 'inv-none-001',
      status: 'paid',
      value: 9700,
      cycle: 1,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture: Guru transaction with NO contact email/phone
// Ensures strategy=none when no hints available from transaction either
// ---------------------------------------------------------------------------

function makeTransactionPayloadNoHints(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    webhook_type: 'transaction',
    api_token: GURU_API_TOKEN,
    id: 'tx-uuid-none-0000-1111-aabb',
    type: 'producer',
    status: 'approved',
    created_at: '2024-03-11T10:00:00Z',
    confirmed_at: '2024-03-11T10:01:00Z',
    contact: {
      name: 'Anon Comprador',
      email: 'anon@example.com',
      // phone_number intentionally absent
    },
    payment: {
      method: 'boleto',
      total: 19700,
      gross: 19700,
      net: 17000,
      currency: 'BRL',
    },
    product: {
      id: 'prod-no-map-xyz',
      name: 'Produto Sem Mapeamento Sem Lead',
      type: 'product',
    },
    // No source UTMs
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/webhook/guru — strategy=none (no product mapping, no identifiable lead)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 202 for subscription when lead is unidentifiable (strategy=none)', async () => {
    const db = makeNoneStrategyDb();
    const app = buildGuruApp(db);

    const res = await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSubscriptionPayloadNoLead()),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.received).toBe(true);
  });

  it('inserts raw_event without launch_id when strategy=none (subscription)', async () => {
    const db = makeNoneStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSubscriptionPayloadNoLead()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    // strategy=none: launch_id must NOT be in payload (resolver returns null → not injected)
    // Per guru.ts: `...(resolvedLaunchId !== null && { launch_id: resolvedLaunchId })`
    expect(payload?.launch_id).toBeUndefined();
  });

  it('inserts raw_event without funnel_role when strategy=none', async () => {
    const db = makeNoneStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSubscriptionPayloadNoLead()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    // strategy=none: funnel_role must not be injected
    expect(payload?.funnel_role).toBeUndefined();
  });

  it('safeLog records guru_launch_resolved with strategy=none (BR-AUDIT-001)', async () => {
    const { safeLog } = await import('../../../../apps/edge/src/middleware/sanitize-logs.js');
    vi.clearAllMocks();

    const db = makeNoneStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSubscriptionPayloadNoLead()),
    });

    const calls = (safeLog as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];
    const resolvedLog = calls.find(([, entry]) => entry.event === 'guru_launch_resolved');

    expect(resolvedLog).toBeDefined();
    const [level, entry] = resolvedLog!;
    expect(level).toBe('info');
    expect(entry.strategy).toBe('none');
    expect(entry.launch_id).toBeNull();

    // BR-PRIVACY-001: no PII
    expect(entry.email).toBeUndefined();
    expect(entry.phone).toBeUndefined();
  });

  it('inserts raw_event with processingStatus=pending for strategy=none', async () => {
    const db = makeNoneStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSubscriptionPayloadNoLead()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];

    expect(lastRow?.processingStatus).toBe('pending');
  });

  it('does NOT store api_token in raw_event payload for strategy=none (BR-PRIVACY-001)', async () => {
    const db = makeNoneStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeSubscriptionPayloadNoLead()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    expect(payload?.api_token).toBeUndefined();
  });

  it('returns 202 for transaction when lead not found by email hint (strategy=none)', async () => {
    // For transaction: product_id not in map, email lookup finds no lead → strategy=none
    const db = makeNoneStrategyDb();
    const app = buildGuruApp(db);

    const res = await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadNoHints()),
    });

    expect(res.status).toBe(202);
  });

  it('inserts raw_event without launch_id for transaction with no lead match', async () => {
    const db = makeNoneStrategyDb();
    const app = buildGuruApp(db);

    await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeTransactionPayloadNoHints()),
    });

    const insertedRows = (db as unknown as { _insertedRawEvents: Record<string, unknown>[] })._insertedRawEvents;
    const lastRow = insertedRows[insertedRows.length - 1];
    const payload = lastRow?.payload as Record<string, unknown>;

    expect(payload?.launch_id).toBeUndefined();
    expect(payload?.funnel_role).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // BR-WEBHOOK-001: invalid/missing token → 400 (workspace not resolved)
  // -------------------------------------------------------------------------

  it('returns 400 when api_token is not in workspaceIntegrations (unauthorized)', async () => {
    const db = makeNoneStrategyDb();
    // Override findFirst to return nothing (unknown token)
    (db as unknown as { query: { workspaceIntegrations: { findFirst: ReturnType<typeof vi.fn> } } })
      .query.workspaceIntegrations.findFirst = vi.fn().mockResolvedValue(null);

    const app = buildGuruApp(db);

    const res = await app.request('/v1/webhook/guru', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhook_type: 'subscription',
        api_token: 'invalid-token-xyz',
        id: 'some-id',
        status: 'active',
        subscriber: { name: 'Test', email: 'test@example.com' },
        product: { id: 'p1', name: 'P1', type: 'subscription' },
        payment: { method: 'credit_card', total: 100, gross: 100, net: 90, currency: 'BRL' },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('unauthorized');

    // BR-PRIVACY-001: no token hint in response
    expect(JSON.stringify(body)).not.toContain('invalid-token-xyz');
  });
});
