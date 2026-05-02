/**
 * Integration tests — GET /v1/config/:launch_public_id/:page_public_id
 *
 * CONTRACT-api-config-v1
 *
 * Covers:
 *   200 cache miss  — DB stub returns valid page, KV empty
 *   200 cache hit   — KV returns cached config
 *   304             — ETag match (If-None-Match)
 *   401             — workspace_id or page_id absent from context
 *   404             — DB returns null (page not found)
 *   410             — page.status === 'archived'
 *   200 fallback    — DB binding undefined (Hyperdrive not configured)
 *
 * INV-PAGE-007: workspace_id isolation — handler reads from context (set by auth middleware).
 * BR-PRIVACY-001: zero PII in log output and error responses.
 *
 * Test approach: real Hono app, mock KV (in-memory Map), injected GetPageConfigFn.
 * No external DB or Cloudflare runtime required — runs with vitest node environment.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type GetPageConfigFn,
  type PageConfigRow,
  createConfigRoute,
} from '../../../apps/edge/src/routes/config.js';

// ---------------------------------------------------------------------------
// Types (mirror apps/edge/src/index.ts)
// ---------------------------------------------------------------------------

type Bindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
};

type Variables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
};

// ---------------------------------------------------------------------------
// In-memory KV mock
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory KV mock.
 * Implements only the subset of KVNamespace used by the config handler:
 *   get(key, { type: 'json' }) → T | null
 *   put(key, value, { expirationTtl }) → Promise<void>
 */
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
      if (type === 'json') {
        return JSON.parse(raw) as T;
      }
      return raw as unknown as T;
    },

    async put(
      key: string,
      value: string,
      _options?: { expirationTtl?: number },
    ): Promise<void> {
      store.set(key, value);
    },

    // Stub remaining KVNamespace methods (unused by handler)
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
      const value = await kv.get<T>(key, options);
      return { value, metadata: null };
    },
  } as unknown as KVNamespace & { store: Map<string, string> };

  return kv;
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

/**
 * Build a Hono test app that:
 *   1. Injects workspace_id + page_id + request_id into context (simulating middleware).
 *   2. Mounts the config route under /v1/config.
 *   3. Provides mock KV + optional DB binding.
 */
function buildApp(options: {
  getPageConfig: GetPageConfigFn;
  kv: KVNamespace;
  db?: Fetcher;
  workspaceId?: string;
  pageId?: string;
  requestId?: string;
}) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Simulate middleware: set context variables
  app.use('/v1/config/*', async (c, next) => {
    if (options.workspaceId !== undefined) {
      c.set('workspace_id', options.workspaceId);
    }
    if (options.pageId !== undefined) {
      c.set('page_id', options.pageId);
    }
    c.set('request_id', options.requestId ?? 'test-request-id');
    await next();
  });

  app.route('/v1/config', createConfigRoute(options.getPageConfig));

  // Provide bindings via a wrapper fetch that injects env
  const mockEnv: Bindings = {
    GT_KV: options.kv,
    QUEUE_EVENTS: {} as Queue,
    QUEUE_DISPATCH: {} as Queue,
    ENVIRONMENT: 'test',
    ...(options.db ? { DB: options.db } : {}),
  };

  // Return a fetch-compatible function that injects the mock env
  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      return app.fetch(request, mockEnv);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-test-aaa';
const PAGE_ID = 'pg-test-bbb';
const LAUNCH_PUBLIC_ID = 'launch-xyz';
const PAGE_PUBLIC_ID = 'page-abc';
const CONFIG_URL = `http://localhost/v1/config/${LAUNCH_PUBLIC_ID}/${PAGE_PUBLIC_ID}`;

const VALID_ROW: PageConfigRow = {
  status: 'active',
  eventConfig: {},
  allowedEventNames: ['PageView', 'Lead'],
  customDataSchema: { value: { type: 'number' } },
  metaPixelId: '123456789',
  ga4MeasurementId: 'G-ABCDEF',
  leadTokenTtlDays: 60,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /v1/config/:launch_public_id/:page_public_id — CONTRACT-api-config-v1', () => {
  // -------------------------------------------------------------------------
  // 200 — cache miss, DB returns valid page
  // -------------------------------------------------------------------------
  it('200 cache miss: returns full config when DB returns a valid page', async () => {
    const kv = createMockKV(); // empty KV
    const getPageConfig: GetPageConfigFn = async () => VALID_ROW;

    const app = buildApp({
      getPageConfig,
      kv,
      db: {} as Fetcher, // DB binding present
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(CONFIG_URL);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    // Shape assertions
    expect(body.schema_version).toBe(1);
    expect(body.event_config).toBeDefined();
    expect((body.event_config as Record<string, unknown>).events_enabled).toBe(
      true,
    );
    expect(
      (body.event_config as Record<string, unknown>).allowed_event_names,
    ).toEqual(['PageView', 'Lead']);
    expect(body.pixel_policy).toBeDefined();
    expect((body.pixel_policy as Record<string, unknown>).meta_pixel_id).toBe(
      '123456789',
    );
    expect(body.endpoints).toBeDefined();
    expect((body.endpoints as Record<string, unknown>).events).toBe(
      '/v1/events',
    );
    expect(body.lead_token_settings).toBeDefined();
    expect((body.lead_token_settings as Record<string, unknown>).ttl_days).toBe(
      60,
    );
    expect(body._cache).toBe('miss');

    // Cache-Control and ETag headers
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.headers.get('X-Request-Id')).toBeTruthy();

    // KV should now be populated
    const cachedRaw = kv.store.get(`config:v1:${PAGE_ID}`);
    expect(cachedRaw).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 200 — cache hit (KV already has config)
  // -------------------------------------------------------------------------
  it('200 cache hit: returns config from KV without calling DB', async () => {
    // Pre-populate KV
    const cachedBody = {
      event_config: {
        events_enabled: true,
        allowed_event_names: ['PageView'],
        custom_data_schema: {},
      },
      pixel_policy: { meta_pixel_id: null, ga4_measurement_id: null },
      endpoints: {
        events: '/v1/events',
        lead: '/v1/lead',
        redirect: '/r/:slug',
      },
      schema_version: 1,
      lead_token_settings: { ttl_days: 60 },
    };
    const kv = createMockKV({
      [`config:v1:${PAGE_ID}`]: JSON.stringify(cachedBody),
    });

    let dbCalled = false;
    const getPageConfig: GetPageConfigFn = async () => {
      dbCalled = true;
      return VALID_ROW;
    };

    const app = buildApp({
      getPageConfig,
      kv,
      db: {} as Fetcher,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(CONFIG_URL);

    expect(res.status).toBe(200);
    expect(dbCalled).toBe(false); // DB must NOT be called on cache hit

    const body = (await res.json()) as Record<string, unknown>;
    expect(body._cache).toBe('hit');
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
  });

  // -------------------------------------------------------------------------
  // 304 — ETag match
  // -------------------------------------------------------------------------
  it('304: returns Not Modified when If-None-Match matches ETag', async () => {
    // First request — get the ETag
    const kv = createMockKV();
    const getPageConfig: GetPageConfigFn = async () => VALID_ROW;

    const app = buildApp({
      getPageConfig,
      kv,
      db: {} as Fetcher,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const firstRes = await app.fetch(CONFIG_URL);
    expect(firstRes.status).toBe(200);
    const etag = firstRes.headers.get('ETag');
    expect(etag).toBeTruthy();

    // Second request — send If-None-Match with same ETag
    // etag is asserted truthy above; cast to string to satisfy no-non-null-assertion
    const secondRes = await app.fetch(
      new Request(CONFIG_URL, {
        headers: { 'If-None-Match': etag as string },
      }),
    );

    expect(secondRes.status).toBe(304);
    // 304 body is empty
    const text = await secondRes.text();
    expect(text).toBe('');
    expect(secondRes.headers.get('ETag')).toBe(etag);
  });

  // -------------------------------------------------------------------------
  // 401 — workspace_id absent from context
  // -------------------------------------------------------------------------
  it('401: returns invalid_token when workspace_id is missing from context', async () => {
    const kv = createMockKV();
    const getPageConfig: GetPageConfigFn = async () => VALID_ROW;

    // Do NOT inject workspace_id
    const app = buildApp({
      getPageConfig,
      kv,
      db: {} as Fetcher,
      // workspaceId intentionally omitted
      pageId: PAGE_ID,
    });

    const res = await app.fetch(CONFIG_URL);

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_token');
    // BR-PRIVACY-001: no PII in response
    expect(JSON.stringify(body)).not.toMatch(/@/);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('401: returns invalid_token when page_id is missing from context', async () => {
    const kv = createMockKV();
    const getPageConfig: GetPageConfigFn = async () => VALID_ROW;

    const app = buildApp({
      getPageConfig,
      kv,
      db: {} as Fetcher,
      workspaceId: WORKSPACE_ID,
      // pageId intentionally omitted
    });

    const res = await app.fetch(CONFIG_URL);

    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('invalid_token');
  });

  // -------------------------------------------------------------------------
  // 404 — DB returns null
  // -------------------------------------------------------------------------
  it('404: returns page_not_found when DB returns null', async () => {
    const kv = createMockKV();
    const getPageConfig: GetPageConfigFn = async () => null;

    const app = buildApp({
      getPageConfig,
      kv,
      db: {} as Fetcher,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(CONFIG_URL);

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('page_not_found');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    // BR-PRIVACY-001: no PII
    expect(JSON.stringify(body)).not.toMatch(WORKSPACE_ID);
  });

  // -------------------------------------------------------------------------
  // 410 — page.status === 'archived'
  // -------------------------------------------------------------------------
  it('410: returns archived when page status is archived', async () => {
    const kv = createMockKV();
    const archivedRow: PageConfigRow = { ...VALID_ROW, status: 'archived' };
    const getPageConfig: GetPageConfigFn = async () => archivedRow;

    const app = buildApp({
      getPageConfig,
      kv,
      db: {} as Fetcher,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(CONFIG_URL);

    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('archived');
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 200 fallback — DB binding undefined (Hyperdrive not configured)
  // -------------------------------------------------------------------------
  it('200 fallback: returns minimal config when DB binding is absent', async () => {
    const kv = createMockKV();
    let dbCalled = false;
    const getPageConfig: GetPageConfigFn = async () => {
      dbCalled = true;
      return VALID_ROW;
    };

    // No `db` in options → DB binding undefined
    const app = buildApp({
      getPageConfig,
      kv,
      // db intentionally omitted
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res = await app.fetch(CONFIG_URL);

    expect(res.status).toBe(200);
    expect(dbCalled).toBe(false); // getPageConfig must NOT be called

    const body = (await res.json()) as Record<string, unknown>;
    expect(body._cache).toBe('fallback');
    expect((body.event_config as Record<string, unknown>).events_enabled).toBe(
      false,
    );
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
  });

  // -------------------------------------------------------------------------
  // ETag stability — same content yields same ETag
  // -------------------------------------------------------------------------
  it('ETag is stable across two cache-miss requests for the same page config', async () => {
    const getPageConfig: GetPageConfigFn = async () => VALID_ROW;

    const kv1 = createMockKV();
    const app1 = buildApp({
      getPageConfig,
      kv: kv1,
      db: {} as Fetcher,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const kv2 = createMockKV();
    const app2 = buildApp({
      getPageConfig,
      kv: kv2,
      db: {} as Fetcher,
      workspaceId: WORKSPACE_ID,
      pageId: PAGE_ID,
    });

    const res1 = await app1.fetch(CONFIG_URL);
    const res2 = await app2.fetch(CONFIG_URL);

    expect(res1.headers.get('ETag')).toBe(res2.headers.get('ETag'));
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001 — error responses contain no PII
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: 404 response body contains no PII patterns', async () => {
    const kv = createMockKV();
    const getPageConfig: GetPageConfigFn = async () => null;

    const app = buildApp({
      getPageConfig,
      kv,
      db: {} as Fetcher,
      workspaceId: 'ws-priv-test',
      pageId: 'pg-priv-test',
    });

    const res = await app.fetch(CONFIG_URL);
    const text = await res.text();

    // No email patterns
    expect(text).not.toMatch(/@[a-zA-Z]/);
    // No raw workspace or page IDs from DB row
    expect(text).not.toContain(VALID_ROW.metaPixelId ?? '');
  });
});
