/**
 * Integration tests — POST /v1/lead
 *
 * CONTRACT-api-lead-v1
 * T-ID: T-2-009, T-2-008
 *
 * Covers Turnstile bot mitigation (ADR-024):
 *   1. Token absent + ENVIRONMENT=development → 202 bypass
 *   2. Token absent + ENVIRONMENT=production  → 403 bot_detected
 *   3. Token invalid (siteverify returns success=false) → 403 bot_detected
 *   4. Token valid (siteverify returns success=true) → 202 accepted
 *
 * Covers T-2-008 — issueLeadToken real DB path:
 *   9.  DB provided → resolveLeadByAliases + issueLeadToken → 202 with real token
 *  10.  DB resolve error → 500 internal_error
 *  11.  DB issue error → 500 internal_error
 *  12.  No DB → falls back to temporary token (warn logged) → 202
 *
 * Also covers existing happy-path and validation cases:
 *   5. Valid body (no Turnstile binding configured) → 202 accepted
 *   6. Missing identifier (no email/phone) → 400 missing_identifier
 *   7. Invalid JSON → 400 validation_error
 *   8. BR-PRIVACY-001: 403 response contains no PII
 *
 * Test approach:
 *   - Real Hono app with createLeadRoute(db) mounted.
 *   - fetch() mocked at global level for siteverify calls only.
 *   - Mock QUEUE_EVENTS (in-memory implementation).
 *   - DB mocked where needed.
 *
 * BR-PRIVACY-001: error responses must not echo back PII (email/phone).
 * ADR-024: Turnstile as primary bot mitigation.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLeadRoute,
  leadRoute,
} from '../../../apps/edge/src/routes/lead.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
  LEAD_TOKEN_HMAC_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
};

type Variables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

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
// App builder
// ---------------------------------------------------------------------------

function buildApp(options: {
  environment?: string;
  turnstileSecretKey?: string;
  workspaceId?: string;
  pageId?: string;
  requestId?: string;
  queue?: Queue;
  // biome-ignore lint/suspicious/noExplicitAny: mock db — no real Db type in tests
  db?: any;
}) {
  const mockQueue = options.queue ?? createMockQueue();

  // When db is provided, use the factory to wire it; otherwise use default export.
  const route =
    options.db !== undefined ? createLeadRoute(options.db) : leadRoute;

  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Simulate upstream middleware setting context variables
  app.use('/v1/lead/*', async (c, next) => {
    if (options.workspaceId !== undefined) {
      c.set('workspace_id', options.workspaceId);
    }
    if (options.pageId !== undefined) {
      c.set('page_id', options.pageId);
    }
    c.set('request_id', options.requestId ?? 'test-req-id');
    await next();
  });

  app.route('/v1/lead', route);

  const mockEnv: Bindings = {
    GT_KV: {} as KVNamespace,
    QUEUE_EVENTS: mockQueue,
    QUEUE_DISPATCH: {} as Queue,
    ENVIRONMENT: options.environment ?? 'production',
    ...(options.turnstileSecretKey !== undefined
      ? { TURNSTILE_SECRET_KEY: options.turnstileSecretKey }
      : {}),
  };

  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      return app.fetch(request, mockEnv);
    },
    queue: mockQueue as Queue & { messages: unknown[] },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-test-111';
const PAGE_ID = 'pg-test-222';
const LEAD_URL = 'http://localhost/v1/lead';

const VALID_BODY = {
  event_id: 'evt-abc-123',
  schema_version: 1,
  launch_public_id: 'launch-test-xyz',
  page_public_id: 'page-test-abc',
  email: 'user@example.com',
  attribution: {},
  consent: { analytics: false, marketing: false, functional: true },
};

const TURNSTILE_SECRET = 'test-turnstile-secret-key';
const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// ---------------------------------------------------------------------------
// Siteverify fetch mock helpers
// ---------------------------------------------------------------------------

function mockSiteverifySuccess() {
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url === SITEVERIFY_URL) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch to: ${url}`);
  });
}

function mockSiteverifyFailure(
  errorCodes: string[] = ['invalid-input-response'],
) {
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (url === SITEVERIFY_URL) {
      return new Response(
        JSON.stringify({ success: false, error_codes: errorCodes }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    throw new Error(`Unexpected fetch to: ${url}`);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/lead — Turnstile bot mitigation (ADR-024)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 1: Token absent + ENVIRONMENT=development → 202 bypass
  // -------------------------------------------------------------------------
  it('202: bypasses Turnstile when token absent and ENVIRONMENT=development', async () => {
    // ADR-024: dev bypass — token absent in development is accepted
    const app = buildApp({
      environment: 'development',
      turnstileSecretKey: TURNSTILE_SECRET,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No cf_turnstile_response field
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(body.lead_public_id).toBeTruthy();
    expect(body.lead_token).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Case 2: Token absent + ENVIRONMENT=production → 403 bot_detected
  // -------------------------------------------------------------------------
  it('403: rejects when token is absent and ENVIRONMENT=production', async () => {
    // ADR-024: token required in non-development environments
    // BR-PRIVACY-001: response must not include PII
    const app = buildApp({
      environment: 'production',
      turnstileSecretKey: TURNSTILE_SECRET,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // No cf_turnstile_response field
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('bot_detected');
    expect(body.message).toBe('Bot verification failed.');
    expect(body.request_id).toBeTruthy();

    // BR-PRIVACY-001: no PII in error response
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('user@example.com');
    expect(bodyStr).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // Case 3: Token invalid (siteverify returns success=false) → 403 bot_detected
  // -------------------------------------------------------------------------
  it('403: rejects when siteverify returns success=false', async () => {
    // ADR-024: invalid token → 403 bot_detected
    mockSiteverifyFailure(['invalid-input-response']);

    const app = buildApp({
      environment: 'production',
      turnstileSecretKey: TURNSTILE_SECRET,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        cf_turnstile_response: 'invalid-token-value',
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('bot_detected');
    expect(body.message).toBe('Bot verification failed.');
    expect(body.request_id).toBeTruthy();

    // BR-PRIVACY-001: no PII in error response
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('user@example.com');
    expect(bodyStr).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // Case 4: Token valid (siteverify returns success=true) → 202 accepted
  // -------------------------------------------------------------------------
  it('202: accepts lead when siteverify returns success=true', async () => {
    // ADR-024: valid token passes through to 202
    mockSiteverifySuccess();

    const app = buildApp({
      environment: 'production',
      turnstileSecretKey: TURNSTILE_SECRET,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        cf_turnstile_response: 'valid-token-value',
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(body.lead_public_id).toBeTruthy();
    expect(body.lead_token).toBeTruthy();
    expect(body.expires_at).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Case 4b: cf_turnstile_response must NOT appear in queued payload
  // -------------------------------------------------------------------------
  it('strips cf_turnstile_response from queued payload (ADR-024)', async () => {
    // ADR-024: mitigation field is not a business field — must be stripped
    mockSiteverifySuccess();

    const queue = createMockQueue();
    const app = buildApp({
      environment: 'production',
      turnstileSecretKey: TURNSTILE_SECRET,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
      queue,
    });

    await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...VALID_BODY,
        cf_turnstile_response: 'valid-token-value',
      }),
    });

    expect(queue.messages.length).toBeGreaterThan(0);
    const msg = queue.messages[0] as Record<string, unknown>;
    const payload = msg.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('cf_turnstile_response');
  });
});

describe('POST /v1/lead — existing validations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 5: No Turnstile binding → bypass → 202 accepted
  // -------------------------------------------------------------------------
  it('202: accepts lead when no TURNSTILE_SECRET_KEY binding configured', async () => {
    // shouldBypassTurnstile returns true when binding is absent
    const app = buildApp({
      environment: 'production',
      // No turnstileSecretKey → binding absent
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
  });

  // -------------------------------------------------------------------------
  // Case 6: Missing identifier (no email/phone) → 400 missing_identifier
  // -------------------------------------------------------------------------
  it('400: returns missing_identifier when neither email nor phone provided', async () => {
    // BR-IDENTITY-005: at least one of email or phone is required
    const app = buildApp({
      environment: 'development',
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const bodyNoIdentifier = {
      event_id: 'evt-no-id',
      schema_version: 1,
      launch_public_id: 'launch-xyz',
      page_public_id: 'page-abc',
      // No email, no phone
      attribution: {},
      consent: { analytics: false, marketing: false, functional: true },
    };

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyNoIdentifier),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('missing_identifier');
    expect(body.request_id).toBeTruthy();

    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // Case 7: Invalid JSON → 400 validation_error
  // -------------------------------------------------------------------------
  it('400: returns validation_error when body is not valid JSON', async () => {
    const app = buildApp({
      environment: 'development',
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
    expect(body.message).toBe('Request body must be valid JSON.');
    expect(body.request_id).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Case 8: 401 — workspace_id absent from context
  // -------------------------------------------------------------------------
  it('401: returns unauthorized when workspace_id is missing from context', async () => {
    const app = buildApp({
      environment: 'development',
      // workspaceId intentionally omitted
      pageId: PAGE_ID,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('unauthorized');
    // BR-PRIVACY-001: no PII in response
    expect(JSON.stringify(body)).not.toContain('user@example.com');
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001: 403 bot_detected response contains no PII
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: 403 bot_detected does not echo back PII fields', async () => {
    mockSiteverifyFailure();

    const app = buildApp({
      environment: 'production',
      turnstileSecretKey: TURNSTILE_SECRET,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const sensitiveBody = {
      ...VALID_BODY,
      email: 'sensitive@private.com',
      phone: '+5511999998888',
      cf_turnstile_response: 'bad-token',
    };

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sensitiveBody),
    });

    expect(res.status).toBe(403);
    const text = await res.text();

    // BR-PRIVACY-001: no email, no phone in error response
    expect(text).not.toContain('sensitive@private.com');
    expect(text).not.toContain('+5511999998888');
    expect(text).not.toMatch(/@[a-zA-Z]/);
  });
});

// ---------------------------------------------------------------------------
// T-2-008: issueLeadToken real DB path
// ---------------------------------------------------------------------------

describe('POST /v1/lead — issueLeadToken DB path (T-2-008)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build a minimal mock DB that simulates resolveLeadByAliases (via lead tables)
   * and issueLeadToken (via leadTokens insert).
   *
   * The mock reuses the same select/insert chain pattern from the domain lib.
   */
  function createMockDbForLead(options: {
    resolveResult?: { id: string } | null;
    tokenInsertResult?: { id: string } | null;
  }) {
    const resolvedLeadId = options.resolveResult?.id ?? 'lead-mock-001';
    const tokenRowId = options.tokenInsertResult?.id ?? 'lt-mock-001';

    const shouldFailResolve = options.resolveResult === null;
    const shouldFailTokenInsert = options.tokenInsertResult === null;

    // biome-ignore lint/suspicious/noExplicitAny: mock db — no real Db type in tests
    const mock: any = {
      _insertLeadTokenCalled: false,
      select: () => ({
        from: () => ({
          where: () => {
            // Must be both awaitable (aliases query has no .limit())
            // and expose .limit() (lead lookup in resolveCanonical uses .limit(1))
            // Use a real Promise with extra properties attached.
            const p = Promise.resolve([]) as Promise<unknown[]> & {
              limit: () => Promise<unknown[]>;
            };
            p.limit = async () => [];
            return p;
          },
        }),
      }),
      insert: () => ({
        // values() must be both awaitable (for plain inserts like leadAliases)
        // and have a .returning() method (for leads + lead_tokens inserts).
        values: (vals: unknown) => {
          const v = Array.isArray(vals)
            ? ((vals[0] as Record<string, unknown>) ?? {})
            : (vals as Record<string, unknown>);

          const isTokenInsert = 'tokenHash' in v;
          const isLeadInsert =
            'workspaceId' in v &&
            !('tokenHash' in v) &&
            !('identifierType' in v);

          // Real Promise (for plain `await db.insert(...).values(...)`)
          // with a .returning() method attached.
          const p = Promise.resolve([]) as Promise<unknown[]> & {
            returning: () => Promise<unknown[]>;
          };
          p.returning = async () => {
            if (isTokenInsert) {
              mock._insertLeadTokenCalled = true;
              if (shouldFailTokenInsert) {
                throw new Error('DB error on token insert');
              }
              return [{ id: tokenRowId }];
            }
            if (isLeadInsert) {
              if (shouldFailResolve) {
                throw new Error('DB error on lead insert');
              }
              return [{ id: resolvedLeadId }];
            }
            return [];
          };
          return p;
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => [],
        }),
      }),
    };

    return mock;
  }

  // -------------------------------------------------------------------------
  // Case 9: DB provided → resolveLeadByAliases + issueLeadToken → 202
  // -------------------------------------------------------------------------
  it('202: issues real token when DB is provided (T-2-008)', async () => {
    const db = createMockDbForLead({
      resolveResult: { id: 'lead-db-001' },
      tokenInsertResult: { id: 'lt-db-001' },
    });

    const app = buildApp({
      environment: 'development',
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
      db,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-funil-site': 'pk_live_test_page_token',
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(body.lead_token).toBeTruthy();
    expect(body.expires_at).toBeTruthy();
    // lead_public_id should be the resolved lead_id from DB
    expect(body.lead_public_id).toBe('lead-db-001');
    // DB token insert was called
    expect(db._insertLeadTokenCalled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 10: DB resolve error → 500 internal_error
  // -------------------------------------------------------------------------
  it('500: returns internal_error when lead resolution fails', async () => {
    const db = createMockDbForLead({ resolveResult: null });

    const app = buildApp({
      environment: 'development',
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
      db,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-funil-site': 'pk_live_test_page_token',
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('internal_error');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toContain('user@example.com');
  });

  // -------------------------------------------------------------------------
  // Case 11: issueLeadToken DB error → 500 internal_error
  // -------------------------------------------------------------------------
  it('500: returns internal_error when issueLeadToken fails', async () => {
    const db = createMockDbForLead({
      resolveResult: { id: 'lead-db-002' },
      tokenInsertResult: null,
    });

    const app = buildApp({
      environment: 'development',
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
      db,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-funil-site': 'pk_live_test_page_token',
      },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('internal_error');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toContain('user@example.com');
  });

  // -------------------------------------------------------------------------
  // Case 12: No DB → fallback to temp token → 202 (warn logged)
  // -------------------------------------------------------------------------
  it('202: falls back to temporary token when no DB is provided', async () => {
    // No db option → createLeadRoute() without DB (leadRoute default)
    const app = buildApp({
      environment: 'development',
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
      // db intentionally omitted
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(body.lead_token).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Case 13: __ftk Set-Cookie header set only when consent.functional === true
  // INV-IDENTITY-006: cookie only set with functional consent
  // -------------------------------------------------------------------------
  it('sets __ftk Set-Cookie when consent.functional=true', async () => {
    const db = createMockDbForLead({
      resolveResult: { id: 'lead-cookie-001' },
      tokenInsertResult: { id: 'lt-cookie-001' },
    });

    const app = buildApp({
      environment: 'development',
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
      db,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-funil-site': 'pk_live_test_page_token',
      },
      body: JSON.stringify({
        ...VALID_BODY,
        consent: { analytics: false, marketing: false, functional: true },
      }),
    });

    expect(res.status).toBe(202);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain('__ftk=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
  });

  // -------------------------------------------------------------------------
  // Case 14: NO __ftk cookie when consent.functional === false
  // INV-IDENTITY-006: cookie must not be set without functional consent
  // -------------------------------------------------------------------------
  it('does NOT set __ftk Set-Cookie when consent.functional=false', async () => {
    const db = createMockDbForLead({
      resolveResult: { id: 'lead-nocookie-001' },
      tokenInsertResult: { id: 'lt-nocookie-001' },
    });

    const app = buildApp({
      environment: 'development',
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
      db,
    });

    const res = await app.fetch(LEAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-funil-site': 'pk_live_test_page_token',
      },
      body: JSON.stringify({
        ...VALID_BODY,
        consent: { analytics: false, marketing: false, functional: false },
      }),
    });

    expect(res.status).toBe(202);
    const setCookie = res.headers.get('set-cookie');
    // No cookie set when functional consent is false
    expect(setCookie).toBeNull();
  });
});
