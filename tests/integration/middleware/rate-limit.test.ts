/**
 * Integration tests — rate-limit middleware
 *
 * Covers:
 *   Happy path — requests under limit pass through with rate-limit headers
 *   Limit exceeded — returns 429 with Retry-After
 *   Route-specific limits — events (100) vs lead (20) vs default (60)
 *   KV failure — fail open (do not block traffic)
 *   Headers — X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 *
 * BR-PRIVACY-001: IP never in KV key in plain — key uses ip_hash
 * BR-PRIVACY-002: ip_hash = SHA-256 of IP
 *
 * Uses a mock KV namespace to avoid Cloudflare Workers dependency.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { rateLimit } from '../../../apps/edge/src/middleware/rate-limit.js';

// ---------------------------------------------------------------------------
// Mock KV namespace
// ---------------------------------------------------------------------------

class MockKV {
  private store = new Map<string, { value: string; expiresAt?: number }>();
  private _shouldThrow = false;

  throwOnNextOp() {
    this._shouldThrow = true;
  }

  async get(key: string): Promise<string | null> {
    if (this._shouldThrow) {
      this._shouldThrow = false;
      throw new Error('KV read error');
    }
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    if (this._shouldThrow) {
      this._shouldThrow = false;
      throw new Error('KV write error');
    }
    const expiresAt = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : undefined;
    this.store.set(key, { value, expiresAt });
  }

  /** Seed a counter directly (for testing limit exceeded). */
  async seedCounter(keyPattern: RegExp, value: number): Promise<void> {
    // Find or create a key matching the pattern
    for (const k of this.store.keys()) {
      if (keyPattern.test(k)) {
        this.store.set(k, { value: String(value) });
        return;
      }
    }
    // Key doesn't exist yet — set it with the default pattern used by middleware:
    // rl:{routeGroup}:{workspaceId}:{ipHash}:{bucket}
    // We can't know the exact key without running a request first — instead we
    // pre-run a dummy request and seed the count afterward.
  }

  /** Get current count for any key matching a route group prefix. */
  getCountForPrefix(prefix: string): number {
    for (const [k, v] of this.store.entries()) {
      if (k.startsWith(prefix)) return Number.parseInt(v.value, 10);
    }
    return 0;
  }

  /** Force a specific key to a value (used after discovering the key). */
  forceSet(key: string, value: number): void {
    this.store.set(key, { value: String(value) });
  }

  /** List all keys (for inspection). */
  listKeys(): string[] {
    return Array.from(this.store.keys());
  }
}

// ---------------------------------------------------------------------------
// App builder
// ---------------------------------------------------------------------------

function buildApp(
  kv: MockKV,
  routeGroup: 'events' | 'lead' | 'default',
  limitOverride?: number,
) {
  const app = new Hono<{
    Variables: { workspace_id: string; request_id: string };
  }>();

  // Inject workspace_id in context (simulates auth-public-token middleware)
  app.use('*', async (c, next) => {
    c.set('workspace_id', 'ws-rate-test');
    c.set('request_id', `req-${crypto.randomUUID()}`);
    await next();
  });

  // Use kvOverride to inject the mock KV — avoids mutating c.env (read-only in Node)
  app.use(
    '*',
    rateLimit({
      routeGroup,
      kvOverride: kv as unknown as KVNamespace,
      ...(limitOverride != null ? { limitOverride } : {}),
    }),
  );

  app.get('/probe', (c) => c.json({ ok: true }));
  app.post('/probe', (c) => c.json({ ok: true }));

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rateLimit middleware', () => {
  // -------------------------------------------------------------------------
  // Happy path — first request passes, headers set
  // -------------------------------------------------------------------------
  it('passes first request and sets rate-limit headers', async () => {
    const kv = new MockKV();
    const app = buildApp(kv, 'events');

    const res = await app.request('/probe', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '1.2.3.4' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('100');
    expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // Limit exceeded — returns 429 with Retry-After
  // -------------------------------------------------------------------------
  it('returns 429 when limit is exceeded', async () => {
    const kv = new MockKV();
    const app = buildApp(kv, 'events', 3); // low limit for test

    // Send 3 requests (fills the limit)
    for (let i = 0; i < 3; i++) {
      await app.request('/probe', {
        method: 'GET',
        headers: { 'CF-Connecting-IP': '10.0.0.1' },
      });
    }

    // 4th request should be rate limited
    const res = await app.request('/probe', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '10.0.0.1' },
    });

    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  // -------------------------------------------------------------------------
  // Route-specific limits — lead = 20
  // -------------------------------------------------------------------------
  it('uses route-specific limit for lead (20 req/min)', async () => {
    const kv = new MockKV();
    const app = buildApp(kv, 'lead');

    const res = await app.request('/probe', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '5.5.5.5' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('20');
  });

  // -------------------------------------------------------------------------
  // Different IPs are tracked independently
  // -------------------------------------------------------------------------
  it('tracks different IPs independently', async () => {
    const kv = new MockKV();
    const app = buildApp(kv, 'events', 1); // limit = 1 per IP

    // IP A: 1 request — should pass
    const res1 = await app.request('/probe', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '1.1.1.1' },
    });
    expect(res1.status).toBe(200);

    // IP A: 2nd request — should be rate limited
    const res2 = await app.request('/probe', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '1.1.1.1' },
    });
    expect(res2.status).toBe(429);

    // IP B: 1st request — should pass (different IP)
    const res3 = await app.request('/probe', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '2.2.2.2' },
    });
    expect(res3.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001 / BR-PRIVACY-002: IP never stored in plain in KV
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-002: KV keys contain ip_hash, not plain IP', async () => {
    const kv = new MockKV();
    const app = buildApp(kv, 'events');

    await app.request('/probe', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '192.168.99.1' },
    });

    const keys = kv.listKeys();
    expect(keys.length).toBeGreaterThan(0);

    // No key should contain the plain IP address
    for (const key of keys) {
      expect(key).not.toContain('192.168.99.1');
    }

    // Key format: rl:{group}:{workspace}:{64-char-hex}:{bucket}
    const key = keys[0];
    expect(key).toBeDefined();
    if (key) {
      const parts = key.split(':');
      expect(parts[0]).toBe('rl');
      // ip_hash part should be 64 hex chars
      const ipHashPart = parts[3];
      expect(ipHashPart).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // -------------------------------------------------------------------------
  // KV failure — fail open, do not block traffic
  // -------------------------------------------------------------------------
  it('fails open when KV read throws', async () => {
    const kv = new MockKV();
    kv.throwOnNextOp();
    const app = buildApp(kv, 'events');

    const res = await app.request('/probe', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': '3.3.3.3' },
    });

    // Should NOT be blocked — fail open
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------------
  // 429 response body contains no PII
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: 429 body contains no PII', async () => {
    const kv = new MockKV();
    const app = buildApp(kv, 'events', 0); // limit 0 = always rate limit

    const res = await app.request('/probe', {
      method: 'GET',
      headers: {
        'CF-Connecting-IP': '9.8.7.6',
        'X-Funil-Site': 'pk_live_secrettoken',
      },
    });

    expect(res.status).toBe(429);
    const body = await res.text();
    expect(body).not.toContain('9.8.7.6');
    expect(body).not.toContain('pk_live_secrettoken');
    expect(body).not.toMatch(/@[a-zA-Z]/);
  });
});
