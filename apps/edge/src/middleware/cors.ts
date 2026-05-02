/**
 * cors.ts — Hono CORS middleware for public and admin routes.
 *
 * Public routes (/v1/config, /v1/events, /v1/lead): CORS is validated against
 * pages.allowed_domains (suffix match — subdomain ok).
 *
 * Admin routes: CORS is restricted to configured origins only.
 *
 * INV-PAGE-007: origin of request is validated against allowed_domains in
 *   b_snippet mode. Suffix match: `cliente.com` allows `app.cliente.com`.
 *
 * Contract (05-api-server-actions.md §CORS):
 *   Access-Control-Allow-Origin: echoes Origin if allowed, omitted otherwise.
 *   Access-Control-Allow-Methods: GET, POST, OPTIONS
 *   Access-Control-Allow-Headers: Content-Type, X-Funil-Site, X-Request-Id
 *   Access-Control-Max-Age: 86400
 *
 * BR-PRIVACY-001: no PII in logs — only workspace_id, page_id, origin (safe).
 */

import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, X-Funil-Site, X-Request-Id';
const MAX_AGE = '86400';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Function injected by app to resolve allowed_domains for a given page_id. */
export type GetAllowedDomainsFn = (pageId: string) => Promise<string[]>;

export type CorsMode = 'public' | 'admin';

export interface CorsOptions {
  mode: CorsMode;
  /** For admin mode: list of origins that are always allowed. */
  adminAllowedOrigins?: string[];
  /**
   * For public mode: function that returns allowed_domains for the page_id
   * already set in context by auth-public-token middleware.
   * Required when mode === 'public'.
   */
  getAllowedDomains?: GetAllowedDomainsFn;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Test whether `origin` matches any entry in `allowedDomains`.
 * Match rule: suffix match on eTLD+1 — an entry of `cliente.com` allows
 *   `cliente.com` and `*.cliente.com` (any subdomain).
 *
 * INV-PAGE-007: origin validated against allowed_domains with suffix/subdomain match.
 */
export function originMatchesDomains(
  origin: string,
  allowedDomains: string[],
): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const entry of allowedDomains) {
    const domain = entry.toLowerCase().replace(/^https?:\/\//, '');
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return true;
    }
  }
  return false;
}

function setCorsHeaders(
  headers: Record<string, string>,
  origin: string,
): Record<string, string> {
  return {
    ...headers,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': MAX_AGE,
    Vary: 'Origin',
  };
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * CORS middleware for public and admin routes.
 *
 * For public routes, place this AFTER auth-public-token so that `page_id` is
 * available in context for domain lookup.
 *
 * Example (public):
 * ```ts
 * app.use('/v1/*', authPublicToken(lookup), cors({ mode: 'public', getAllowedDomains }));
 * ```
 *
 * Example (admin):
 * ```ts
 * app.use('/admin/*', cors({ mode: 'admin', adminAllowedOrigins: ['https://app.globaltracker.io'] }));
 * ```
 */
export function corsMiddleware(options: CorsOptions): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const origin = c.req.header('Origin');
    const requestId: string =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // No Origin header → same-origin or non-browser request; skip CORS
    if (!origin) {
      await next();
      return;
    }

    let isAllowed = false;

    if (options.mode === 'admin') {
      const allowed = options.adminAllowedOrigins ?? [];
      isAllowed = allowed.includes(origin);
    } else {
      // Public mode: validate against page's allowed_domains
      const pageId: string | undefined = c.get('page_id') as string | undefined;

      if (!pageId || !options.getAllowedDomains) {
        // No page context yet (e.g., OPTIONS preflight before token auth)
        // Allow preflight to pass through; actual request will be blocked by auth middleware.
        // For non-preflight requests without page context we deny.
        if (c.req.method === 'OPTIONS') {
          isAllowed = true; // preflight handled permissively; auth handles security
        } else {
          isAllowed = false;
        }
      } else {
        const allowedDomains = await options.getAllowedDomains(pageId);
        // INV-PAGE-007: origin validation — suffix match
        isAllowed = originMatchesDomains(origin, allowedDomains);
      }
    }

    // Handle OPTIONS preflight
    if (c.req.method === 'OPTIONS') {
      if (isAllowed) {
        return new Response(null, {
          status: 204,
          headers: setCorsHeaders({}, origin),
        });
      }
      // Origin not allowed — return 403 with no CORS headers (browser blocks)
      return c.json(
        {
          code: 'origin_not_allowed',
          message: 'Origin not permitted.',
          request_id: requestId,
        },
        403,
      );
    }

    // Non-preflight: proceed and attach CORS headers if allowed
    await next();

    if (isAllowed) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
      c.res.headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      c.res.headers.set('Vary', 'Origin');
    }
    // If not allowed, no CORS headers → browser blocks cross-origin response
  });
}
