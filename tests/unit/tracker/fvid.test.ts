/**
 * Unit tests — ensureVisitorId (INV-TRACKER-003, INV-TRACKER-007)
 *
 * INV-TRACKER-003: __fvid is only written when consent_analytics='granted'.
 * INV-TRACKER-002: uses crypto.randomUUID() — no external libraries.
 * INV-TRACKER-007: any failure (document unavailable, cookie blocked) returns null silently.
 * BR-CONSENT-004: own analytics cookies only with consent granted.
 *
 * Uses vi.stubGlobal to simulate document.cookie in the node environment,
 * following the pattern of tests/unit/tracker/cookies.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FVID_COOKIE,
  ensureVisitorId,
  parseCookieString,
  readVisitorIdCookie,
} from '../../../apps/tracker/src/cookies';

// ---------------------------------------------------------------------------
// parseCookieString — helper unit tests (pure function, no document needed)
// ---------------------------------------------------------------------------

describe('parseCookieString', () => {
  it('returns empty map for empty string', () => {
    expect(parseCookieString('')).toEqual({});
  });

  it('parses a single key=value pair', () => {
    expect(parseCookieString('foo=bar')).toEqual({ foo: 'bar' });
  });

  it('parses multiple key=value pairs separated by semicolons', () => {
    const result = parseCookieString('a=1; b=2; c=3');
    expect(result).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('handles URL-encoded values', () => {
    const result = parseCookieString('name=hello%20world');
    expect(result).toEqual({ name: 'hello world' });
  });
});

// ---------------------------------------------------------------------------
// ensureVisitorId — consent gate (INV-TRACKER-003)
// ---------------------------------------------------------------------------

describe('INV-TRACKER-003: ensureVisitorId consent gate', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when consentAnalytics=false — never writes cookie', () => {
    // Stub document so we can verify no writes happen
    const writtenCookies: string[] = [];
    vi.stubGlobal('document', {
      get cookie() {
        return '';
      },
      set cookie(value: string) {
        writtenCookies.push(value);
      },
    });

    // INV-TRACKER-003: only writes __fvid when consent_analytics='granted'
    const result = ensureVisitorId(false);
    expect(result).toBeNull();

    // No __fvid cookie was written
    const fvidWrites = writtenCookies.filter((c) => c.startsWith(FVID_COOKIE));
    expect(fvidWrites).toHaveLength(0);
  });

  it('generates a UUID v4 and writes __fvid cookie when consentAnalytics=true and cookie absent', () => {
    const writtenCookies: string[] = [];
    vi.stubGlobal('document', {
      get cookie() {
        return '';
      }, // no __fvid present
      set cookie(value: string) {
        writtenCookies.push(value);
      },
    });

    const result = ensureVisitorId(true);

    expect(result).not.toBeNull();
    // INV-TRACKER-002: valid UUID v4
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    // __fvid cookie was written
    const fvidWrite = writtenCookies.find((c) => c.startsWith(FVID_COOKIE));
    expect(fvidWrite).toBeDefined();
    expect(fvidWrite).toContain(result);
  });

  it('returns existing valid __fvid without generating a new one', () => {
    const existingId = '12345678-1234-4abc-8abc-123456789012';
    const writtenCookies: string[] = [];
    vi.stubGlobal('document', {
      get cookie() {
        return `${FVID_COOKIE}=${existingId}`;
      },
      set cookie(value: string) {
        writtenCookies.push(value);
      },
    });

    const result = ensureVisitorId(true);

    // Must return the existing ID — not a new one
    expect(result).toBe(existingId);
    // No new cookie write
    expect(writtenCookies).toHaveLength(0);
  });

  it('generates a new UUID when existing cookie value is not a valid UUID', () => {
    const writtenCookies: string[] = [];
    vi.stubGlobal('document', {
      get cookie() {
        return `${FVID_COOKIE}=not-a-uuid-value`;
      },
      set cookie(value: string) {
        writtenCookies.push(value);
      },
    });

    const result = ensureVisitorId(true);

    expect(result).not.toBeNull();
    expect(result).not.toBe('not-a-uuid-value');
    // New value is a valid UUID v4
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('generates a new UUID when existing cookie is empty string', () => {
    const writtenCookies: string[] = [];
    vi.stubGlobal('document', {
      get cookie() {
        return `${FVID_COOKIE}=`;
      },
      set cookie(value: string) {
        writtenCookies.push(value);
      },
    });

    const result = ensureVisitorId(true);

    expect(result).not.toBeNull();
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});

// ---------------------------------------------------------------------------
// INV-TRACKER-007: fail silently
// ---------------------------------------------------------------------------

describe('INV-TRACKER-007: ensureVisitorId fails silently on document errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when document.cookie getter throws', () => {
    // Simulate a browser security policy that blocks cookie read
    vi.stubGlobal('document', {
      get cookie(): string {
        throw new Error(
          'SecurityError: cookie access blocked by browser policy',
        );
      },
      set cookie(_value: string) {
        throw new Error(
          'SecurityError: cookie access blocked by browser policy',
        );
      },
    });

    // INV-TRACKER-007: must not throw
    expect(() => ensureVisitorId(true)).not.toThrow();
    const result = ensureVisitorId(true);
    expect(result).toBeNull();
  });

  it('returns null when document is undefined (non-browser context)', () => {
    // Simulate SSR / Web Worker context where document doesn't exist
    vi.stubGlobal('document', undefined);

    // INV-TRACKER-007: fail silently, return null
    expect(() => ensureVisitorId(true)).not.toThrow();
    const result = ensureVisitorId(true);
    expect(result).toBeNull();
  });
});
