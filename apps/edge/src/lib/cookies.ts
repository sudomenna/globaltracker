/**
 * Cookie helper — parse and serialize HTTP cookies.
 *
 * Designed for Cloudflare Workers (no Node.js `http` builtins).
 * Provides typed serialization with security defaults for the lead token cookie.
 *
 * BR-IDENTITY-005: lead_token cookie (__ftk) must be httpOnly, Secure, SameSite=Lax
 *   so it cannot be read by page JS and is not sent cross-site.
 * INV-IDENTITY-006: cookie value is the HMAC token; validation is done server-side.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Canonical name for the lead-token cookie.
 * Short name (`__ftk`) minimises request payload size.
 */
export const LEAD_TOKEN_COOKIE = '__ftk';

/** Default max-age for the lead token cookie: 180 days (seconds). */
export const LEAD_TOKEN_DEFAULT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60; // 15_552_000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SameSitePolicy = 'Strict' | 'Lax' | 'None';

export interface CookieOptions {
  /** Prevents JavaScript access via `document.cookie`. */
  httpOnly?: boolean;
  /** Requires HTTPS; omit only in localhost dev environments. */
  secure?: boolean;
  sameSite?: SameSitePolicy;
  /** Max-age in seconds. If 0 or negative, the cookie is deleted. */
  maxAge?: number;
  /** Explicit domain (omit to default to host-only behavior). */
  domain?: string;
  /** Cookie path; defaults to `/`. */
  path?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a `Cookie` request header into a key→value map.
 *
 * Handles duplicate keys by returning the last value (RFC 6265 §5.2).
 * Returns an empty object for a missing or empty header.
 *
 * @param cookieHeader - value of the `Cookie` header (may be null/undefined)
 */
export function parseCookies(
  cookieHeader: string | null | undefined,
): Record<string, string> {
  if (!cookieHeader) return {};

  const result: Record<string, string> = {};
  const pairs = cookieHeader.split(';');

  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=');
    if (eqIndex < 0) continue; // bare names without value are ignored

    const name = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();

    if (!name) continue;

    // Decode percent-encoded characters in name and value
    try {
      result[decodeURIComponent(name)] = decodeURIComponent(value);
    } catch {
      // If decoding fails, store raw values (malformed cookie — be lenient)
      result[name] = value;
    }
  }

  return result;
}

/**
 * Serialize a cookie name + value with the given options into a `Set-Cookie`
 * header value string.
 *
 * @param name    - cookie name (must not contain `=`, `;`, ` `, etc.)
 * @param value   - cookie value (percent-encoded automatically)
 * @param opts    - security and lifetime options
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: CookieOptions = {},
): string {
  const parts: string[] = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
  ];

  const path = opts.path ?? '/';
  parts.push(`Path=${path}`);

  if (opts.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.trunc(opts.maxAge)}`);
  }

  if (opts.domain) {
    parts.push(`Domain=${opts.domain}`);
  }

  if (opts.sameSite) {
    parts.push(`SameSite=${opts.sameSite}`);
  }

  if (opts.httpOnly) {
    parts.push('HttpOnly');
  }

  if (opts.secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/**
 * Build the `Set-Cookie` header value for the lead token cookie (`__ftk`).
 *
 * Security defaults: HttpOnly, Secure, SameSite=Lax.
 *
 * BR-IDENTITY-005: httpOnly prevents JS access; Secure prevents plain-HTTP
 *   transmission; SameSite=Lax blocks CSRF while allowing top-level navigations.
 * INV-IDENTITY-006: cookie is validated server-side before granting lead_id.
 *
 * @param token  - HMAC token string (from generateLeadToken)
 * @param maxAge - optional override for Max-Age (seconds); defaults to 180 days
 */
export function buildLeadTokenCookie(
  token: string,
  maxAge: number = LEAD_TOKEN_DEFAULT_MAX_AGE_SECONDS,
): string {
  // The tracker reads __ftk via document.cookie on subsequent pages
  // (INV-TRACKER-004), so HttpOnly is dropped. Cross-origin (LP ↔ Edge)
  // requires SameSite=None + Secure; the token itself is HMAC-bound to
  // workspace+lead so theft alone cannot impersonate other workspaces.
  return serializeCookie(LEAD_TOKEN_COOKIE, token, {
    httpOnly: false,
    secure: true,
    sameSite: 'None',
    maxAge,
    path: '/',
  });
}
