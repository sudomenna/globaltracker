/**
 * Integration tests — POST /v1/lead
 *
 * CONTRACT-api-lead-v1
 * T-ID: T-2-009
 *
 * Covers Turnstile bot mitigation (ADR-024):
 *   1. Token absent + ENVIRONMENT=development → 202 bypass
 *   2. Token absent + ENVIRONMENT=production  → 403 bot_detected
 *   3. Token invalid (siteverify returns success=false) → 403 bot_detected
 *   4. Token valid (siteverify returns success=true) → 202 accepted
 *
 * Also covers existing happy-path and validation cases:
 *   5. Valid body (no Turnstile binding configured) → 202 accepted
 *   6. Missing identifier (no email/phone) → 400 missing_identifier
 *   7. Invalid JSON → 400 validation_error
 *   8. BR-PRIVACY-001: 403 response contains no PII
 *
 * Test approach:
 *   - Real Hono app with leadRoute mounted.
 *   - fetch() mocked at global level for siteverify calls only.
 *   - Mock QUEUE_EVENTS (in-memory implementation).
 *   - No DB binding required (placeholder path).
 *
 * BR-PRIVACY-001: error responses must not echo back PII (email/phone).
 * ADR-024: Turnstile as primary bot mitigation.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leadRoute } from '../../../apps/edge/src/routes/lead.js';

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
}) {
  const mockQueue = options.queue ?? createMockQueue();

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

  app.route('/v1/lead', leadRoute);

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
