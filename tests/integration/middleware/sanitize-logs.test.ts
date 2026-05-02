/**
 * Integration tests — sanitize-logs middleware and sanitize() helper
 *
 * Covers:
 *   BR-PRIVACY-001 — zero PII in log output
 *   sanitize() helper — redacts email, phone, name, ip, user_agent, and
 *     pattern-matched values (email regex, CPF regex)
 *   Middleware — sets request_id, attaches X-Request-Id to response
 *   Middleware — logs safe fields only (workspace_id, page_id, status_code, etc.)
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sanitize,
  sanitizeLogs,
} from '../../../apps/edge/src/middleware/sanitize-logs.js';

// ---------------------------------------------------------------------------
// sanitize() helper — unit tests
// ---------------------------------------------------------------------------

describe('sanitize() helper', () => {
  // -------------------------------------------------------------------------
  // Field name redaction
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: redacts email field by name', () => {
    const result = sanitize({ email: 'foo@bar.com', ok: true }) as Record<
      string,
      unknown
    >;
    expect(result.email).toBe('[REDACTED]');
    expect(result.ok).toBe(true);
  });

  it('BR-PRIVACY-001: redacts phone field by name', () => {
    const result = sanitize({ phone: '+5511999999999' }) as Record<
      string,
      unknown
    >;
    expect(result.phone).toBe('[REDACTED]');
  });

  it('BR-PRIVACY-001: redacts name field by name', () => {
    const result = sanitize({ name: 'John Doe' }) as Record<string, unknown>;
    expect(result.name).toBe('[REDACTED]');
  });

  it('BR-PRIVACY-001: redacts ip field by name', () => {
    const result = sanitize({ ip: '1.2.3.4' }) as Record<string, unknown>;
    expect(result.ip).toBe('[REDACTED]');
  });

  it('BR-PRIVACY-001: redacts user_agent field by name', () => {
    const result = sanitize({ user_agent: 'Mozilla/5.0' }) as Record<
      string,
      unknown
    >;
    expect(result.user_agent).toBe('[REDACTED]');
  });

  it('BR-PRIVACY-001: redacts authorization field by name (case-insensitive)', () => {
    const result = sanitize({ Authorization: 'Bearer secret' }) as Record<
      string,
      unknown
    >;
    expect(result.Authorization).toBe('[REDACTED]');
  });

  // -------------------------------------------------------------------------
  // Pattern-based redaction
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: redacts string value matching email pattern', () => {
    const result = sanitize({
      metadata: 'contact: user@example.com',
    }) as Record<string, unknown>;
    expect(result.metadata).toBe('[REDACTED]');
  });

  it('BR-PRIVACY-001: redacts string value matching CPF pattern', () => {
    const result = sanitize({ doc: '123.456.789-00' }) as Record<
      string,
      unknown
    >;
    expect(result.doc).toBe('[REDACTED]');
  });

  // -------------------------------------------------------------------------
  // Safe fields preserved
  // -------------------------------------------------------------------------
  it('preserves safe fields: workspace_id, page_id, event_type, status_code', () => {
    const result = sanitize({
      workspace_id: 'ws-abc',
      page_id: 'pg-def',
      event_type: 'PageView',
      status_code: 200,
    }) as Record<string, unknown>;

    expect(result.workspace_id).toBe('ws-abc');
    expect(result.page_id).toBe('pg-def');
    expect(result.event_type).toBe('PageView');
    expect(result.status_code).toBe(200);
  });

  // -------------------------------------------------------------------------
  // Nested objects
  // -------------------------------------------------------------------------
  it('recursively sanitizes nested objects', () => {
    const result = sanitize({
      outer: {
        safe: 'ok',
        inner: { email: 'leak@test.com', count: 5 },
      },
    }) as Record<string, unknown>;

    const outer = result.outer as Record<string, unknown>;
    expect(outer.safe).toBe('ok');
    const inner = outer.inner as Record<string, unknown>;
    expect(inner.email).toBe('[REDACTED]');
    expect(inner.count).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Arrays
  // -------------------------------------------------------------------------
  it('sanitizes items inside arrays', () => {
    const result = sanitize([{ email: 'a@b.com' }, { safe: 'value' }]) as Array<
      Record<string, unknown>
    >;
    expect(result[0]?.email).toBe('[REDACTED]');
    expect(result[1]?.safe).toBe('value');
  });

  // -------------------------------------------------------------------------
  // Primitives pass through unchanged
  // -------------------------------------------------------------------------
  it('returns primitives unchanged (non-PII)', () => {
    expect(sanitize(42)).toBe(42);
    expect(sanitize(true)).toBe(true);
    expect(sanitize(null)).toBe(null);
  });

  // -------------------------------------------------------------------------
  // Depth limit
  // -------------------------------------------------------------------------
  it('hits depth limit without throwing', () => {
    // Build a deeply nested object (>10 levels)
    let deep: Record<string, unknown> = { leaf: 'value' };
    for (let i = 0; i < 15; i++) deep = { nested: deep };
    expect(() => sanitize(deep)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sanitizeLogs() middleware — integration tests
// ---------------------------------------------------------------------------

describe('sanitizeLogs middleware', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  const loggedLines: string[] = [];

  beforeEach(() => {
    loggedLines.length = 0;
    consoleSpy = vi.spyOn(console, 'log').mockImplementation((...args) => {
      loggedLines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation((...args) => {
      loggedLines.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      loggedLines.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function buildApp() {
    const app = new Hono<{
      Variables: { workspace_id: string; page_id: string; request_id: string };
    }>();

    app.use('*', sanitizeLogs());

    // Simulate auth setting workspace context
    app.use('*', async (c, next) => {
      c.set('workspace_id', 'ws-log-test');
      c.set('page_id', 'pg-log-test');
      await next();
    });

    app.get('/v1/probe', (c) => c.json({ ok: true }));
    app.get('/v1/error', () => {
      throw new Error('boom');
    });

    return app;
  }

  // -------------------------------------------------------------------------
  // X-Request-Id header is set on response
  // -------------------------------------------------------------------------
  it('sets X-Request-Id header on response', async () => {
    const app = buildApp();
    const res = await app.request('/v1/probe', { method: 'GET' });

    expect(res.headers.get('X-Request-Id')).toBeTruthy();
    // Should be a UUID format
    expect(res.headers.get('X-Request-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  // -------------------------------------------------------------------------
  // BR-PRIVACY-001: logs contain no PII
  // -------------------------------------------------------------------------
  it('BR-PRIVACY-001: log lines contain no email, IP, or user agent in plain', async () => {
    const app = buildApp();

    await app.request('/v1/probe', {
      method: 'GET',
      headers: {
        'CF-Connecting-IP': '203.0.113.42',
        'User-Agent': 'Mozilla/5.0 Safari',
        'X-Funil-Site': 'pk_live_my_secret',
      },
    });

    const allLogs = loggedLines.join('\n');

    // No plain IP
    expect(allLogs).not.toContain('203.0.113.42');
    // No user agent in plain
    expect(allLogs).not.toContain('Mozilla/5.0 Safari');
    // No raw token
    expect(allLogs).not.toContain('pk_live_my_secret');
  });

  // -------------------------------------------------------------------------
  // Safe fields appear in logs
  // -------------------------------------------------------------------------
  it('logs workspace_id and page_id (safe fields)', async () => {
    const app = buildApp();
    await app.request('/v1/probe', { method: 'GET' });

    const allLogs = loggedLines.join('\n');
    expect(allLogs).toContain('ws-log-test');
    expect(allLogs).toContain('pg-log-test');
  });

  // -------------------------------------------------------------------------
  // Path without query string in logs
  // -------------------------------------------------------------------------
  it('logs path without query string (query may contain tokens)', async () => {
    const app = buildApp();
    await app.request('/v1/probe?token=secret_value&email=foo%40bar.com', {
      method: 'GET',
    });

    const allLogs = loggedLines.join('\n');
    // Path should appear
    expect(allLogs).toContain('/v1/probe');
    // Query string values should NOT appear
    expect(allLogs).not.toContain('secret_value');
    expect(allLogs).not.toContain('foo@bar.com');
    expect(allLogs).not.toContain('foo%40bar.com');
  });

  // -------------------------------------------------------------------------
  // Status code logged on response
  // -------------------------------------------------------------------------
  it('logs status_code in request_end event', async () => {
    const app = buildApp();
    await app.request('/v1/probe', { method: 'GET' });

    const endLog = loggedLines.find((l) => l.includes('request_end'));
    expect(endLog).toBeDefined();
    if (endLog) {
      const parsed = JSON.parse(endLog) as Record<string, unknown>;
      expect(parsed.status_code).toBe(200);
    }
  });

  // -------------------------------------------------------------------------
  // request_id is consistent between request_start and request_end
  // -------------------------------------------------------------------------
  it('uses consistent request_id across start and end log events', async () => {
    const app = buildApp();
    await app.request('/v1/probe', { method: 'GET' });

    const startLog = loggedLines.find((l) => l.includes('request_start'));
    const endLog = loggedLines.find((l) => l.includes('request_end'));

    expect(startLog).toBeDefined();
    expect(endLog).toBeDefined();

    if (startLog && endLog) {
      const start = JSON.parse(startLog) as Record<string, unknown>;
      const end = JSON.parse(endLog) as Record<string, unknown>;
      expect(start.request_id).toBe(end.request_id);
    }
  });
});
