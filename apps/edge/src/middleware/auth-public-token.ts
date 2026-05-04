/**
 * auth-public-token.ts — Hono middleware for public page_token authentication.
 *
 * Reads the page_token from `X-Funil-Site` or `Authorization: Bearer <token>`,
 * hashes it with SHA-256, and queries `page_tokens` + `pages` to resolve
 * workspace_id and page_id.
 *
 * INV-PAGE-007: token binds request to an isolated workspace — prevents
 *   cross-workspace data access.
 * INV-PAGE-005: revoked tokens return 401 (not 403) — logged as legacy_token_in_use=false.
 *
 * BR-PRIVACY-001: no PII in logs — only workspace_id, page_id, status code.
 * BR-PRIVACY-002: token is hashed in-memory; raw token never logged or stored.
 *
 * Security: hash comparison is done via constant-time DB lookup on token_hash.
 * The clear token is never persisted or logged.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthPublicTokenEnv {
  Variables: {
    workspace_id: string;
    page_id: string;
    launch_id: string | null;
    request_id: string;
  };
  Bindings: {
    GT_KV: KVNamespace;
    DB: Fetcher; // Hyperdrive or direct DB access — injected by app
  };
}

/** Minimal DB interface expected by this middleware — injected via context. */
export interface PageTokenRow {
  workspaceId: string;
  pageId: string;
  launchId: string | null;
  status: 'active' | 'rotating' | 'revoked';
}

/** DB query function injected by the app to avoid direct DB coupling in middleware. */
export type LookupPageTokenFn = (
  tokenHash: string,
  bindings: Record<string, unknown>,
) => Promise<PageTokenRow | null>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_HEADER_PRIMARY = 'X-Funil-Site';
const TOKEN_HEADER_SECONDARY = 'Authorization';
const BEARER_PREFIX = 'Bearer ';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Hash the raw token using SHA-256 and return hex string.
 * BR-PRIVACY-002: token plaintext is transient — only hash is used downstream.
 */
async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Extract raw token from request headers.
 * Accepts `X-Funil-Site: <token>` (primary) or `Authorization: Bearer <token>`.
 */
function extractToken(c: Context): string | null {
  const funil = c.req.header(TOKEN_HEADER_PRIMARY);
  if (funil && funil.trim().length > 0) return funil.trim();

  const auth = c.req.header(TOKEN_HEADER_SECONDARY);
  if (auth?.startsWith(BEARER_PREFIX)) {
    const token = auth.slice(BEARER_PREFIX.length).trim();
    if (token.length > 0) return token;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Create the auth-public-token middleware with an injected DB lookup function.
 *
 * Usage:
 * ```ts
 * app.use('/v1/*', authPublicToken(lookupPageTokenFromDb));
 * ```
 *
 * @param lookupPageToken — async function that queries page_tokens by hash.
 */
export function authPublicToken(
  lookupPageToken: LookupPageTokenFn,
): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    // OPTIONS preflight must not be blocked by auth — CORS headers are set by corsMiddleware
    if (c.req.method === 'OPTIONS') return next();

    const requestId = c.get('request_id') ?? crypto.randomUUID();

    const rawToken = extractToken(c);

    if (!rawToken) {
      // BR-PRIVACY-001: no PII in error response
      return c.json(
        {
          code: 'missing_token',
          message: 'Authorization token required. Provide X-Funil-Site header.',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    const tokenHash = await hashToken(rawToken);

    let row: PageTokenRow | null;
    try {
      row = await lookupPageToken(tokenHash, c.env as Record<string, unknown>);
    } catch (err) {
      // DB error — do not leak details
      // BR-PRIVACY-001: log only non-PII fields
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'auth_token_lookup_failed',
          request_id: requestId,
          err: String(err),
        }),
      );
      return c.json(
        {
          code: 'internal_error',
          message: 'Token validation unavailable. Try again.',
          request_id: requestId,
        },
        500,
        { 'X-Request-Id': requestId },
      );
    }

    if (!row) {
      // INV-PAGE-003: unknown token_hash → 401 (not 403 — attacker should not know format)
      return c.json(
        {
          code: 'invalid_token',
          message: 'Token not recognised.',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    if (row.status === 'revoked') {
      // INV-PAGE-005: revoked token → 401; metric legacy_token_in_use=false
      // BR-PRIVACY-001: workspace_id is safe to log; no PII
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'revoked_token_used',
          workspace_id: row.workspaceId,
          page_id: row.pageId,
          request_id: requestId,
          legacy_token_in_use: false,
        }),
      );
      return c.json(
        {
          code: 'invalid_token',
          message: 'Token has been revoked.',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // status === 'active' or 'rotating' — both authenticate
    // INV-PAGE-007: token binds request to this workspace/page — enforces isolation
    c.set('workspace_id', row.workspaceId);
    c.set('page_id', row.pageId);
    c.set('launch_id', row.launchId ?? null);

    await next();
  });
}
