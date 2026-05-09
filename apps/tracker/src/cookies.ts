/**
 * Cookie capture for the Funil tracker.
 *
 * INV-TRACKER-003: __fvid is only set when consent_analytics='granted'.
 * INV-TRACKER-004: __ftk is READ ONLY by the tracker — backend emits it via Set-Cookie.
 * BR-CONSENT-004: own cookies (analytics) only with consent granted.
 */

/**
 * Canonical key names returned to the backend (Meta CAPI naming convention:
 * `fbc`/`fbp` without underscore prefix). Browser cookies, on the other hand,
 * are named `_fbc`/`_fbp` (with underscore — set by the Meta Pixel SDK). The
 * mapping happens inside `capturePlatformCookies`.
 */
export const PLATFORM_COOKIE_NAMES = ['_gcl_au', '_ga', 'fbc', 'fbp'] as const;
export type PlatformCookieName = (typeof PLATFORM_COOKIE_NAMES)[number];

/** Cookie name for the lead token — set by backend, read by tracker. */
export const FTK_COOKIE = '__ftk';

/** Cookie name for anonymous visitor ID — written by tracker only with consent (INV-TRACKER-003). */
export const FVID_COOKIE = '__fvid';

/**
 * Parse document.cookie string into a key→value map.
 * Exported for unit testing.
 */
export function parseCookieString(cookieStr: string): Record<string, string> {
  const map: Record<string, string> = {};
  if (!cookieStr) return map;

  for (const part of cookieStr.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      map[key] = decodeURIComponent(val);
    }
  }
  return map;
}

/**
 * Read a single cookie by name from document.cookie.
 * Returns null if not found or if document is unavailable.
 * Tracker never creates cookies here (INV-TRACKER-004).
 */
export function readCookie(name: string): string | null {
  try {
    if (typeof document === 'undefined') return null;
    const map = parseCookieString(document.cookie);
    return map[name] ?? null;
  } catch {
    // INV-TRACKER-007: fail silently
    return null;
  }
}

/**
 * Capture all platform cookies (read-only).
 * Returns a partial record; null values mean cookie absent.
 */
export function capturePlatformCookies(): Record<
  PlatformCookieName,
  string | null
> {
  return {
    _gcl_au: readCookie('_gcl_au'),
    _ga: readCookie('_ga'),
    // Meta Pixel SDK writes the cookies as `_fbc` / `_fbp` (underscore prefix);
    // we expose them under the CAPI-canonical keys `fbc` / `fbp` to the rest of
    // the tracker pipeline.
    fbc: readCookie('_fbc'),
    fbp: readCookie('_fbp'),
  };
}

/**
 * Build a Meta `_fbc` value from a URL `fbclid`, when the cookie itself is
 * absent. Format follows Meta spec:
 *   `fb.{subdomain_index}.{timestamp_ms}.{fbclid}`
 *
 * `subdomain_index = 1` matches what the Meta Pixel SDK writes for first-party
 * (root domain) usage. Without this fallback, leads who land on a page WITHOUT
 * the Meta Pixel loaded never get an `_fbc` cookie set, and we lose the click
 * attribution signal even though the `fbclid` is right there in the URL the
 * tracker already captures.
 */
export function buildFbcFromFbclid(fbclid: string | null): string | null {
  if (!fbclid || fbclid.length === 0) return null;
  return `fb.1.${Date.now()}.${fbclid}`;
}

/**
 * Read __ftk (lead_token cookie).
 * INV-TRACKER-004: tracker reads, never writes this cookie.
 * Backend emits it via Set-Cookie: __ftk=<token>; Path=/; SameSite=Lax; Secure; Max-Age=5184000
 */
export function readLeadTokenCookie(): string | null {
  return readCookie(FTK_COOKIE);
}

/**
 * Read __fvid (anonymous visitor ID cookie).
 * INV-TRACKER-003: reading is always safe; writing requires consent (see ensureVisitorId).
 * INV-TRACKER-004: __ftk is the lead token cookie — not affected here.
 */
export function readVisitorIdCookie(): string | null {
  return readCookie(FVID_COOKIE);
}

/**
 * Validate that a string is a UUID v4.
 * Used internally to verify __fvid values before trusting them.
 */
function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );
}

/**
 * Ensure a visitor ID cookie (__fvid) exists and return it.
 *
 * INV-TRACKER-003: only writes __fvid when consentAnalytics=true (consent_analytics='granted').
 * INV-TRACKER-002: uses crypto.randomUUID() — no external libraries.
 * INV-TRACKER-007: any failure (document unavailable, cookie blocked) returns null silently.
 * BR-CONSENT-004: own analytics cookies only with consent granted.
 *
 * @param consentAnalytics - true when consent_analytics='granted', false otherwise.
 * @returns the visitor UUID string, or null if consent denied or on any error.
 */
export function ensureVisitorId(consentAnalytics: boolean): string | null {
  // INV-TRACKER-003: only set __fvid when consent_analytics='granted'
  if (!consentAnalytics) return null;

  try {
    // Read existing valid __fvid — avoid unnecessary writes
    const existing = readVisitorIdCookie();
    if (existing && isValidUuid(existing)) return existing;

    // INV-TRACKER-002: crypto.randomUUID() available in all modern browsers + CF Workers
    const newId = crypto.randomUUID();
    const maxAge = 365 * 24 * 60 * 60; // 1 year in seconds (31536000)
    document.cookie = `${FVID_COOKIE}=${newId}; Path=/; SameSite=Lax; Secure; Max-Age=${maxAge}`;
    return newId;
  } catch {
    // INV-TRACKER-007: fail silently — never break the host page
    return null;
  }
}
