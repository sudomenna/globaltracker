/**
 * Integration tests — cors middleware
 *
 * Covers:
 *   INV-PAGE-007 — origin validated against pages.allowed_domains (suffix match)
 *   Happy path — allowed origin receives CORS headers
 *   Rejected origin — no CORS headers (browser blocks)
 *   OPTIONS preflight — 204 with CORS headers for allowed origin
 *   OPTIONS preflight — 403 for disallowed origin
 *   Subdomain match — `sub.cliente.com` allowed when `cliente.com` is in list
 *   Admin mode — fixed origin list
 *
 * BR-PRIVACY-001 — no PII in log output (structural only — sanitize-logs tested separately)
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  type GetAllowedDomainsFn,
  corsMiddleware,
  originMatchesDomains,
} from '../../../apps/edge/src/middleware/cors.js';

// ---------------------------------------------------------------------------
// Unit tests for originMatchesDomains helper
// ---------------------------------------------------------------------------

describe('originMatchesDomains helper', () => {
  it('matches exact domain', () => {
    expect(originMatchesDomains('https://cliente.com', ['cliente.com'])).toBe(
      true,
    );
  });

  it('matches subdomain — INV-PAGE-007 suffix match', () => {
    expect(
      originMatchesDomains('https://app.cliente.com', ['cliente.com']),
    ).toBe(true);
    expect(
      originMatchesDomains('https://sub.app.cliente.com', ['cliente.com']),
    ).toBe(true);
  });

  it('rejects unrelated domain', () => {
    expect(originMatchesDomains('https://evil.com', ['cliente.com'])).toBe(
      false,
    );
  });

  it('rejects domain that merely contains allowed domain as substring', () => {
    // 'notcliente.com' should NOT match 'cliente.com'
    expect(
      originMatchesDomains('https://notcliente.com', ['cliente.com']),
    ).toBe(false);
  });

  it('returns false for malformed origin', () => {
    expect(originMatchesDomains('not-a-url', ['cliente.com'])).toBe(false);
  });

  it('returns false for empty allowed list', () => {
    expect(originMatchesDomains('https://cliente.com', [])).toBe(false);
  });

  it('matches multiple domains in list', () => {
    const domains = ['other.com', 'cliente.com'];
    expect(originMatchesDomains('https://app.cliente.com', domains)).toBe(true);
    expect(originMatchesDomains('https://other.com', domains)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — Hono app with corsMiddleware
// ---------------------------------------------------------------------------

function buildPublicApp(allowedDomainsMap: Record<string, string[]>) {
  const getAllowedDomains: GetAllowedDomainsFn = async (pageId) =>
    allowedDomainsMap[pageId] ?? [];

  const app = new Hono<{
    Variables: { workspace_id: string; page_id: string; request_id: string };
  }>();

  // Simulate auth middleware setting page_id and workspace_id
  app.use('*', async (c, next) => {
    c.set('page_id', 'pg-test');
    c.set('workspace_id', 'ws-test');
    await next();
  });

  app.use('*', corsMiddleware({ mode: 'public', getAllowedDomains }));

  app.get('/v1/probe', (c) => c.json({ ok: true }));
  app.options('/v1/probe', () => new Response(null, { status: 204 }));

  return app;
}

describe('corsMiddleware — public mode', () => {
  const allowedDomainsMap = { 'pg-test': ['cliente.com'] };

  // -------------------------------------------------------------------------
  // Allowed origin — response includes CORS headers
  // -------------------------------------------------------------------------
  it('sets Access-Control-Allow-Origin for allowed origin', async () => {
    const app = buildPublicApp(allowedDomainsMap);
    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { Origin: 'https://cliente.com' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://cliente.com',
    );
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  // -------------------------------------------------------------------------
  // Subdomain match (INV-PAGE-007)
  // -------------------------------------------------------------------------
  it('INV-PAGE-007: allows subdomain of permitted domain', async () => {
    const app = buildPublicApp(allowedDomainsMap);
    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { Origin: 'https://app.cliente.com' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.cliente.com',
    );
  });

  // -------------------------------------------------------------------------
  // Rejected origin — no CORS headers (browser blocks it)
  // -------------------------------------------------------------------------
  it('omits CORS headers for disallowed origin', async () => {
    const app = buildPublicApp(allowedDomainsMap);
    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { Origin: 'https://evil.com' },
    });

    // Request proceeds (route handler runs) but no CORS headers
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // No Origin header — pass through without CORS headers
  // -------------------------------------------------------------------------
  it('passes request without Origin header (same-origin)', async () => {
    const app = buildPublicApp(allowedDomainsMap);
    const res = await app.request('/v1/probe', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // OPTIONS preflight — allowed origin → 204
  // -------------------------------------------------------------------------
  it('responds 204 to OPTIONS preflight for allowed origin', async () => {
    const app = buildPublicApp(allowedDomainsMap);
    const res = await app.request('/v1/probe', {
      method: 'OPTIONS',
      headers: { Origin: 'https://cliente.com' },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://cliente.com',
    );
    expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
  });

  // -------------------------------------------------------------------------
  // OPTIONS preflight — disallowed origin → 403
  // -------------------------------------------------------------------------
  it('responds 403 to OPTIONS preflight for disallowed origin', async () => {
    const app = buildPublicApp(allowedDomainsMap);
    const res = await app.request('/v1/probe', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.com' },
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Vary: Origin header is present
  // -------------------------------------------------------------------------
  it('sets Vary: Origin on allowed response', async () => {
    const app = buildPublicApp(allowedDomainsMap);
    const res = await app.request('/v1/probe', {
      method: 'GET',
      headers: { Origin: 'https://cliente.com' },
    });

    expect(res.headers.get('Vary')).toBe('Origin');
  });
});

// ---------------------------------------------------------------------------
// Admin mode — fixed origin allowlist
// ---------------------------------------------------------------------------

describe('corsMiddleware — admin mode', () => {
  function buildAdminApp() {
    const app = new Hono();
    app.use(
      '*',
      corsMiddleware({
        mode: 'admin',
        adminAllowedOrigins: ['https://app.globaltracker.io'],
      }),
    );
    app.get('/admin/probe', (c) => c.json({ ok: true }));
    app.options('/admin/probe', () => new Response(null, { status: 204 }));
    return app;
  }

  it('allows configured admin origin', async () => {
    const app = buildAdminApp();
    const res = await app.request('/admin/probe', {
      method: 'GET',
      headers: { Origin: 'https://app.globaltracker.io' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.globaltracker.io',
    );
  });

  it('rejects unknown origin in admin mode', async () => {
    const app = buildAdminApp();
    const res = await app.request('/admin/probe', {
      method: 'GET',
      headers: { Origin: 'https://attacker.com' },
    });

    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
