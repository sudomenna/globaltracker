/**
 * Integration tests — POST /v1/lead
 *
 * CONTRACT-id: CONTRACT-api-lead-v1
 * T-ID: T-1-018
 *
 * Covers:
 *   - Happy path: POST with email → 202 + Set-Cookie __ftk + lead_token
 *   - Happy path: POST with phone only → 202 + lead_token
 *   - Missing identifier → 400 missing_identifier
 *   - consent.functional=false → 202 without __ftk cookie
 *   - Invalid body (bad JSON / schema) → 400
 *   - Unknown fields (.strict()) → 400
 *
 * BR-IDENTITY-005: lead_token in response body; cookie is HttpOnly/Secure/SameSite=Lax.
 * BR-PRIVACY-001: email/phone must not appear in response or error bodies.
 * INV-IDENTITY-006: __ftk cookie only set when consent.functional=true.
 *
 * Tests use Hono's third-argument env injection (app.request(url, init, Env)):
 *   - Bindings (QUEUE_EVENTS, LEAD_TOKEN_HMAC_SECRET) injected via Env argument.
 *   - Context variables (workspace_id, page_id, request_id) injected via middleware.
 *   - DB binding omitted — fast-accept model skips insert when absent.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { leadRoute } from '../lead.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MockBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
  LEAD_TOKEN_HMAC_SECRET?: string;
};

type MockVariables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Hono app mounting leadRoute, with pre-set context variables. */
function buildApp(opts: { workspaceId?: string } = {}) {
  const { workspaceId = 'ws-test-uuid-001' } = opts;

  const mockSend = vi.fn().mockResolvedValue(undefined);
  const mockQueue = {
    send: mockSend,
    sendBatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Queue;

  const app = new Hono<{
    Bindings: MockBindings;
    Variables: MockVariables;
  }>();

  // Inject context variables that auth-public-token + sanitize-logs would set.
  app.use('*', async (c, next) => {
    c.set('request_id', 'req-test-uuid');
    c.set('workspace_id', workspaceId);
    c.set('page_id', 'pg-test-uuid-001');
    await next();
  });

  app.route('/v1/lead', leadRoute);

  // Default mock env — passed as 3rd arg to app.request() per Hono test API
  const mockEnv: MockBindings = {
    ENVIRONMENT: 'test',
    QUEUE_EVENTS: mockQueue,
    QUEUE_DISPATCH: mockQueue,
    LEAD_TOKEN_HMAC_SECRET: 'test-hmac-secret-32-bytes-minimum!!',
    // DB intentionally omitted — fast-accept model skips insert when absent
  } as unknown as MockBindings;

  return { app, mockEnv, mockSend };
}

// ---------------------------------------------------------------------------
// Valid payload factories
// ---------------------------------------------------------------------------

const VALID_BODY_EMAIL = {
  event_id: 'evt-unique-001',
  schema_version: 1 as const,
  launch_public_id: 'launch-pub-id-001',
  page_public_id: 'page-pub-id-001',
  email: 'test@example.com',
  attribution: { utm_source: 'google' },
  consent: { analytics: true, marketing: false, functional: true },
};

const VALID_BODY_PHONE = {
  event_id: 'evt-unique-002',
  schema_version: 1 as const,
  launch_public_id: 'launch-pub-id-001',
  page_public_id: 'page-pub-id-001',
  phone: '+5511999990001',
  attribution: {},
  consent: { analytics: false, marketing: false, functional: true },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/lead', () => {
  // -------------------------------------------------------------------------
  // Happy path — email present → 202 + __ftk cookie + lead_token in body
  // -------------------------------------------------------------------------
  it('returns 202 with lead_token and sets __ftk cookie when email provided', async () => {
    const { app, mockEnv } = buildApp();

    const res = await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY_EMAIL),
      },
      mockEnv,
    );

    expect(res.status).toBe(202);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(typeof body.lead_public_id).toBe('string');
    expect(typeof body.lead_token).toBe('string');
    expect(typeof body.expires_at).toBe('string');

    // lead_token must be non-empty and look like an HMAC token (payload.sig format)
    const token = body.lead_token as string;
    expect(token.length).toBeGreaterThan(10);
    expect(token).toContain('.');

    // __ftk cookie must be set with correct attributes
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('__ftk=');
    expect(setCookie).toContain('Max-Age=5184000');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');

    // BR-PRIVACY-001: email must not appear in response body
    expect(JSON.stringify(body)).not.toContain('test@example.com');
  });

  // -------------------------------------------------------------------------
  // Happy path — phone only → 202 + lead_token
  // -------------------------------------------------------------------------
  it('returns 202 with lead_token when only phone is provided', async () => {
    const { app, mockEnv } = buildApp();

    const res = await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY_PHONE),
      },
      mockEnv,
    );

    expect(res.status).toBe(202);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(typeof body.lead_token).toBe('string');

    // BR-PRIVACY-001: phone must not appear in response body
    expect(JSON.stringify(body)).not.toContain('+5511999990001');
  });

  // -------------------------------------------------------------------------
  // Missing identifier — no email and no phone → 400 missing_identifier
  // -------------------------------------------------------------------------
  it('returns 400 missing_identifier when neither email nor phone provided', async () => {
    const { app, mockEnv } = buildApp();

    const bodyNoIdentifier = {
      event_id: 'evt-no-id-001',
      schema_version: 1 as const,
      launch_public_id: 'launch-pub-id-001',
      page_public_id: 'page-pub-id-001',
      attribution: {},
      consent: { analytics: false, marketing: false, functional: true },
    };

    const res = await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyNoIdentifier),
      },
      mockEnv,
    );

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('missing_identifier');
  });

  // -------------------------------------------------------------------------
  // INV-IDENTITY-006: consent.functional=false → no __ftk cookie
  // -------------------------------------------------------------------------
  it('returns 202 WITHOUT __ftk cookie when consent.functional is false', async () => {
    const { app, mockEnv } = buildApp();

    const bodyNoFunctional = {
      ...VALID_BODY_EMAIL,
      event_id: 'evt-no-functional-001',
      consent: { analytics: false, marketing: false, functional: false },
    };

    const res = await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyNoFunctional),
      },
      mockEnv,
    );

    expect(res.status).toBe(202);

    // INV-IDENTITY-006: __ftk cookie must NOT be set without functional consent
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toBeNull();

    // lead_token is still returned in response body
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('accepted');
    expect(typeof body.lead_token).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Invalid body — bad JSON → 400 validation_error
  // -------------------------------------------------------------------------
  it('returns 400 on malformed JSON body', async () => {
    const { app, mockEnv } = buildApp();

    const res = await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ invalid json !!!',
      },
      mockEnv,
    );

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
    // BR-PRIVACY-001: no PII in error response
    expect(JSON.stringify(body)).not.toMatch(/@[a-zA-Z]/);
  });

  // -------------------------------------------------------------------------
  // Invalid body — missing required fields → 400 validation_error
  // -------------------------------------------------------------------------
  it('returns 400 when required schema fields are missing', async () => {
    const { app, mockEnv } = buildApp();

    // Only email present; missing event_id, schema_version, launch_public_id etc.
    const res = await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      },
      mockEnv,
    );

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // Strict schema — unknown fields rejected → 400
  // -------------------------------------------------------------------------
  it('returns 400 when unknown fields are present (.strict())', async () => {
    const { app, mockEnv } = buildApp();

    const bodyWithExtra = {
      ...VALID_BODY_EMAIL,
      event_id: 'evt-strict-001',
      unknown_field: 'should_be_rejected',
    };

    const res = await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyWithExtra),
      },
      mockEnv,
    );

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // Response shape matches CONTRACT-api-lead-v1
  // -------------------------------------------------------------------------
  it('response shape matches CONTRACT-api-lead-v1', async () => {
    const { app, mockEnv } = buildApp();

    const res = await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY_EMAIL),
      },
      mockEnv,
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;

    // CONTRACT-api-lead-v1: { lead_public_id, lead_token, expires_at, status }
    expect(body).toHaveProperty('lead_public_id');
    expect(body).toHaveProperty('lead_token');
    expect(body).toHaveProperty('expires_at');
    expect(body.status).toBe('accepted');

    // BR-PRIVACY-001: no PII in response
    expect(JSON.stringify(body)).not.toContain('test@example.com');
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001 — no PII in error responses
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: error responses contain no PII patterns', async () => {
    const { app, mockEnv } = buildApp();

    const res = await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: 'evt-pii-test',
          schema_version: 1,
          launch_public_id: 'launch-001',
          page_public_id: 'page-001',
          // no email/phone — triggers missing_identifier 400
          attribution: {},
          consent: { analytics: false, marketing: false, functional: true },
        }),
      },
      mockEnv,
    );

    expect(res.status).toBe(400);
    const text = await res.text();

    // No email-like pattern
    expect(text).not.toMatch(/@[a-zA-Z]/);
    // No phone-like pattern
    expect(text).not.toMatch(/\+\d{10,}/);
  });

  // -------------------------------------------------------------------------
  // QUEUE_EVENTS.send called on successful 202
  // -------------------------------------------------------------------------
  it('enqueues event in QUEUE_EVENTS on successful request', async () => {
    const { app, mockEnv, mockSend } = buildApp();

    await app.request(
      '/v1/lead',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(VALID_BODY_EMAIL),
      },
      mockEnv,
    );

    expect(mockSend).toHaveBeenCalledOnce();
    const queuePayload = mockSend.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(queuePayload.event_name).toBe('lead_identify');
    expect(queuePayload.workspace_id).toBe('ws-test-uuid-001');
    expect(queuePayload.lead_public_id).toBeTruthy();
  });
});
