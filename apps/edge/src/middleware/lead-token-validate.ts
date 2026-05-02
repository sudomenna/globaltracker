/**
 * middleware/lead-token-validate.ts — Validate __ftk cookie and inject lead_id.
 *
 * T-ID: T-2-010
 * CONTRACT-id: CONTRACT-api-events-v1 (used on /v1/events)
 *
 * Reads the __ftk cookie, validates it against the DB (HMAC + page binding),
 * and injects `lead_id` into the Hono context when valid.
 *
 * Design invariants:
 *   - Cookie absent → pass through without lead_id (anonymous event — valid).
 *   - Cookie present but invalid → log warn (no PII), pass through without lead_id.
 *     Events are still accepted anonymously. We never reject on bad cookie.
 *   - Cookie present and valid → inject c.set('lead_id', lead_id).
 *
 * BR-IDENTITY-005: HMAC verified before DB lookup; token value never logged.
 * INV-IDENTITY-006: page_token_hash from X-Funil-Site must match DB row.
 * BR-PRIVACY-001: no PII in logs; __ftk value never logged.
 */

import type { Db } from '@globaltracker/db';
import type { Context, Next } from 'hono';
import { parseCookies } from '../lib/cookies.js';
import { validateLeadToken } from '../lib/lead-token.js';
import { safeLog } from './sanitize-logs.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fallback HMAC secret for local dev/test — never used in production. */
const DEV_HMAC_SECRET_FALLBACK = 'dev-only-insecure-secret-do-not-use-in-prod';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
  LEAD_TOKEN_HMAC_SECRET?: string;
  LEAD_TOKEN_SECRET?: string;
};

type AppVariables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
  lead_id?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the lead token validation middleware with an optional DB instance.
 *
 * @param db - Drizzle DB instance. When absent, middleware passes through
 *             silently (no DB row lookup possible — anonymous event path).
 */
export function createLeadTokenValidateMiddleware(db?: Db) {
  return async function leadTokenValidateMiddleware(
    c: Context<AppEnv>,
    next: Next,
  ): Promise<Response | undefined> {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');

    // -----------------------------------------------------------------------
    // Step 1: Read __ftk from Cookie header
    // BR-PRIVACY-001: never log the cookie value
    // -----------------------------------------------------------------------
    const cookieHeader = c.req.header('cookie') ?? c.req.header('Cookie');
    const cookies = parseCookies(cookieHeader);
    // biome-ignore lint/complexity/useLiteralKeys: __ftk has double-underscore prefix which requires bracket access in some linters
    const ftkCookie = cookies['__ftk'];

    if (!ftkCookie) {
      // No cookie — anonymous event; pass through
      await next();
      return;
    }

    // -----------------------------------------------------------------------
    // Step 2: Ensure DB is available for DB lookup
    // If DB is absent, we cannot validate — treat as anonymous.
    // -----------------------------------------------------------------------
    if (!db) {
      // No DB binding — cannot validate; treat as anonymous silently
      await next();
      return;
    }

    // -----------------------------------------------------------------------
    // Step 3: Resolve HMAC secret
    // BR-IDENTITY-005: secret from Wrangler secret; fallback for dev only
    // -----------------------------------------------------------------------
    const hmacSecretStr =
      // events.ts uses LEAD_TOKEN_SECRET; lead.ts uses LEAD_TOKEN_HMAC_SECRET
      // Support both binding names for forward compat
      c.env.LEAD_TOKEN_HMAC_SECRET ??
      c.env.LEAD_TOKEN_SECRET ??
      DEV_HMAC_SECRET_FALLBACK;
    const hmacSecret = new TextEncoder().encode(hmacSecretStr);

    // -----------------------------------------------------------------------
    // Step 4: Compute current page_token_hash from X-Funil-Site header
    // INV-IDENTITY-006: token valid only on the page it was issued for
    // -----------------------------------------------------------------------
    const funiSiteHeader = c.req.header('x-funil-site') ?? '';
    const currentPageTokenHash = await sha256Hex(funiSiteHeader);

    // -----------------------------------------------------------------------
    // Step 5: Validate token
    // BR-IDENTITY-005: HMAC verified; DB row checked
    // INV-IDENTITY-006: page_token_hash must match
    // -----------------------------------------------------------------------
    const result = await validateLeadToken(
      ftkCookie,
      currentPageTokenHash,
      db,
      hmacSecret,
    );

    if (!result.ok) {
      // BR-PRIVACY-001: no token value or PII in log
      safeLog('warn', {
        event: 'lead_token_invalid',
        request_id: requestId,
        workspace_id: workspaceId ?? 'unknown',
        error_code: result.error.code,
        // BR-PRIVACY-001: __ftk value never logged
      });
      // Pass through as anonymous — events are still accepted
      await next();
      return;
    }

    // -----------------------------------------------------------------------
    // Step 6: Inject lead_id into context
    // -----------------------------------------------------------------------
    c.set('lead_id', result.value.lead_id);

    await next();
  };
}

// ---------------------------------------------------------------------------
// Default middleware instance (no DB — for backward compat)
// ---------------------------------------------------------------------------

/** Default no-op-when-no-db variant for easy mounting without DI. */
export const leadTokenValidateMiddleware = createLeadTokenValidateMiddleware();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** SHA-256 hex — Web Crypto only; CF Workers compatible. */
async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
