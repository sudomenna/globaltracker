/**
 * rate-limit.ts — Hono sliding-window rate limiter using Cloudflare KV.
 *
 * Limits are applied per (workspace_id, ip_hash) per route group.
 * IP is never stored in plain — only SHA-256 hash (BR-PRIVACY-001, BR-PRIVACY-002).
 *
 * Default limits (per 60-second window):
 *   /v1/events : 100 req/min per (workspace_id, ip_hash)
 *   /v1/lead   : 20  req/min per (workspace_id, ip_hash)
 *   default    : 60  req/min per (workspace_id, ip_hash)
 *
 * KV key format: `rl:{route_group}:{workspace_id}:{ip_hash}:{window_bucket}`
 * where window_bucket = Math.floor(Date.now() / WINDOW_MS)
 *
 * Response headers (05-api-server-actions.md §Headers):
 *   X-RateLimit-Limit
 *   X-RateLimit-Remaining
 *   X-RateLimit-Reset  (epoch seconds of window reset)
 *
 * Returns 429 with Retry-After header when limit exceeded.
 *
 * BR-PRIVACY-001: IP never logged or stored in plain — only hash.
 * BR-PRIVACY-002: ip_hash = SHA-256 of IP string.
 */

import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouteGroup = 'events' | 'lead' | 'config' | 'default';

export interface RateLimitOptions {
  /** Route group key — determines limit from ROUTE_LIMITS. */
  routeGroup: RouteGroup;
  /** Override limit for this middleware instance. */
  limitOverride?: number;
  /** Window in milliseconds (default: 60_000). */
  windowMs?: number;
  /**
   * KV namespace override — used in tests to inject a mock KV.
   * In production this is always sourced from `c.env.GT_KV`.
   */
  kvOverride?: KVNamespace;
}

export interface RateLimitEnv {
  Variables: {
    workspace_id: string;
    request_id: string;
  };
  Bindings: {
    GT_KV: KVNamespace;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000; // 1 minute sliding window

/** Default per-minute limits by route group. */
const ROUTE_LIMITS: Record<RouteGroup, number> = {
  events: 100,
  lead: 20,
  config: 60,
  default: 60,
};

const KV_TTL_SECONDS = 120; // keep counter keys alive for 2 windows

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Hash IP address with SHA-256.
 * BR-PRIVACY-001: IP never stored in plain.
 * BR-PRIVACY-002: only ip_hash persisted.
 */
async function hashIp(ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(ip);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Extract client IP from CF-Connecting-IP header (set by Cloudflare). */
function getClientIp(req: Request): string {
  // Cloudflare Workers: CF-Connecting-IP is the real client IP
  const cfIp = req.headers.get('CF-Connecting-IP');
  if (cfIp?.trim()) return cfIp.trim();
  // Fallback for local dev / test environments
  const forwarded = req.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  return 'unknown';
}

/** Build KV key for the current window bucket. */
function buildKvKey(
  routeGroup: string,
  workspaceId: string,
  ipHash: string,
  windowMs: number,
): string {
  const bucket = Math.floor(Date.now() / windowMs);
  return `rl:${routeGroup}:${workspaceId}:${ipHash}:${bucket}`;
}

/** Compute epoch seconds when the current window resets. */
function windowResetEpoch(windowMs: number): number {
  const bucket = Math.floor(Date.now() / windowMs);
  return Math.floor(((bucket + 1) * windowMs) / 1000);
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Rate-limit middleware with KV sliding window.
 *
 * Must be placed AFTER auth-public-token so that workspace_id is available.
 *
 * Usage:
 * ```ts
 * app.post('/v1/events', authPublicToken(lookup), rateLimit({ routeGroup: 'events' }), handler);
 * ```
 */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const windowMs = options.windowMs ?? WINDOW_MS;
  const limit = options.limitOverride ?? ROUTE_LIMITS[options.routeGroup];

  return createMiddleware(async (c, next) => {
    // KV binding — prefer injected override (tests), fall back to CF Workers binding
    const kv: KVNamespace | undefined =
      options.kvOverride ?? (c.env.GT_KV as KVNamespace | undefined);
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // workspace_id must be set by auth-public-token middleware
    const workspaceId: string | undefined = c.get('workspace_id') as
      | string
      | undefined;
    if (!workspaceId) {
      // Missing auth context — pass through; auth middleware will have rejected already
      await next();
      return;
    }

    // KV not available — fail open (e.g., local dev without wrangler bindings)
    if (!kv) {
      await next();
      return;
    }

    // BR-PRIVACY-001 / BR-PRIVACY-002: hash IP before any use
    const rawIp = getClientIp(c.req.raw);
    const ipHash = await hashIp(rawIp);

    const key = buildKvKey(options.routeGroup, workspaceId, ipHash, windowMs);
    const resetAt = windowResetEpoch(windowMs);

    let current = 0;
    try {
      const stored = await kv.get(key);
      current = stored ? Number.parseInt(stored, 10) : 0;
      if (Number.isNaN(current)) current = 0;
    } catch {
      // KV read failure — fail open (do not block legitimate traffic)
      // BR-PRIVACY-001: log only non-PII fields
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'rate_limit_kv_read_failed',
          workspace_id: workspaceId,
          route_group: options.routeGroup,
          request_id: requestId,
        }),
      );
      await next();
      return;
    }

    const remaining = Math.max(0, limit - current - 1);

    // Set rate-limit headers on every response
    // (attached after next() for non-limited requests)

    if (current >= limit) {
      const retryAfter = String(
        Math.max(1, resetAt - Math.floor(Date.now() / 1000)),
      );
      return c.json(
        {
          code: 'rate_limited',
          message: 'Too many requests. Slow down.',
          request_id: requestId,
        },
        429,
        {
          'X-Request-Id': requestId,
          'X-RateLimit-Limit': String(limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(resetAt),
          'Retry-After': retryAfter,
        },
      );
    }

    // Increment counter — fire-and-forget; do not block on KV write
    // waitUntil not available in middleware context; use direct await with short TTL
    try {
      await kv.put(key, String(current + 1), { expirationTtl: KV_TTL_SECONDS });
    } catch {
      // BR-PRIVACY-001: no PII in log
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'rate_limit_kv_write_failed',
          workspace_id: workspaceId,
          route_group: options.routeGroup,
          request_id: requestId,
        }),
      );
    }

    await next();

    // Attach rate-limit headers to the response
    c.res.headers.set('X-RateLimit-Limit', String(limit));
    c.res.headers.set('X-RateLimit-Remaining', String(remaining));
    c.res.headers.set('X-RateLimit-Reset', String(resetAt));
  });
}
