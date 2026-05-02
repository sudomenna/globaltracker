/**
 * Cookie capture for the Funil tracker.
 *
 * INV-TRACKER-003: __fvid is only set when consent_analytics='granted' (Fase 3 — not yet implemented).
 * INV-TRACKER-004: __ftk is READ ONLY by the tracker — backend emits it via Set-Cookie.
 * BR-CONSENT-004: own cookies (analytics) only with consent granted.
 */

export const PLATFORM_COOKIE_NAMES = ['_gcl_au', '_ga', 'fbc', 'fbp'] as const;
export type PlatformCookieName = (typeof PLATFORM_COOKIE_NAMES)[number];

/** Cookie name for the lead token — set by backend, read by tracker. */
export const FTK_COOKIE = '__ftk';

/** Cookie name for anonymous visitor ID — Fase 3, not yet written by tracker. */
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
    fbc: readCookie('fbc'),
    fbp: readCookie('fbp'),
  };
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
 * INV-TRACKER-003: if Fase 3 writes this cookie, it only does so when consent_analytics='granted'.
 * This function only reads — tracker never creates __fvid in this implementation.
 */
export function readVisitorIdCookie(): string | null {
  // INV-TRACKER-003: __fvid is only set when consent_analytics='granted'
  // Reading is always safe; creating requires consent check (Fase 3).
  return readCookie(FVID_COOKIE);
}
