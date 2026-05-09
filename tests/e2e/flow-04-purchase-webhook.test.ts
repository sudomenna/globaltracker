/**
 * E2E flow tests — FLOW-04: Registrar Purchase via webhook (Digital Manager Guru)
 *
 * T-ID: T-3-009
 * Spec: docs/60-flows/04-register-purchase-via-webhook.md
 *
 * Tests the Guru inbound webhook adapter end-to-end using in-process
 * Hono route testing (createGuruWebhookRoute(db)) with a stateful mock DB.
 * No real Postgres or external queue required.
 *
 * Scenarios covered:
 *   TC-04-01: Happy path — valid transaction-approved webhook → 202 + raw_event persisted with status=pending
 *   TC-04-02: Invalid api_token → 400 unauthorized (BR-WEBHOOK-001)
 *   TC-04-03: Replay — same webhook delivered twice → both return 202 (idempotent, BR-EVENT-001 / BR-WEBHOOK-003)
 *   TC-04-04: Subscription-active event → 202 + raw_event persisted (subscription webhook accepted)
 *   TC-04-05: eticket webhook → 202 + raw_event stored with status=discarded (Phase 4 skipped)
 *   TC-04-06: Unknown webhook_type → 200 + raw_event stored with status=failed (BR-WEBHOOK-003)
 *   TC-04-07: Missing api_token field → 400 bad request
 *   TC-04-08: api_token not stored in raw_event payload (BR-PRIVACY-001)
 *   TC-04-09: Malformed JSON body → 400 invalid_json
 *
 * BRs applied (cited inline):
 *   BR-WEBHOOK-001: api_token validated in constant time before processing
 *   BR-WEBHOOK-002: event_id derived deterministically from platform transaction id
 *   BR-WEBHOOK-003: non-mappable / unknown events → raw_events.processing_status='failed' + 200
 *   BR-WEBHOOK-004: lead_hints hierarchy (pptc > email > phone > subscriber_email)
 *   BR-EVENT-001: raw_events insert awaited before 202
 *   BR-PRIVACY-001: api_token never stored in raw_events.payload
 *   INV-EVENT-005: Edge persists in raw_events before returning 202
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGuruWebhookRoute } from '../../apps/edge/src/routes/webhooks/guru.js';
import { unwrapJsonb } from '../helpers/jsonb-unwrap.js';
import guruEticketIgnored from '../fixtures/guru/eticket-ignored.json';
import guruSubscriptionActive from '../fixtures/guru/subscription-active.json';
import guruTransactionApproved from '../fixtures/guru/transaction-approved.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppBindings = {
  QUEUE_EVENTS: Queue;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical API token used by the test workspace integration. */
const VALID_API_TOKEN = 'test_token_0000000000000000000000000000000000';
const WORKSPACE_ID = 'ws-f04-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Mock Queue
// ---------------------------------------------------------------------------

function createMockQueue(): Queue & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    async send(msg: unknown): Promise<void> {
      messages.push(msg);
    },
    async sendBatch(msgs: MessageSendRequest[]): Promise<void> {
      for (const m of msgs) messages.push(m.body);
    },
  } as unknown as Queue & { messages: unknown[] };
}

// ---------------------------------------------------------------------------
// Stateful mock DB for Guru webhook route
//
// Supports:
//   - workspaceIntegrations.findFirst → returns workspace integration row
//   - rawEvents.insert → stores rows in memory
// ---------------------------------------------------------------------------

interface RawEventRow {
  id: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  headersSanitized: Record<string, unknown>;
  processingStatus: string;
  processingError: string | null;
}

interface IntegrationRow {
  workspaceId: string;
  guruApiToken: string;
}

function createGuruMockDb(opts: {
  integrationToken?: string | null;
  workspaceId?: string;
}) {
  const rawEventsInserted: RawEventRow[] = [];
  let rowCounter = 0;

  const integrationRow: IntegrationRow | null =
    opts.integrationToken != null
      ? {
          workspaceId: opts.workspaceId ?? WORKSPACE_ID,
          guruApiToken: opts.integrationToken,
        }
      : null;

  const db = {
    // Supports db.query.workspaceIntegrations.findFirst({where: eq(...)})
    query: {
      workspaceIntegrations: {
        findFirst: vi.fn(async (_opts: unknown) => {
          // Return integration if token matches (simulates DB index lookup)
          return integrationRow ?? undefined;
        }),
      },
    },

    // Supports both call patterns emitted by the Guru webhook handler:
    //   (a) await db.insert(table).values({...})               — eticket / unknown_type
    //   (b) db.insert(table).values({...}).returning(fields)   — happy path
    //
    // We eagerly capture the row in .values() and return a Promise subclass
    // that additionally exposes a .returning() method.
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        // Eagerly capture the inserted row regardless of whether .returning() is called.
        const id = `raw-evt-${++rowCounter}`;
        const row: RawEventRow = {
          id,
          workspaceId: values.workspaceId as string,
          // T-13-013: jsonb() helper wraps writes as SQL fragments — unwrap for asserts
          payload:
            (unwrapJsonb(values.payload) as Record<string, unknown>) ?? {},
          headersSanitized:
            (unwrapJsonb(values.headersSanitized) as Record<string, unknown>) ??
            {},
          processingStatus: (values.processingStatus as string) ?? 'pending',
          processingError: (values.processingError as string | null) ?? null,
        };
        rawEventsInserted.push(row);

        // Extend a real Promise so `await db.insert(t).values(v)` resolves,
        // while still allowing `.returning()` for the happy path.
        // Using Object.assign on a resolved Promise avoids the noThenProperty lint
        // rule that fires on object literals with a `then` key.
        const base = Promise.resolve([]);
        // biome-ignore lint/suspicious/noExplicitAny: mock extension — no clean typed way to extend Promise here
        (base as any).returning = (_fields?: unknown) =>
          Promise.resolve([{ id }]);
        // biome-ignore lint/suspicious/noExplicitAny: mock object
        return base as any;
      }),
    })),
  };

  return {
    // biome-ignore lint/suspicious/noExplicitAny: mock object — no real Db type available in tests
    db: db as any,
    rawEventsInserted,
  };
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function buildApp(db: Parameters<typeof createGuruWebhookRoute>[0]) {
  const app = new Hono<{ Bindings: AppBindings }>();
  const queue = createMockQueue();

  app.route('/v1/webhook/guru', createGuruWebhookRoute(db));

  return { app, queue };
}

// Helper: build a Request object for the Guru webhook route.
function makeGuruRequest(
  payload: Record<string, unknown>,
  baseUrl = 'http://localhost',
): Request {
  return new Request(`${baseUrl}/v1/webhook/guru`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('FLOW-04: Guru webhook → raw_event persisted → dispatch queued', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // TC-04-01: Happy path — valid transaction-approved
  // --------------------------------------------------------------------------

  describe('TC-04-01: valid transaction-approved → 202 + raw_event with status=pending', () => {
    it('BR-EVENT-001 / INV-EVENT-005: returns 202 and persists raw_event before responding', async () => {
      const { db, rawEventsInserted } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      const req = makeGuruRequest(
        guruTransactionApproved as Record<string, unknown>,
      );

      const res = await app.request(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(guruTransactionApproved),
      });

      // INV-EVENT-005: Edge returns 202 AFTER raw_event is persisted
      expect(res.status).toBe(202);

      const body = (await res.json()) as Record<string, unknown>;
      expect(body.received).toBe(true);

      // BR-EVENT-001: raw_event inserted before response
      expect(rawEventsInserted).toHaveLength(1);
      const rawEvent = rawEventsInserted[0];
      expect(rawEvent).toBeDefined();
      if (!rawEvent) return;

      // processing_status = 'pending' (awaits ingestion processor)
      expect(rawEvent.processingStatus).toBe('pending');
      expect(rawEvent.workspaceId).toBe(WORKSPACE_ID);
    });

    it('BR-PRIVACY-001: api_token not stored in raw_event payload', async () => {
      const { db, rawEventsInserted } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      await app.request('/v1/webhook/guru', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(guruTransactionApproved),
      });

      expect(rawEventsInserted).toHaveLength(1);
      const rawEvent = rawEventsInserted[0];
      expect(rawEvent).toBeDefined();
      if (!rawEvent) return;

      // BR-PRIVACY-001: api_token MUST NOT be stored in payload
      expect(rawEvent.payload).not.toHaveProperty('api_token');
      // Original fields (minus token) are preserved
      expect(rawEvent.payload).toHaveProperty('webhook_type');
    });

    it('raw_event payload contains _guru_event_id and _guru_event_type derived fields', async () => {
      const { db, rawEventsInserted } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      await app.request('/v1/webhook/guru', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(guruTransactionApproved),
      });

      const rawEvent = rawEventsInserted[0];
      expect(rawEvent).toBeDefined();
      if (!rawEvent) return;

      // Adapter attaches derived fields for processor convenience
      expect(rawEvent.payload).toHaveProperty('_guru_event_id');
      expect(rawEvent.payload).toHaveProperty('_guru_event_type');
      // BR-WEBHOOK-002: event_id is deterministic (derived from transaction id)
      expect(typeof rawEvent.payload._guru_event_id).toBe('string');
      expect((rawEvent.payload._guru_event_id as string).length).toBe(32);
    });
  });

  // --------------------------------------------------------------------------
  // TC-04-02: Invalid api_token → 400 unauthorized
  // --------------------------------------------------------------------------

  describe('TC-04-02: invalid api_token → 400 unauthorized (BR-WEBHOOK-001)', () => {
    it('BR-WEBHOOK-001: wrong token returns 400, no raw_event persisted', async () => {
      const { db, rawEventsInserted } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      const wrongTokenPayload = {
        ...guruTransactionApproved,
        api_token: 'wrong_token_0000000000000000000000000000000',
      };

      const res = await app.request('/v1/webhook/guru', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wrongTokenPayload),
      });

      // BR-WEBHOOK-001: unauthorized — do not hint at whether token exists
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('unauthorized');

      // No raw_event should be persisted for unauthorized requests
      expect(rawEventsInserted).toHaveLength(0);
    });

    it('BR-WEBHOOK-001: no workspace configured for token → 400 unauthorized', async () => {
      // DB returns no integration row (token not found)
      const { db, rawEventsInserted } = createGuruMockDb({
        integrationToken: null, // no workspace has this token
      });

      const { app } = buildApp(db);

      const res = await app.request('/v1/webhook/guru', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(guruTransactionApproved),
      });

      expect(res.status).toBe(400);
      expect(rawEventsInserted).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // TC-04-03: Replay — same webhook delivered twice
  // --------------------------------------------------------------------------

  describe('TC-04-03: replay — same webhook_type+id delivered twice → both 202 (BR-EVENT-001)', () => {
    it('Guru retries: second delivery returns 202 (raw_events has no unique constraint — processor handles dedup)', async () => {
      const { db, rawEventsInserted } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      const reqBody = JSON.stringify(guruTransactionApproved);
      const reqOpts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody,
      };

      // First delivery
      const first = await app.request('/v1/webhook/guru', reqOpts);
      expect(first.status).toBe(202);

      // Second delivery of the same webhook (Guru network retry)
      const reqOpts2 = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: reqBody,
      };
      const second = await app.request('/v1/webhook/guru', reqOpts2);
      expect(second.status).toBe(202);

      // Both insertions are accepted at the raw_event layer
      // Ingestion processor is responsible for idempotency at the events table level
      // (BR-EVENT-002: unique constraint on events(workspace_id, event_id))
      expect(rawEventsInserted).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // TC-04-04: Subscription-active event → 202 + raw_event persisted
  // --------------------------------------------------------------------------

  describe('TC-04-04: subscription-active webhook → 202 + raw_event with status=pending', () => {
    it('subscription events are persisted identically to transaction events', async () => {
      const { db, rawEventsInserted } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      const res = await app.request('/v1/webhook/guru', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(guruSubscriptionActive),
      });

      expect(res.status).toBe(202);
      expect(rawEventsInserted).toHaveLength(1);
      expect(rawEventsInserted[0]?.processingStatus).toBe('pending');
    });
  });

  // --------------------------------------------------------------------------
  // TC-04-05: eticket webhook → 202 + raw_event stored as discarded
  // --------------------------------------------------------------------------

  describe('TC-04-05: eticket webhook → 202 + raw_event status=discarded (Phase 4 skip)', () => {
    it('eticket is accepted but stored as discarded — not processed in Phase 3', async () => {
      const { db, rawEventsInserted } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      const res = await app.request('/v1/webhook/guru', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(guruEticketIgnored),
      });

      // eticket → 202 (not rejected)
      expect(res.status).toBe(202);

      // raw_event inserted with status=discarded (not pending)
      expect(rawEventsInserted).toHaveLength(1);
      expect(rawEventsInserted[0]?.processingStatus).toBe('discarded');
    });
  });

  // --------------------------------------------------------------------------
  // TC-04-06: Unknown webhook_type → 200 + raw_event status=failed (BR-WEBHOOK-003)
  // --------------------------------------------------------------------------

  describe('TC-04-06: unknown webhook_type → 200 (no retry) + raw_event status=failed (BR-WEBHOOK-003)', () => {
    it('BR-WEBHOOK-003: unrecognized webhook_type returns 200 so Guru stops retrying', async () => {
      const { db, rawEventsInserted } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      const unknownPayload = {
        webhook_type: 'mystery_event',
        api_token: VALID_API_TOKEN,
        id: 'some-id-001',
      };

      const res = await app.request('/v1/webhook/guru', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(unknownPayload),
      });

      // BR-WEBHOOK-003: 200 (not 4xx) so provider stops retrying
      expect(res.status).toBe(200);

      // raw_event with status=failed records the unknown type for operator review
      expect(rawEventsInserted).toHaveLength(1);
      expect(rawEventsInserted[0]?.processingStatus).toBe('failed');
      expect(rawEventsInserted[0]?.processingError).toContain('unknown');
    });
  });

  // --------------------------------------------------------------------------
  // TC-04-07: Missing api_token → 400
  // --------------------------------------------------------------------------

  describe('TC-04-07: missing api_token field → 400 (BR-WEBHOOK-001)', () => {
    it('payload without api_token field returns 400 unauthorized', async () => {
      const { db } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      const noTokenPayload = {
        webhook_type: 'transaction',
        id: 'some-id-002',
        status: 'approved',
        // no api_token
      };

      const res = await app.request('/v1/webhook/guru', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(noTokenPayload),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('unauthorized');
    });
  });

  // --------------------------------------------------------------------------
  // TC-04-08: Malformed JSON body → 400 invalid_json
  // --------------------------------------------------------------------------

  describe('TC-04-08: malformed JSON → 400 invalid_json', () => {
    it('request with non-JSON body returns 400 invalid_json', async () => {
      const { db } = createGuruMockDb({
        integrationToken: VALID_API_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      const { app } = buildApp(db);

      const res = await app.request('/v1/webhook/guru', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json {{{',
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('invalid_json');
    });
  });
});

// ---------------------------------------------------------------------------
// FLOW-04 pós-condições documentadas (ingestion processor — Sprint 3 scope)
//
// The ingestion processor (processRawEvent) is exercised separately in
// tests/integration/event/processor-creates-dispatch-jobs.test.ts.
// Below we document what the processor MUST produce for a Guru purchase
// raw_event — these serve as TODOs for when full dispatch integration is wired.
// ---------------------------------------------------------------------------

describe('FLOW-04: post-conditions (ingestion processor scope — see OQ-011)', () => {
  it.todo(
    'Sprint 3: processRawEvent on Guru purchase raw_event creates Purchase event row in events table',
  );
  it.todo(
    'Sprint 3: processRawEvent creates dispatch_job with destination=meta_capi and status=pending',
  );
  it.todo(
    'Sprint 3: replay of same Guru transaction id → unique violation on events(workspace_id, event_id) handled gracefully (BR-EVENT-002)',
  );
  it.todo(
    'Sprint 3: lead associated via email_hash in lead_aliases when lead_public_id absent (BR-WEBHOOK-004)',
  );
});
