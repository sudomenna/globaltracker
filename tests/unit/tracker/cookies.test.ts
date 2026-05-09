/**
 * Unit tests for apps/tracker/src/cookies.ts
 *
 * Covers:
 *   INV-TRACKER-003: __fvid only set when consent_analytics='granted' (Fase 3 — not yet written by tracker)
 *   INV-TRACKER-004: __ftk is read-only — tracker never creates it
 *   BR-CONSENT-004: own analytics cookies only with consent granted
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FTK_COOKIE,
  FVID_COOKIE,
  PLATFORM_COOKIE_NAMES,
  capturePlatformCookies,
  parseCookieString,
  readCookie,
  readLeadTokenCookie,
  readVisitorIdCookie,
} from '../../../apps/tracker/src/cookies';

describe('parseCookieString', () => {
  it('parses a single cookie', () => {
    const result = parseCookieString('foo=bar');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('parses multiple cookies', () => {
    const result = parseCookieString('a=1; b=2; c=3');
    expect(result).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('decodes URI-encoded values', () => {
    const result = parseCookieString('name=hello%20world');
    expect(result).toEqual({ name: 'hello world' });
  });

  it('returns empty object for empty string', () => {
    expect(parseCookieString('')).toEqual({});
  });

  it('handles cookies with no value', () => {
    const result = parseCookieString('foo=');
    expect(result).toEqual({ foo: '' });
  });

  it('handles cookies with = in value', () => {
    const result = parseCookieString('token=abc=def=ghi');
    expect(result.token).toBe('abc=def=ghi');
  });
});

describe('readCookie', () => {
  beforeEach(() => {
    // Reset document.cookie mock
    vi.stubGlobal('document', {
      cookie: '_ga=GA1.1.123; _gcl_au=1.1.456; __ftk=tok_abc123',
    });
  });

  it('reads an existing cookie', () => {
    expect(readCookie('_ga')).toBe('GA1.1.123');
  });

  it('returns null for missing cookie', () => {
    expect(readCookie('nonexistent')).toBeNull();
  });

  it('returns null when document is unavailable', () => {
    vi.stubGlobal('document', undefined);
    expect(readCookie('_ga')).toBeNull();
  });
});

describe('capturePlatformCookies', () => {
  it('captures all platform cookies when present (Meta Pixel writes _fbc/_fbp with underscore)', () => {
    vi.stubGlobal('document', {
      cookie: '_gcl_au=gcl_val; _ga=ga_val; _fbc=fbc_val; _fbp=fbp_val',
    });
    const result = capturePlatformCookies();
    expect(result._gcl_au).toBe('gcl_val');
    expect(result._ga).toBe('ga_val');
    // Cookie source: `_fbc` / `_fbp` (Meta SDK names). Output key: CAPI canonical.
    expect(result.fbc).toBe('fbc_val');
    expect(result.fbp).toBe('fbp_val');
  });

  it('returns null for fbc/fbp when only legacy non-prefixed cookies exist', () => {
    // Guards against the previous bug where the tracker read `fbc`/`fbp`
    // (without underscore), which Meta Pixel never writes — silently emitting
    // null fbc/fbp on every event for months.
    vi.stubGlobal('document', { cookie: 'fbc=wrong; fbp=wrong' });
    const result = capturePlatformCookies();
    expect(result.fbc).toBeNull();
    expect(result.fbp).toBeNull();
  });

  it('returns null for absent platform cookies', () => {
    vi.stubGlobal('document', { cookie: '' });
    const result = capturePlatformCookies();
    for (const name of PLATFORM_COOKIE_NAMES) {
      expect(result[name]).toBeNull();
    }
  });

  it('does not write any cookies (read-only)', () => {
    // INV-TRACKER-004 / INV-TRACKER-003: tracker must not set platform or own cookies here
    const cookieDescriptor = {
      get: vi.fn(() => '_ga=ga_val'),
      set: vi.fn(),
    };
    vi.stubGlobal('document', { cookie: '_ga=ga_val' });
    Object.defineProperty(document, 'cookie', cookieDescriptor);
    capturePlatformCookies();
    // set should never have been called
    expect(cookieDescriptor.set).not.toHaveBeenCalled();
  });
});

describe('readLeadTokenCookie — INV-TRACKER-004', () => {
  it('reads __ftk when present', () => {
    // INV-TRACKER-004: backend sets __ftk; tracker only reads it
    vi.stubGlobal('document', {
      cookie: `${FTK_COOKIE}=signed_lead_token_abc`,
    });
    expect(readLeadTokenCookie()).toBe('signed_lead_token_abc');
  });

  it('returns null when __ftk absent', () => {
    vi.stubGlobal('document', { cookie: 'other=value' });
    expect(readLeadTokenCookie()).toBeNull();
  });

  it('does not have a setter — tracker never creates __ftk', async () => {
    // INV-TRACKER-004: tracker source must not call document.cookie = "__ftk=..."
    // We verify by checking the exported functions: readLeadTokenCookie only reads.
    // The function signature returns string|null — no write path exists.
    expect(typeof readLeadTokenCookie).toBe('function');
    // No write API is exported from cookies.ts for __ftk
    // Structural test: module API must NOT expose setLeadTokenCookie or writeLeadTokenCookie
    const cookiesModule = await import('../../../apps/tracker/src/cookies');
    // @ts-expect-error — intentionally checking that write APIs do not exist
    expect(
      (cookiesModule as Record<string, unknown>).setLeadTokenCookie,
    ).toBeUndefined();
    // @ts-expect-error — intentionally checking that write APIs do not exist
    expect(
      (cookiesModule as Record<string, unknown>).writeLeadTokenCookie,
    ).toBeUndefined();
  });
});

describe('readVisitorIdCookie — INV-TRACKER-003', () => {
  it('reads __fvid when present', () => {
    vi.stubGlobal('document', {
      cookie: `${FVID_COOKIE}=visitor_uuid_abc`,
    });
    expect(readVisitorIdCookie()).toBe('visitor_uuid_abc');
  });

  it('returns null when __fvid absent', () => {
    vi.stubGlobal('document', { cookie: '' });
    expect(readVisitorIdCookie()).toBeNull();
  });

  it('does not create __fvid — only reads (INV-TRACKER-003 Fase 3 invariant)', async () => {
    // INV-TRACKER-003: __fvid is only SET when consent_analytics='granted' (Fase 3).
    // In this implementation, the tracker never creates __fvid — only reads it.
    const cookiesModule = await import('../../../apps/tracker/src/cookies');
    // @ts-expect-error — intentionally checking that write APIs do not exist
    expect(
      (cookiesModule as Record<string, unknown>).setVisitorIdCookie,
    ).toBeUndefined();
    // @ts-expect-error — intentionally checking that write APIs do not exist
    expect(
      (cookiesModule as Record<string, unknown>).createVisitorIdCookie,
    ).toBeUndefined();
  });
});

describe('cookie constants', () => {
  it('FTK_COOKIE is __ftk', () => {
    expect(FTK_COOKIE).toBe('__ftk');
  });

  it('FVID_COOKIE is __fvid', () => {
    expect(FVID_COOKIE).toBe('__fvid');
  });

  it('PLATFORM_COOKIE_NAMES contains all required platform cookies', () => {
    expect(PLATFORM_COOKIE_NAMES).toContain('_gcl_au');
    expect(PLATFORM_COOKIE_NAMES).toContain('_ga');
    expect(PLATFORM_COOKIE_NAMES).toContain('fbc');
    expect(PLATFORM_COOKIE_NAMES).toContain('fbp');
  });
});
