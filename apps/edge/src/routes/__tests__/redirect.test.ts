/**
 * Integration tests — redirect route (GET /r/:slug)
 *
 * CONTRACT-api-redirect-v1
 *
 * Covers:
 *   - Slug valid (KV cache hit) → 302 to correct destination_url
 *   - Slug with UTMs → final URL contains UTMs, existing params not overwritten
 *   - Slug not found → 404 link_not_found
 *   - Slug with status archived → 410 archived
 *   - Click enqueue called with waitUntil (queue.send invoked)
 *   - X-Request-Id present in all responses
 *   - BR-PRIVACY-001: no PII in error response bodies
 *   - INV-ATTRIBUTION-003: queue.send is called (not awaited before redirect)
 *
 * Uses a real Hono app with mock KV namespace, Queue, and executionCtx.
 * No external DB or real CF runtime required.
 */

import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  type LinkCacheEntry,
  buildRedirectUrl,
  createRedirectRoute,
} from '../redirect.js';

// ---------------------------------------------------------------------------
// Helpers — minimal KV namespace mock
// ---------------------------------------------------------------------------

function makeKv(store: Record<string, unknown> = {}): KVNamespace {
  return {
    async get(key: string, opts?: { type?: string }) {
      const val = store[key];
      if (val === undefined) return null;
      if (opts?.type === 'json') return val as unknown;
      return typeof val === 'string' ? val : JSON.stringify(val);
    },
    async put(key: string, value: string, _opts?: unknown) {
      store[key] = JSON.parse(value);
    },
    async delete(key: string) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- test mock
      delete store[key];
    },
    async list() {
      return { keys: [], list_complete: true, cursor: '' };
    },
    async getWithMetadata() {
      return { value: null, metadata: null };
    },
  } as unknown as KVNamespace;
}

// ---------------------------------------------------------------------------
// Helpers — minimal Queue mock
// ---------------------------------------------------------------------------

function makeQueue(sentMessages: unknown[] = []): Queue {
  return {
    async send(msg: unknown) {
      sentMessages.push(msg);
    },
    async sendBatch(msgs: unknown[]) {
      sentMessages.push(...msgs);
    },
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// Helpers — minimal executionCtx mock
//
// waitUntil collects promises but also immediately resolves them so test
// assertions can observe side effects (e.g. queue.send was called).
// ---------------------------------------------------------------------------

function makeCtx(promises: Promise<unknown>[] = []): ExecutionContext {
  return {
    waitUntil(p: Promise<unknown>) {
      promises.push(p);
      // Eagerly settle — test assertions run after request resolves
      p.catch(() => {
        // ignore errors in waitUntil during tests
      });
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Helpers — build a Hono app with redirect route and injected mocks
//
// KV and Queue are passed via kvOverride / queueOverride factory options so
// we never need to patch c.env (which is undefined / read-only in Node env).
// ---------------------------------------------------------------------------

function buildApp(
  kvStore: Record<string, unknown>,
  sentMessages: unknown[],
  getLinkBySlug?: (slug: string) => Promise<LinkCacheEntry | null>,
): {
  // biome-ignore lint/suspicious/noExplicitAny: test helper returns generic Hono with unknown bindings
  app: Hono<any>;
  kv: KVNamespace;
  queue: Queue;
  waitUntilPromises: Promise<unknown>[];
} {
  const kv = makeKv(kvStore);
  const queue = makeQueue(sentMessages);
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = makeCtx(waitUntilPromises);

  // Inject KV, Queue, and ExecutionContext via factory overrides.
  // This avoids patching c.env (read-only in Node) or c.executionCtx (getter-only).
  const router = createRedirectRoute({
    getLinkBySlug,
    kvOverride: kv,
    queueOverride: queue,
    ctxOverride: ctx,
  });

  // biome-ignore lint/suspicious/noExplicitAny: test app uses any bindings — no CF runtime in Node test env
  const app = new Hono<any>();
  app.route('/r', router);

  return { app, kv, queue, waitUntilPromises };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTIVE_LINK: LinkCacheEntry = {
  destination_url: 'https://example.com/landing',
  workspace_id: 'ws-test-001',
  link_id: 'lnk-abc-123',
  status: 'active',
};

const LINK_WITH_UTMS: LinkCacheEntry = {
  destination_url: 'https://example.com/lp',
  workspace_id: 'ws-test-001',
  link_id: 'lnk-utm-456',
  status: 'active',
  utm_source: 'facebook',
  utm_medium: 'cpc',
  utm_campaign: 'black-friday-2025',
};

const ARCHIVED_LINK: LinkCacheEntry = {
  destination_url: 'https://example.com/old',
  workspace_id: 'ws-test-001',
  link_id: 'lnk-archived-789',
  status: 'archived',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('redirect route — GET /r/:slug', () => {
  // -------------------------------------------------------------------------
  // Happy path — KV cache hit → 302
  // -------------------------------------------------------------------------
  it('KV cache hit — returns 302 to destination_url', async () => {
    const kvStore = { 'redirect:abc123': ACTIVE_LINK };
    const sentMessages: unknown[] = [];
    const { app } = buildApp(kvStore, sentMessages);

    const res = await app.request('/r/abc123', { method: 'GET' });

    expect(res.status).toBe(302);
    const location = res.headers.get('Location');
    expect(location).toBe('https://example.com/landing');
  });

  // -------------------------------------------------------------------------
  // UTM propagation — UTMs are appended, existing params not overwritten
  // -------------------------------------------------------------------------
  it('appends UTM params to destination URL', async () => {
    const kvStore = { 'redirect:utm-slug': LINK_WITH_UTMS };
    const sentMessages: unknown[] = [];
    const { app } = buildApp(kvStore, sentMessages);

    const res = await app.request('/r/utm-slug', { method: 'GET' });

    expect(res.status).toBe(302);
    const location = res.headers.get('Location') ?? '';
    const url = new URL(location);

    expect(url.searchParams.get('utm_source')).toBe('facebook');
    expect(url.searchParams.get('utm_medium')).toBe('cpc');
    expect(url.searchParams.get('utm_campaign')).toBe('black-friday-2025');
  });

  it('does not overwrite existing UTM params in destination URL', async () => {
    const linkWithExistingUtm: LinkCacheEntry = {
      destination_url: 'https://example.com/lp?utm_source=organic',
      workspace_id: 'ws-test-001',
      link_id: 'lnk-existing-utm',
      status: 'active',
      utm_source: 'facebook', // should NOT overwrite 'organic'
      utm_medium: 'cpc',
    };
    const kvStore = { 'redirect:existing-utm': linkWithExistingUtm };
    const sentMessages: unknown[] = [];
    const { app } = buildApp(kvStore, sentMessages);

    const res = await app.request('/r/existing-utm', { method: 'GET' });

    expect(res.status).toBe(302);
    const location = res.headers.get('Location') ?? '';
    const url = new URL(location);

    // utm_source was already set — must remain 'organic'
    expect(url.searchParams.get('utm_source')).toBe('organic');
    // utm_medium was not set — gets appended
    expect(url.searchParams.get('utm_medium')).toBe('cpc');
  });

  // -------------------------------------------------------------------------
  // Not found — 404
  // -------------------------------------------------------------------------
  it('returns 404 when slug not found in KV (no DB fallback)', async () => {
    const sentMessages: unknown[] = [];
    const { app } = buildApp({}, sentMessages);

    const res = await app.request('/r/unknown-slug', { method: 'GET' });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('link_not_found');
  });

  it('returns 404 when DB fallback also returns null', async () => {
    const sentMessages: unknown[] = [];
    const { app } = buildApp({}, sentMessages, async () => null);

    const res = await app.request('/r/ghost-slug', { method: 'GET' });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('link_not_found');
  });

  // -------------------------------------------------------------------------
  // Archived — 410 Gone
  // -------------------------------------------------------------------------
  it('returns 410 when link status is archived', async () => {
    const kvStore = { 'redirect:old-campaign': ARCHIVED_LINK };
    const sentMessages: unknown[] = [];
    const { app } = buildApp(kvStore, sentMessages);

    const res = await app.request('/r/old-campaign', { method: 'GET' });

    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('archived');
  });

  // -------------------------------------------------------------------------
  // Click enqueue — INV-ATTRIBUTION-003
  // queue.send must be called with correct workspace_id + link_id
  // -------------------------------------------------------------------------
  it('INV-ATTRIBUTION-003: enqueues link_click event (queue.send called)', async () => {
    const kvStore = { 'redirect:trackme': ACTIVE_LINK };
    const sentMessages: unknown[] = [];
    const { app, waitUntilPromises } = buildApp(kvStore, sentMessages);

    const res = await app.request('/r/trackme', { method: 'GET' });
    expect(res.status).toBe(302);

    // Drain waitUntil promises so queue.send is invoked
    await Promise.allSettled(waitUntilPromises);

    // BR-ATTRIBUTION-001: click recorded with workspace_id + link_id
    expect(sentMessages.length).toBeGreaterThan(0);
    const msg = sentMessages[0] as Record<string, unknown>;
    expect(msg.type).toBe('link_click');
    expect(msg.workspace_id).toBe('ws-test-001');
    expect(msg.link_id).toBe('lnk-abc-123');
    expect(msg.slug).toBe('trackme');
  });

  it('archived link does NOT enqueue a click', async () => {
    const kvStore = { 'redirect:archived-slug': ARCHIVED_LINK };
    const sentMessages: unknown[] = [];
    const { app, waitUntilPromises } = buildApp(kvStore, sentMessages);

    const res = await app.request('/r/archived-slug', { method: 'GET' });
    expect(res.status).toBe(410);

    await Promise.allSettled(waitUntilPromises);
    expect(sentMessages).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // DB fallback — cache miss + DB hit → 302 + KV populated
  // -------------------------------------------------------------------------
  it('cache miss with DB hit → 302 and KV is populated', async () => {
    const kvStore: Record<string, unknown> = {};
    const sentMessages: unknown[] = [];
    const getLinkBySlug = vi.fn(async (_slug: string) => ACTIVE_LINK);

    const { app, waitUntilPromises } = buildApp(
      kvStore,
      sentMessages,
      getLinkBySlug,
    );

    const res = await app.request('/r/fresh-slug', { method: 'GET' });
    expect(res.status).toBe(302);

    // DB lookup must have been called
    expect(getLinkBySlug).toHaveBeenCalledWith('fresh-slug');

    // Drain waitUntil (KV put + queue send)
    await Promise.allSettled(waitUntilPromises);

    // KV should now contain the entry
    expect(kvStore['redirect:fresh-slug']).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Headers — X-Request-Id present in all responses
  // -------------------------------------------------------------------------
  it('includes X-Request-Id in 404 response', async () => {
    const sentMessages: unknown[] = [];
    const { app } = buildApp({}, sentMessages);

    const res = await app.request('/r/missing', { method: 'GET' });
    expect(res.status).toBe(404);
    // X-Request-Id may be set by sanitize-logs middleware upstream,
    // or by the route itself — either way it must be present.
    // In isolation (no global middleware) the route sets it directly.
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('includes X-Request-Id in 410 response', async () => {
    const kvStore = { 'redirect:stale': ARCHIVED_LINK };
    const sentMessages: unknown[] = [];
    const { app } = buildApp(kvStore, sentMessages);

    const res = await app.request('/r/stale', { method: 'GET' });
    expect(res.status).toBe(410);
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001 — no PII in error responses
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: 404 response body does not contain PII', async () => {
    const sentMessages: unknown[] = [];
    const { app } = buildApp({}, sentMessages);

    const res = await app.request('/r/someone@example.com', { method: 'GET' });

    const body = await res.text();
    // Email-like slug must not be echoed in the response
    expect(body).not.toContain('@');
    expect(body).not.toContain('someone');
  });

  // -------------------------------------------------------------------------
  // buildRedirectUrl helper — unit coverage
  // -------------------------------------------------------------------------
  describe('buildRedirectUrl', () => {
    it('appends UTM params to a clean URL', () => {
      const result = buildRedirectUrl('https://example.com/', {
        utm_source: 'fb',
        utm_medium: 'cpc',
      });
      const url = new URL(result);
      expect(url.searchParams.get('utm_source')).toBe('fb');
      expect(url.searchParams.get('utm_medium')).toBe('cpc');
    });

    it('does not overwrite existing UTM params', () => {
      const result = buildRedirectUrl(
        'https://example.com/?utm_source=organic',
        {
          utm_source: 'paid',
          utm_medium: 'email',
        },
      );
      const url = new URL(result);
      expect(url.searchParams.get('utm_source')).toBe('organic');
      expect(url.searchParams.get('utm_medium')).toBe('email');
    });

    it('skips undefined UTM values', () => {
      const result = buildRedirectUrl('https://example.com/', {
        utm_source: 'fb',
        utm_medium: undefined,
        utm_campaign: undefined,
      });
      const url = new URL(result);
      expect(url.searchParams.has('utm_medium')).toBe(false);
      expect(url.searchParams.has('utm_campaign')).toBe(false);
    });

    it('returns baseUrl as-is for malformed URL', () => {
      const bad = 'not-a-url';
      expect(buildRedirectUrl(bad, { utm_source: 'x' })).toBe(bad);
    });
  });
});
