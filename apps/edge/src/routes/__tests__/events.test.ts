/**
 * Integration tests — POST /v1/events route
 *
 * T-ID: T-1-017
 * CONTRACT-id: CONTRACT-api-events-v1
 *
 * Covers:
 *   - Happy path: valid payload → 202 accepted
 *   - Duplicate event_id (replay) → 202 duplicate_accepted
 *   - Invalid JSON → 400 validation_error
 *   - Zod validation failure (missing required field) → 400 validation_error
 *   - lead_token + lead_id together → 400 validation_error (refine)
 *   - lead_token HMAC invalid → 401 invalid_lead_token
 *   - event_time far in the past → 202 accepted (clamped transparently)
 *   - Valid lead_token → 202 accepted
 *   - Unknown extra field (.strict()) → 400
 *
 * BR-PRIVACY-001: error responses contain no PII.
 * BR-EVENT-002: event_time clamped, never rejected.
 * BR-EVENT-003: duplicate event_id → 202 duplicate_accepted.
 * BR-EVENT-004: lead_token HMAC validated; invalid → 401.
 * INV-EVENT-003: KV replay protection tested.
 * INV-EVENT-005: insert function awaited before 202 (verified via mock call tracking).
 *
 * Does NOT require a real DB or Cloudflare environment — uses mock KV + Queue.
 * Bindings passed via app.fetch(request, mockEnv) following config.test.ts pattern.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { generateLeadToken } from '../../lib/lead-token.js';
import { type InsertRawEventFn, createEventsRoute } from '../events.js';

// ---------------------------------------------------------------------------
// Types (mirror apps/edge/src/index.ts)
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
  LEAD_TOKEN_SECRET?: string;
};

type Variables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

// ---------------------------------------------------------------------------
// In-memory KV mock
// ---------------------------------------------------------------------------

function createMockKV(
  initial: Record<string, string> = {},
): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial));

  const kv = {
    store,
    async get<T = unknown>(
      key: string,
      options?: { type?: string } | string,
    ): Promise<T | null> {
      const raw = store.get(key);
      if (raw === undefined) return null;
      const type = typeof options === 'object' ? options.type : options;
      if (type === 'json') return JSON.parse(raw) as T;
      return raw as unknown as T;
    },
    async put(
      key: string,
      value: string,
      _options?: { expirationTtl?: number },
    ): Promise<void> {
      store.set(key, value);
    },
    async delete(_key: string): Promise<void> {},
    async list<M = unknown>(
      _options?: unknown,
    ): Promise<{
      keys: Array<{ name: string; expiration?: number; metadata?: M }>;
      list_complete: boolean;
      cursor?: string;
    }> {
      return { keys: [], list_complete: true };
    },
    async getWithMetadata<T = unknown, M = unknown>(
      key: string,
      options?: { type?: string } | string,
    ): Promise<{ value: T | null; metadata: M | null }> {
      // biome-ignore lint/suspicious/noExplicitAny: mock; options type loosened for test harness
      const value = await kv.get<T>(key, options as unknown as any);
      return { value, metadata: null };
    },
  } as unknown as KVNamespace & { store: Map<string, string> };

  return kv;
}

// ---------------------------------------------------------------------------
// In-memory Queue mock
// ---------------------------------------------------------------------------

function createMockQueue(): Queue & { messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    messages,
    send: async (msg: unknown) => {
      messages.push(msg);
    },
    sendBatch: async (batch: unknown[]) => {
      messages.push(...batch);
    },
  } as unknown as Queue & { messages: unknown[] };
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

/**
 * Build a Hono test app that:
 *   1. Injects workspace_id + page_id + request_id into context (simulating middleware).
 *   2. Mounts the events route under /.
 *   3. Returns a fetch-compatible function that passes mock bindings.
 */
function buildApp(options: {
  kv?: KVNamespace & { store?: Map<string, string> };
  queue?: Queue & { messages?: unknown[] };
  leadTokenSecret?: string;
  insertRawEvent?: InsertRawEventFn;
  workspaceId?: string;
  pageId?: string;
  requestId?: string;
}) {
  const kv = options.kv ?? createMockKV();
  const queue = options.queue ?? createMockQueue();
  const workspaceId = options.workspaceId ?? 'ws-test-0001';
  const pageId = options.pageId ?? 'pg-test-0001';
  const requestId = options.requestId ?? 'req-test-0001';

  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Simulate auth + sanitize-logs middleware setting context variables
  app.use('*', async (c, next) => {
    c.set('workspace_id', workspaceId);
    c.set('page_id', pageId);
    c.set('request_id', requestId);
    await next();
  });

  app.route('/', createEventsRoute(options.insertRawEvent));

  const mockEnv: Bindings = {
    GT_KV: kv,
    QUEUE_EVENTS: queue,
    QUEUE_DISPATCH: {} as Queue,
    ENVIRONMENT: 'test',
    ...(options.leadTokenSecret !== undefined
      ? { LEAD_TOKEN_SECRET: options.leadTokenSecret }
      : {}),
  };

  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      return app.fetch(request, mockEnv);
    },
    kv,
    queue: queue as Queue & { messages: unknown[] },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVENTS_URL = 'http://localhost/';

function validPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    event_id: `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    schema_version: 1,
    launch_public_id: 'launch-abc',
    page_public_id: 'page-xyz',
    event_name: 'PageView',
    event_time: new Date().toISOString(),
    attribution: {},
    custom_data: {},
    consent: { analytics: true, marketing: false, functional: true },
    ...overrides,
  };
}

function postEvent(
  fetchFn: ReturnType<typeof buildApp>['fetch'],
  payload: unknown,
) {
  return fetchFn(EVENTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/events', () => {
  // -------------------------------------------------------------------------
  // Happy path — 202 accepted
  // -------------------------------------------------------------------------
  it('returns 202 with status=accepted for a valid event payload', async () => {
    const { fetch } = buildApp({});
    const payload = validPayload();

    const res = await postEvent(fetch, payload);

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(typeof body.event_id).toBe('string');
    expect(body.request_id).toBe('req-test-0001');
    // CONTRACT-api-events-v1: X-Request-Id in response headers
    expect(res.headers.get('X-Request-Id')).toBe('req-test-0001');
  });

  // -------------------------------------------------------------------------
  // Event gets enqueued on happy path
  // -------------------------------------------------------------------------
  it('enqueues a message to QUEUE_EVENTS on successful accept', async () => {
    const queue = createMockQueue();
    const { fetch } = buildApp({ queue });
    const payload = validPayload();

    await postEvent(fetch, payload);

    expect(queue.messages).toHaveLength(1);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg.event_id).toBe((payload as Record<string, unknown>).event_id);
    expect(msg.workspace_id).toBe('ws-test-0001');
  });

  // -------------------------------------------------------------------------
  // InsertRawEventFn is called when provided (INV-EVENT-005)
  // -------------------------------------------------------------------------
  it('calls insertRawEvent and awaits it before returning 202 — INV-EVENT-005', async () => {
    const insertCalls: unknown[] = [];
    const insertRawEvent: InsertRawEventFn = async (params) => {
      insertCalls.push(params);
      return { id: 'test-raw-event-id' };
    };
    const { fetch } = buildApp({ insertRawEvent });
    const payload = validPayload();

    const res = await postEvent(fetch, payload);

    expect(res.status).toBe(202);
    expect(insertCalls).toHaveLength(1);
    const call = insertCalls[0] as Record<string, unknown>;
    expect(call.workspaceId).toBe('ws-test-0001');
  });

  // -------------------------------------------------------------------------
  // Replay protection — 202 duplicate_accepted
  // INV-EVENT-003: same event_id within 7d window → duplicate_accepted
  // BR-EVENT-003: no new insert; idempotent
  // -------------------------------------------------------------------------
  it('returns 202 with status=duplicate_accepted for a duplicate event_id — INV-EVENT-003', async () => {
    const eventId = `evt-replay-${Date.now()}`;
    const kv = createMockKV({
      [`replay:ws-test-0001:${eventId}`]: '1',
    });
    const { fetch } = buildApp({ kv });

    const payload = validPayload({ event_id: eventId });
    const res = await postEvent(fetch, payload);

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    // BR-EVENT-003: replay returns duplicate_accepted, not error
    expect(body.status).toBe('duplicate_accepted');
    expect(body.event_id).toBe(eventId);
  });

  // -------------------------------------------------------------------------
  // Replay protection — second identical request also returns duplicate_accepted
  // -------------------------------------------------------------------------
  it('marks event as seen after first accept so second call returns duplicate_accepted', async () => {
    const kv = createMockKV();
    const { fetch } = buildApp({ kv });
    const payload = validPayload();

    const res1 = await postEvent(fetch, payload);
    const res2 = await postEvent(fetch, payload);

    expect(res1.status).toBe(202);
    const body1 = (await res1.json()) as Record<string, unknown>;
    expect(body1.status).toBe('accepted');

    expect(res2.status).toBe(202);
    const body2 = (await res2.json()) as Record<string, unknown>;
    // BR-EVENT-003: second request with same event_id → duplicate_accepted
    expect(body2.status).toBe('duplicate_accepted');
  });

  // -------------------------------------------------------------------------
  // Invalid JSON body → 400
  // -------------------------------------------------------------------------
  it('returns 400 validation_error for invalid JSON body', async () => {
    const { fetch } = buildApp({});

    const res = await fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-valid-json{{{',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('validation_error');
    expect(body.details).toBe('invalid json');
    // BR-PRIVACY-001: no PII in error
    expect(JSON.stringify(body)).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // Zod validation failure — missing required field → 400
  // -------------------------------------------------------------------------
  it('returns 400 validation_error when required field event_name is missing', async () => {
    const { fetch } = buildApp({});
    const payloadObj = validPayload() as Record<string, unknown>;
    payloadObj.event_name = undefined;

    const res = await postEvent(fetch, payloadObj);

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('validation_error');
    expect(body.details).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // lead_token + lead_id together → 400 (Zod refine)
  // BR-EVENT-004: mutually exclusive
  // -------------------------------------------------------------------------
  it('returns 400 when lead_token and lead_id are both provided — BR-EVENT-004', async () => {
    const { fetch } = buildApp({});
    const payload = validPayload({
      lead_token: 'some-token',
      lead_id: '550e8400-e29b-41d4-a716-446655440000',
    });

    const res = await postEvent(fetch, payload);

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // lead_token with wrong workspace → 401
  // BR-EVENT-004: HMAC validation mandatory; workspace mismatch fails
  // -------------------------------------------------------------------------
  it('returns 401 invalid_lead_token when lead_token workspace does not match — BR-EVENT-004', async () => {
    const secret = 'test-secret-key';
    const { fetch } = buildApp({ leadTokenSecret: secret });

    // Generate a valid token for a DIFFERENT workspace
    const secretBytes = new TextEncoder().encode(secret);
    const tokenResult = await generateLeadToken(
      '550e8400-e29b-41d4-a716-446655440000',
      'ws-OTHER-workspace', // wrong workspace — handler has 'ws-test-0001'
      secretBytes,
    );
    if (!tokenResult.ok) throw new Error('Failed to generate token in test');

    const payload = validPayload({ lead_token: tokenResult.value });
    const res = await postEvent(fetch, payload);

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_lead_token');
    // BR-PRIVACY-001: token value must not appear in response
    expect(JSON.stringify(body)).not.toContain(tokenResult.value);
  });

  // -------------------------------------------------------------------------
  // Malformed lead_token (not parseable) → 401
  // -------------------------------------------------------------------------
  it('returns 401 for a malformed lead_token string — BR-EVENT-004', async () => {
    const { fetch } = buildApp({ leadTokenSecret: 'some-secret' });
    const payload = validPayload({ lead_token: 'notavalidtoken' });

    const res = await postEvent(fetch, payload);

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_lead_token');
  });

  // -------------------------------------------------------------------------
  // event_time far in the past → 202 accepted (clamp transparent, never rejects)
  // BR-EVENT-002: clamp is silent; INV-EVENT-002: no rejection for old timestamps
  // -------------------------------------------------------------------------
  it('accepts event with event_time far in the past — clamp transparent, 202 returned — BR-EVENT-002', async () => {
    const { fetch } = buildApp({});
    const payload = validPayload({
      event_time: '2020-01-01T00:00:00.000Z', // very old — will be clamped
    });

    const res = await postEvent(fetch, payload);

    // BR-EVENT-002: clamped transparently; event still accepted
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
  });

  // -------------------------------------------------------------------------
  // Valid lead_token (correct workspace, correct HMAC) → 202 accepted
  // BR-EVENT-004: valid HMAC passes validation
  // -------------------------------------------------------------------------
  it('accepts event with a valid lead_token HMAC — BR-EVENT-004', async () => {
    const secret = 'test-secret-key-valid';
    const { fetch } = buildApp({ leadTokenSecret: secret });

    const secretBytes = new TextEncoder().encode(secret);
    const tokenResult = await generateLeadToken(
      '550e8400-e29b-41d4-a716-446655440001',
      'ws-test-0001', // matches context workspace_id
      secretBytes,
    );
    if (!tokenResult.ok) throw new Error('Failed to generate token in test');

    const payload = validPayload({ lead_token: tokenResult.value });
    const res = await postEvent(fetch, payload);

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
  });

  // -------------------------------------------------------------------------
  // Unknown extra field rejected (.strict())
  // -------------------------------------------------------------------------
  it('returns 400 for unknown extra fields (.strict() enforcement)', async () => {
    const { fetch } = buildApp({});
    const payload = validPayload({ unknown_field: 'should_fail' });

    const res = await postEvent(fetch, payload);

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // X-Request-Id present in all responses
  // -------------------------------------------------------------------------
  it('includes X-Request-Id header in 202 response', async () => {
    const { fetch } = buildApp({});
    const res = await postEvent(fetch, validPayload());
    expect(res.headers.get('X-Request-Id')).toBe('req-test-0001');
  });

  it('includes X-Request-Id header in 400 response', async () => {
    const { fetch } = buildApp({});
    const res = await fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'bad-json',
    });
    expect(res.headers.get('X-Request-Id')).toBe('req-test-0001');
  });
});
