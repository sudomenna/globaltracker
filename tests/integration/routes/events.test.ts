/**
 * Integration tests — POST /v1/events
 *
 * CONTRACT-api-events-v1
 * T-ID: T-2-010
 *
 * Covers lead-token-validate middleware:
 *   1. No __ftk cookie → 202 accepted (anonymous event — valid)
 *   2. __ftk cookie present, valid token, matching page → 202 + lead_id injected
 *   3. __ftk cookie present, expired token → 202 accepted anonymously (not rejected)
 *   4. __ftk cookie present, revoked token → 202 accepted anonymously
 *   5. __ftk cookie present, page_token_hash mismatch → 202 accepted anonymously
 *   6. __ftk cookie present, HMAC invalid → 202 accepted anonymously
 *   7. No DB available → 202 accepted anonymously (middleware skips DB lookup)
 *
 * Also covers existing happy-path and validation cases:
 *   8. Valid body → 202 accepted
 *   9. Missing required field → 400 validation_error
 *  10. Invalid JSON → 400 validation_error
 *  11. Duplicate event_id → 202 duplicate_accepted
 *  12. BR-PRIVACY-001: error responses contain no PII
 *
 * Test approach:
 *   - Real Hono app with createEventsRoute mounted.
 *   - DB mocked via simple object implementing the Drizzle query interface.
 *   - Mock QUEUE_EVENTS and GT_KV (in-memory).
 *
 * BR-PRIVACY-001: error responses must not contain PII.
 * BR-IDENTITY-005: __ftk cookie value never logged.
 * INV-IDENTITY-006: page_token_hash enforced in validateLeadToken.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEventsRoute } from '../../../apps/edge/src/routes/events.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
  LEAD_TOKEN_SECRET?: string;
  LEAD_TOKEN_HMAC_SECRET?: string;
};

type Variables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
  lead_id?: string;
};

// ---------------------------------------------------------------------------
// Mock KV
// ---------------------------------------------------------------------------

function createMockKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
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
  } as unknown as KVNamespace & { store: Map<string, string> };
}

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
// Mock DB for validateLeadToken
// ---------------------------------------------------------------------------

interface MockTokenRow {
  id: string;
  leadId: string;
  workspaceId: string;
  pageTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

function createMockDb(tokenRow?: MockTokenRow | null) {
  // The mock intercepts db.select().from().where().limit() chain calls
  // returning the provided tokenRow or empty array.
  // Also intercepts db.update().set().where() for last_used_at.

  const mock = {
    _updateCalled: false,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (tokenRow ? [tokenRow] : []),
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          mock._updateCalled = true;
          return [];
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: async () => [],
      }),
    }),
  };

  // biome-ignore lint/suspicious/noExplicitAny: mock object — no real Db type available in tests
  return mock as any;
}

// ---------------------------------------------------------------------------
// SHA-256 helper (mirrors lead-token.ts implementation)
// ---------------------------------------------------------------------------

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// HMAC token generator (mirrors generateLeadToken logic for test setup)
// ---------------------------------------------------------------------------

const TEST_HMAC_SECRET = 'test-hmac-secret-for-events-integration';
const TEST_WORKSPACE_ID = 'ws-events-test-001';
const TEST_PAGE_TOKEN = 'pk_live_test_page_token_abc123';
const TEST_LEAD_ID = '00000000-0000-0000-0000-000000000001';
const PAGE_TOKEN_HASH_PROMISE = sha256Hex(TEST_PAGE_TOKEN);

/** Generate a real HMAC token using the same logic as generateLeadToken. */
async function generateTestToken(
  leadId: string,
  workspaceId: string,
  secretStr: string,
): Promise<string> {
  const { generateLeadToken } = await import(
    '../../../apps/edge/src/lib/lead-token.js'
  );
  const secret = new TextEncoder().encode(secretStr);
  const result = await generateLeadToken(leadId, workspaceId, secret);
  if (!result.ok) throw new Error('Failed to generate test token');
  return result.value;
}

/** Compute SHA-256 hex of a token (mirrors issueLeadToken DB storage). */
async function sha256TokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function buildApp(options: {
  workspaceId?: string;
  pageId?: string;
  requestId?: string;
  kv?: KVNamespace;
  queue?: Queue;
  // biome-ignore lint/suspicious/noExplicitAny: mock db — no real Db type available in tests
  db?: any;
}) {
  const kv = options.kv ?? createMockKv();
  const queue = options.queue ?? createMockQueue();

  const eventsRoute = createEventsRoute(undefined, options.db);

  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Simulate upstream middleware
  app.use('/v1/events/*', async (c, next) => {
    if (options.workspaceId !== undefined) {
      c.set('workspace_id', options.workspaceId);
    }
    c.set('page_id', options.pageId ?? 'pg-events-test');
    c.set('request_id', options.requestId ?? 'req-test-001');
    await next();
  });

  app.route('/v1/events', eventsRoute);

  const mockEnv: Bindings = {
    GT_KV: kv,
    QUEUE_EVENTS: queue,
    QUEUE_DISPATCH: {} as Queue,
    ENVIRONMENT: 'test',
    LEAD_TOKEN_HMAC_SECRET: TEST_HMAC_SECRET,
    LEAD_TOKEN_SECRET: TEST_HMAC_SECRET,
  };

  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      return app.fetch(request, mockEnv);
    },
    queue: queue as Queue & { messages: unknown[] },
    kv: kv as KVNamespace & { store: Map<string, string> },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EVENTS_URL = 'http://localhost/v1/events';

const VALID_BODY = {
  event_id: 'evt-events-test-001',
  schema_version: 1,
  launch_public_id: 'launch-test-xyz',
  page_public_id: 'page-test-abc',
  event_name: 'PageView',
  event_time: new Date().toISOString(),
  attribution: {},
  custom_data: {},
  consent: { analytics: true, marketing: false, functional: true },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/events — lead-token-validate middleware (T-2-010)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 1: No __ftk cookie → 202 anonymous (valid)
  // -------------------------------------------------------------------------
  it('202: accepts event anonymously when no __ftk cookie', async () => {
    const queue = createMockQueue();
    const app = buildApp({
      workspaceId: TEST_WORKSPACE_ID,
      queue,
    });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, event_id: 'evt-anon-001' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(body.event_id).toBe('evt-anon-001');

    // Queued message should NOT have lead_id
    expect(queue.messages.length).toBeGreaterThan(0);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg).not.toHaveProperty('lead_id');
  });

  // -------------------------------------------------------------------------
  // Case 2: Valid __ftk cookie + matching page → 202 + lead_id injected
  // -------------------------------------------------------------------------
  it('202: accepts event with lead_id injected when __ftk is valid', async () => {
    const pageTokenHash = await PAGE_TOKEN_HASH_PROMISE;
    const tokenClear = await generateTestToken(
      TEST_LEAD_ID,
      TEST_WORKSPACE_ID,
      TEST_HMAC_SECRET,
    );
    const tokenHash = await sha256TokenHash(tokenClear);

    const tokenRow: MockTokenRow = {
      id: 'lt-row-001',
      leadId: TEST_LEAD_ID,
      workspaceId: TEST_WORKSPACE_ID,
      pageTokenHash,
      expiresAt: new Date(Date.now() + 86400_000), // 1 day from now
      revokedAt: null,
    };

    const queue = createMockQueue();
    const db = createMockDb(tokenRow);
    void tokenHash; // token_hash used internally by validateLeadToken

    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID, queue, db });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `__ftk=${tokenClear}`,
        'x-funil-site': TEST_PAGE_TOKEN,
      },
      body: JSON.stringify({ ...VALID_BODY, event_id: 'evt-with-lead-001' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');

    // Queued message should include lead_id
    expect(queue.messages.length).toBeGreaterThan(0);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg).toHaveProperty('lead_id', TEST_LEAD_ID);
  });

  // -------------------------------------------------------------------------
  // Case 3: Expired token → 202 accepted anonymously (not rejected)
  // -------------------------------------------------------------------------
  it('202: accepts anonymously when __ftk token is expired', async () => {
    const pageTokenHash = await PAGE_TOKEN_HASH_PROMISE;
    const tokenClear = await generateTestToken(
      TEST_LEAD_ID,
      TEST_WORKSPACE_ID,
      TEST_HMAC_SECRET,
    );

    const expiredRow: MockTokenRow = {
      id: 'lt-row-expired',
      leadId: TEST_LEAD_ID,
      workspaceId: TEST_WORKSPACE_ID,
      pageTokenHash,
      expiresAt: new Date(Date.now() - 1000), // expired 1 second ago
      revokedAt: null,
    };

    const queue = createMockQueue();
    const db = createMockDb(expiredRow);
    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID, queue, db });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `__ftk=${tokenClear}`,
        'x-funil-site': TEST_PAGE_TOKEN,
      },
      body: JSON.stringify({ ...VALID_BODY, event_id: 'evt-expired-001' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');

    // Queued message should NOT have lead_id (anonymous fallback)
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg).not.toHaveProperty('lead_id');
  });

  // -------------------------------------------------------------------------
  // Case 4: Revoked token → 202 accepted anonymously
  // -------------------------------------------------------------------------
  it('202: accepts anonymously when __ftk token is revoked', async () => {
    const pageTokenHash = await PAGE_TOKEN_HASH_PROMISE;
    const tokenClear = await generateTestToken(
      TEST_LEAD_ID,
      TEST_WORKSPACE_ID,
      TEST_HMAC_SECRET,
    );

    const revokedRow: MockTokenRow = {
      id: 'lt-row-revoked',
      leadId: TEST_LEAD_ID,
      workspaceId: TEST_WORKSPACE_ID,
      pageTokenHash,
      expiresAt: new Date(Date.now() + 86400_000),
      revokedAt: new Date(), // revoked
    };

    const queue = createMockQueue();
    const db = createMockDb(revokedRow);
    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID, queue, db });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `__ftk=${tokenClear}`,
        'x-funil-site': TEST_PAGE_TOKEN,
      },
      body: JSON.stringify({ ...VALID_BODY, event_id: 'evt-revoked-001' }),
    });

    expect(res.status).toBe(202);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg).not.toHaveProperty('lead_id');
  });

  // -------------------------------------------------------------------------
  // Case 5: page_token_hash mismatch → 202 accepted anonymously
  // INV-IDENTITY-006: token from different page is invalid here
  // -------------------------------------------------------------------------
  it('202: accepts anonymously when __ftk page_token_hash mismatches current page', async () => {
    const differentPageHash = await sha256Hex('pk_live_different_page_token');
    const tokenClear = await generateTestToken(
      TEST_LEAD_ID,
      TEST_WORKSPACE_ID,
      TEST_HMAC_SECRET,
    );

    const mismatchRow: MockTokenRow = {
      id: 'lt-row-mismatch',
      leadId: TEST_LEAD_ID,
      workspaceId: TEST_WORKSPACE_ID,
      pageTokenHash: differentPageHash, // different page
      expiresAt: new Date(Date.now() + 86400_000),
      revokedAt: null,
    };

    const queue = createMockQueue();
    const db = createMockDb(mismatchRow);
    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID, queue, db });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `__ftk=${tokenClear}`,
        'x-funil-site': TEST_PAGE_TOKEN, // request from the original page
      },
      body: JSON.stringify({ ...VALID_BODY, event_id: 'evt-mismatch-001' }),
    });

    expect(res.status).toBe(202);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg).not.toHaveProperty('lead_id');
  });

  // -------------------------------------------------------------------------
  // Case 6: HMAC invalid cookie value → 202 accepted anonymously
  // -------------------------------------------------------------------------
  it('202: accepts anonymously when __ftk has invalid HMAC signature', async () => {
    const queue = createMockQueue();
    const db = createMockDb(null); // no DB row needed — HMAC fails first
    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID, queue, db });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__ftk=tampered.invalidsignature',
        'x-funil-site': TEST_PAGE_TOKEN,
      },
      body: JSON.stringify({ ...VALID_BODY, event_id: 'evt-hmac-invalid-001' }),
    });

    expect(res.status).toBe(202);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg).not.toHaveProperty('lead_id');
  });

  // -------------------------------------------------------------------------
  // Case 7: No DB available → 202 accepted anonymously
  // -------------------------------------------------------------------------
  it('202: accepts anonymously when no DB is wired (middleware skips)', async () => {
    const queue = createMockQueue();
    // No db parameter → middleware passes through
    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID, queue });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__ftk=sometoken.signature',
        'x-funil-site': TEST_PAGE_TOKEN,
      },
      body: JSON.stringify({ ...VALID_BODY, event_id: 'evt-nodb-001' }),
    });

    expect(res.status).toBe(202);
    const msg = queue.messages[0] as Record<string, unknown>;
    expect(msg).not.toHaveProperty('lead_id');
  });
});

describe('POST /v1/events — existing validations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 8: Valid body → 202 accepted
  // -------------------------------------------------------------------------
  it('202: accepts valid event payload', async () => {
    const kv = createMockKv();
    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID, kv });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, event_id: 'evt-valid-001' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(body.event_id).toBe('evt-valid-001');
  });

  // -------------------------------------------------------------------------
  // Case 9: Missing required field → 400 validation_error
  // -------------------------------------------------------------------------
  it('400: returns validation_error for missing required field', async () => {
    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID });

    const { event_name: _omit, ...bodyMissingEventName } = VALID_BODY;

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...bodyMissingEventName,
        event_id: 'evt-missing-001',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('validation_error');
    // BR-PRIVACY-001: no PII in error details
    expect(JSON.stringify(body)).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // Case 10: Invalid JSON → 400 validation_error
  // -------------------------------------------------------------------------
  it('400: returns validation_error for invalid JSON', async () => {
    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // Case 11: Duplicate event_id → 202 duplicate_accepted
  // BR-EVENT-003: replay protection via KV
  // -------------------------------------------------------------------------
  it('202: returns duplicate_accepted for replayed event_id', async () => {
    const kv = createMockKv();
    // Pre-seed the KV store with the event_id to simulate a replay
    kv.store.set(`replay:${TEST_WORKSPACE_ID}:evt-dup-001`, '1');

    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID, kv });

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...VALID_BODY, event_id: 'evt-dup-001' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('duplicate_accepted');
  });

  // -------------------------------------------------------------------------
  // Case 12: BR-PRIVACY-001 — error responses contain no PII
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: validation error responses contain no PII', async () => {
    const app = buildApp({ workspaceId: TEST_WORKSPACE_ID });

    const bodyWithPii = {
      ...VALID_BODY,
      event_id: 'evt-pii-test-001',
      email: 'private@example.com', // extra unknown field — .strict() should reject
      event_name: undefined, // missing required
    };

    const res = await app.fetch(EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyWithPii),
    });

    const text = await res.text();
    // BR-PRIVACY-001: no email in error response
    expect(text).not.toContain('private@example.com');
    expect(text).not.toMatch(/@[a-zA-Z]/);
  });
});
