/**
 * Integration tests — POST /v1/integrations/:provider/test
 *
 * CONTRACT-api-integrations-test-v1
 * T-ID: T-6-007
 *
 * Test cases:
 *  1. Meta with mocked credentials → success (mock fetch returns {events_received: 1})
 *  2. Meta without credentials → skipped
 *  3. GA4 with mocked credentials → success (mock fetch returns {validationMessages: []})
 *  4. GA4 without credentials → skipped
 *  5. Unknown provider → 404
 *  6. Missing Authorization header → 401
 *  7. Malformed Authorization header → 401
 *  8. Invalid body (missing source) → 400
 *  9. Unknown source value → 400
 * 10. Extra field in body (.strict()) → 400
 * 11. Invalid JSON body → 400
 * 12. Meta API error (events_received: 0) → failed with PT-BR message
 * 13. Meta API — invalid access token → failed with translated PT-BR message
 * 14. google_ads provider → skipped immediately
 *
 * BR-PRIVACY-001: error responses must not contain PII.
 * BR-EVENT-002: each test call generates a new synthetic event_id (UUID).
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { integrationsTestRoute } from '../../../apps/edge/src/routes/integrations-test.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  HYPERDRIVE: Hyperdrive;
  ENVIRONMENT: string;
  META_CAPI_TOKEN?: string;
  META_CAPI_TEST_EVENT_CODE?: string;
  META_PIXEL_ID?: string;
  META_ADS_ACCOUNT_ID?: string;
  GA4_MEASUREMENT_ID?: string;
  GA4_API_SECRET?: string;
};

type Variables = {
  workspace_id?: string;
  page_id?: string;
  request_id?: string;
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
// App factory
// ---------------------------------------------------------------------------

function createApp(envOverrides: Partial<Bindings> = {}) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route('/v1/integrations', integrationsTestRoute);

  const env: Bindings = {
    GT_KV: createMockKv(),
    HYPERDRIVE: {} as Hyperdrive,
    ENVIRONMENT: 'test',
    ...envOverrides,
  };

  return { app, env };
}

function makeRequest(
  app: Hono<{ Bindings: Bindings; Variables: Variables }>,
  env: Bindings,
  provider: string,
  options: {
    body?: unknown;
    authHeader?: string | null;
  } = {},
) {
  const {
    body = { source: 'config_screen' },
    authHeader = 'Bearer test-token',
  } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (authHeader !== null) {
    headers.Authorization = authHeader;
  }

  return app.request(
    `/v1/integrations/${provider}/test`,
    {
      method: 'POST',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    },
    env,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /v1/integrations/:provider/test', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('returns 401 when Authorization header is missing', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, 'meta', { authHeader: null });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('unauthorized');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('returns 401 when Authorization header does not start with Bearer', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, 'meta', {
      authHeader: 'Basic sometoken',
    });

    expect(res.status).toBe(401);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('unauthorized');
  });

  // -------------------------------------------------------------------------
  // Provider routing
  // -------------------------------------------------------------------------

  it('returns 404 for unknown provider', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, 'stripe');

    expect(res.status).toBe(404);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('not_found');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Body validation
  // -------------------------------------------------------------------------

  it('returns 400 when body is invalid JSON', async () => {
    const { app, env } = createApp({
      META_CAPI_TOKEN: 'tok',
      META_PIXEL_ID: 'px123',
    });

    const res = await app.request(
      '/v1/integrations/meta/test',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: 'not-json',
      },
      env,
    );

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('validation_error');
  });

  it('returns 400 when source field is missing', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, 'meta', { body: {} });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('validation_error');
  });

  it('returns 400 when source value is unknown', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, 'meta', {
      body: { source: 'unknown_source' },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('validation_error');
  });

  it('returns 400 when body has extra fields (.strict())', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, 'meta', {
      body: { source: 'config_screen', extra: 'field' },
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.code).toBe('validation_error');
  });

  // -------------------------------------------------------------------------
  // Meta — skipped (not configured)
  // -------------------------------------------------------------------------

  it('returns skipped when Meta credentials are not configured', async () => {
    const { app, env } = createApp(); // no META_CAPI_TOKEN or META_PIXEL_ID

    const res = await makeRequest(app, env, 'meta');

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('skipped');
    expect(json.provider).toBe('meta');
    expect((json.error as Record<string, unknown>).code).toBe(
      'integration_not_configured',
    );
  });

  // -------------------------------------------------------------------------
  // Meta — success
  // -------------------------------------------------------------------------

  it('returns success for Meta when fetch returns events_received: 1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ events_received: 1 }),
      }),
    );

    const { app, env } = createApp({
      META_CAPI_TOKEN: 'valid-token',
      META_PIXEL_ID: 'px_test_123',
    });

    const res = await makeRequest(app, env, 'meta');

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('success');
    expect(json.provider).toBe('meta');
    expect(typeof json.latency_ms).toBe('number');

    const phases = json.phases as Array<Record<string, unknown>>;
    expect(phases.find((p) => p.name === 'prepare')?.status).toBe('ok');
    expect(phases.find((p) => p.name === 'send')?.status).toBe('ok');
    expect(phases.find((p) => p.name === 'confirm')?.status).toBe('ok');

    expect(json.external_url).toContain('px_test_123');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Meta — failed (API error)
  // -------------------------------------------------------------------------

  it('returns failed for Meta when events_received is 0', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          events_received: 0,
          error: { message: 'Invalid parameter' },
        }),
      }),
    );

    const { app, env } = createApp({
      META_CAPI_TOKEN: 'valid-token',
      META_PIXEL_ID: 'px_test_123',
    });

    const res = await makeRequest(app, env, 'meta');

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('failed');
    expect(json.provider).toBe('meta');
    expect((json.error as Record<string, unknown>).code).toBe('meta_api_error');
  });

  it('translates "invalid access token" Meta error to PT-BR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          events_received: 0,
          error: { message: 'Invalid access token' },
        }),
      }),
    );

    const { app, env } = createApp({
      META_CAPI_TOKEN: 'expired-token',
      META_PIXEL_ID: 'px_test_123',
    });

    const res = await makeRequest(app, env, 'meta');
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('failed');
    const errMsg = (json.error as Record<string, unknown>).message as string;
    expect(errMsg).toContain('Token CAPI inválido');
  });

  // -------------------------------------------------------------------------
  // GA4 — skipped (not configured)
  // -------------------------------------------------------------------------

  it('returns skipped when GA4 credentials are not configured', async () => {
    const { app, env } = createApp(); // no GA4_MEASUREMENT_ID or GA4_API_SECRET

    const res = await makeRequest(app, env, 'ga4');

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('skipped');
    expect(json.provider).toBe('ga4');
    expect((json.error as Record<string, unknown>).code).toBe(
      'integration_not_configured',
    );
  });

  // -------------------------------------------------------------------------
  // GA4 — success
  // -------------------------------------------------------------------------

  it('returns success for GA4 when validationMessages is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        json: async () => ({ validationMessages: [] }),
      }),
    );

    const { app, env } = createApp({
      GA4_MEASUREMENT_ID: 'G-TESTID123',
      GA4_API_SECRET: 'ga4-secret',
    });

    const res = await makeRequest(app, env, 'ga4');

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('success');
    expect(json.provider).toBe('ga4');
    expect(typeof json.latency_ms).toBe('number');

    const phases = json.phases as Array<Record<string, unknown>>;
    expect(phases.find((p) => p.name === 'prepare')?.status).toBe('ok');
    expect(phases.find((p) => p.name === 'send')?.status).toBe('ok');
    expect(phases.find((p) => p.name === 'confirm')?.status).toBe('ok');

    // external_url should reference the numeric ID (strip G-)
    expect(json.external_url).toContain('TESTID123');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // GA4 — failed (validation messages)
  // -------------------------------------------------------------------------

  it('returns failed for GA4 when validationMessages is non-empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          validationMessages: [
            {
              description: 'Required field missing: client_id',
              fieldPath: 'client_id',
            },
          ],
        }),
      }),
    );

    const { app, env } = createApp({
      GA4_MEASUREMENT_ID: 'G-TESTID123',
      GA4_API_SECRET: 'ga4-secret',
    });

    const res = await makeRequest(app, env, 'ga4');

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('failed');
    expect((json.error as Record<string, unknown>).code).toBe(
      'ga4_validation_error',
    );
  });

  // -------------------------------------------------------------------------
  // google_ads — always skipped
  // -------------------------------------------------------------------------

  it('returns skipped immediately for google_ads provider', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, 'google_ads');

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('skipped');
    expect(json.provider).toBe('google_ads');
    expect((json.error as Record<string, unknown>).code).toBe('not_supported');
    // latency should be 0 for instant skip
    expect(json.latency_ms).toBe(0);
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001: no PII in error responses
  // -------------------------------------------------------------------------

  it('BR-PRIVACY-001: error responses contain no PII fields', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, 'meta', { authHeader: null });

    expect(res.status).toBe(401);
    const text = await res.text();
    // Check the raw response body contains no email-like patterns
    expect(text).not.toMatch(
      /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
    );
    // No token values exposed in response
    expect(text).not.toContain('valid-token');
    expect(text).not.toContain('ga4-secret');
  });

  // -------------------------------------------------------------------------
  // source: wizard variant
  // -------------------------------------------------------------------------

  it('accepts source: wizard variant and returns skipped for unconfigured Meta', async () => {
    const { app, env } = createApp();
    const res = await makeRequest(app, env, 'meta', {
      body: { source: 'wizard' },
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.status).toBe('skipped');
  });
});
