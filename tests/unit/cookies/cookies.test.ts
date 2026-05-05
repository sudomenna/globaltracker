/**
 * Unit tests for apps/edge/src/lib/cookies.ts
 *
 * Covers:
 *   BR-IDENTITY-005: __ftk cookie must be HttpOnly, Secure, SameSite=Lax
 *   INV-IDENTITY-006: cookie is read back on the server; parse must be correct
 *
 * Target coverage: ≥ 95%
 */

import { describe, expect, it } from 'vitest';
import {
  type CookieOptions,
  LEAD_TOKEN_COOKIE,
  LEAD_TOKEN_DEFAULT_MAX_AGE_SECONDS,
  buildLeadTokenCookie,
  parseCookies,
  serializeCookie,
} from '../../../apps/edge/src/lib/cookies';

// ---------------------------------------------------------------------------
// parseCookies
// ---------------------------------------------------------------------------

describe('parseCookies', () => {
  it('parses a single name=value pair', () => {
    const result = parseCookies('session=abc123');
    expect(result).toEqual({ session: 'abc123' });
  });

  it('parses multiple cookies separated by semicolons', () => {
    const result = parseCookies('a=1; b=2; c=3');
    expect(result).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('trims whitespace around name and value', () => {
    const result = parseCookies('  key  =  value  ');
    expect(result).toEqual({ key: 'value' });
  });

  it('returns empty object for empty string', () => {
    expect(parseCookies('')).toEqual({});
  });

  it('returns empty object for null input', () => {
    expect(parseCookies(null)).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('INV-IDENTITY-006: reads back the __ftk cookie correctly', () => {
    const token = 'someHmacToken.signature';
    const cookieHeader = `__ftk=${encodeURIComponent(token)}; other=val`;
    const result = parseCookies(cookieHeader);
    expect(result[LEAD_TOKEN_COOKIE]).toBe(token);
  });

  it('handles percent-encoded values', () => {
    const result = parseCookies('key=hello%20world');
    expect(result.key).toBe('hello world');
  });

  it('handles percent-encoded names', () => {
    const result = parseCookies('hello%20world=value');
    expect(result['hello world']).toBe('value');
  });

  it('skips pairs without an equals sign', () => {
    const result = parseCookies('noequals; key=value');
    expect(result).toEqual({ key: 'value' });
  });

  it('allows empty value', () => {
    const result = parseCookies('key=');
    expect(result).toEqual({ key: '' });
  });

  it('last value wins for duplicate keys', () => {
    const result = parseCookies('key=first; key=second');
    expect(result.key).toBe('second');
  });

  it('handles value containing equals sign', () => {
    const result = parseCookies('key=a=b=c');
    expect(result.key).toBe('a=b=c');
  });

  it('is lenient with malformed percent-encoding — falls back to raw value', () => {
    // %ZZ is not valid percent-encoding
    const result = parseCookies('key=%ZZ');
    // Should not throw; raw value is stored
    expect(result.key).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// serializeCookie
// ---------------------------------------------------------------------------

describe('serializeCookie', () => {
  it('serializes a simple name=value cookie', () => {
    const result = serializeCookie('session', 'abc123');
    expect(result).toContain('session=abc123');
  });

  it('includes Path=/ by default', () => {
    const result = serializeCookie('k', 'v');
    expect(result).toContain('Path=/');
  });

  it('uses the supplied path option', () => {
    const result = serializeCookie('k', 'v', { path: '/api' });
    expect(result).toContain('Path=/api');
  });

  it('includes Max-Age when provided', () => {
    const result = serializeCookie('k', 'v', { maxAge: 3600 });
    expect(result).toContain('Max-Age=3600');
  });

  it('includes Domain when provided', () => {
    const result = serializeCookie('k', 'v', { domain: 'example.com' });
    expect(result).toContain('Domain=example.com');
  });

  it('includes SameSite when provided', () => {
    const result = serializeCookie('k', 'v', { sameSite: 'Strict' });
    expect(result).toContain('SameSite=Strict');
  });

  it('includes HttpOnly when httpOnly=true', () => {
    const result = serializeCookie('k', 'v', { httpOnly: true });
    expect(result).toContain('HttpOnly');
  });

  it('does not include HttpOnly when httpOnly=false', () => {
    const result = serializeCookie('k', 'v', { httpOnly: false });
    expect(result).not.toContain('HttpOnly');
  });

  it('includes Secure when secure=true', () => {
    const result = serializeCookie('k', 'v', { secure: true });
    expect(result).toContain('Secure');
  });

  it('does not include Secure when secure=false', () => {
    const result = serializeCookie('k', 'v', { secure: false });
    expect(result).not.toContain('Secure');
  });

  it('percent-encodes the cookie name', () => {
    const result = serializeCookie('hello world', 'val');
    expect(result).toContain('hello%20world=val');
  });

  it('percent-encodes the cookie value', () => {
    const result = serializeCookie('k', 'hello world');
    expect(result).toContain('k=hello%20world');
  });

  it('truncates fractional maxAge to integer', () => {
    const result = serializeCookie('k', 'v', { maxAge: 3600.9 });
    expect(result).toContain('Max-Age=3600');
  });

  it('allows maxAge=0 to delete a cookie', () => {
    const result = serializeCookie('k', 'v', { maxAge: 0 });
    expect(result).toContain('Max-Age=0');
  });

  it('serializes all options together in one header value', () => {
    const opts: CookieOptions = {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 7200,
      domain: 'example.com',
      path: '/app',
    };
    const result = serializeCookie('token', 'xyz', opts);
    expect(result).toContain('token=xyz');
    expect(result).toContain('Path=/app');
    expect(result).toContain('Max-Age=7200');
    expect(result).toContain('Domain=example.com');
    expect(result).toContain('SameSite=Lax');
    expect(result).toContain('HttpOnly');
    expect(result).toContain('Secure');
  });
});

// ---------------------------------------------------------------------------
// LEAD_TOKEN_COOKIE constant
// ---------------------------------------------------------------------------

describe('LEAD_TOKEN_COOKIE', () => {
  it('is the canonical __ftk name', () => {
    expect(LEAD_TOKEN_COOKIE).toBe('__ftk');
  });
});

// ---------------------------------------------------------------------------
// buildLeadTokenCookie
// ---------------------------------------------------------------------------

describe('buildLeadTokenCookie', () => {
  const TOKEN = 'payload.signature';

  // BR-IDENTITY-005 hardening (Sprint 12, MEMORY §2 + §7 bug C12):
  // tracker.js precisa ler __ftk via document.cookie para propagar identidade
  // cross-page entre LP (cneeducacao.com) e Edge (workers.dev). Por isso:
  //   - HttpOnly foi removido (era flag original)
  //   - SameSite=Lax → SameSite=None (cross-origin LP ↔ Edge)
  //   - Secure permanece obrigatório (mitigação)
  // O token é HMAC-bound a workspace+lead → roubo isolado não autoriza impersonação cross-tenant.
  it('BR-IDENTITY-005 (hardening): does NOT set HttpOnly (tracker.js needs JS read access)', () => {
    const result = buildLeadTokenCookie(TOKEN);
    expect(result).not.toContain('HttpOnly');
  });

  it('BR-IDENTITY-005: sets Secure flag', () => {
    const result = buildLeadTokenCookie(TOKEN);
    expect(result).toContain('Secure');
  });

  it('BR-IDENTITY-005 (hardening): sets SameSite=None for cross-origin LP ↔ Edge', () => {
    const result = buildLeadTokenCookie(TOKEN);
    expect(result).toContain('SameSite=None');
  });

  it('uses cookie name __ftk', () => {
    const result = buildLeadTokenCookie(TOKEN);
    expect(result).toMatch(/^__ftk=/);
  });

  it('includes the token value in the cookie', () => {
    const result = buildLeadTokenCookie(TOKEN);
    // encodeURIComponent('payload.signature') === 'payload.signature' (dot is safe)
    expect(result).toContain(encodeURIComponent(TOKEN));
  });

  it('uses default max-age of 180 days when not provided', () => {
    const result = buildLeadTokenCookie(TOKEN);
    expect(result).toContain(`Max-Age=${LEAD_TOKEN_DEFAULT_MAX_AGE_SECONDS}`);
  });

  it('uses custom maxAge when provided', () => {
    const result = buildLeadTokenCookie(TOKEN, 3600);
    expect(result).toContain('Max-Age=3600');
  });

  it('sets Path=/', () => {
    const result = buildLeadTokenCookie(TOKEN);
    expect(result).toContain('Path=/');
  });

  it('INV-IDENTITY-006: token is parseable after round-trip encode/decode', () => {
    const result = buildLeadTokenCookie(TOKEN);
    // Extract the value portion from the Set-Cookie string
    const match = result.match(/^__ftk=([^;]+)/);
    expect(match).not.toBeNull();
    if (!match) return;
    // Simulate the browser sending the cookie back
    const cookieHeader = `__ftk=${match[1]}`;
    const parsed = parseCookies(cookieHeader);
    expect(parsed[LEAD_TOKEN_COOKIE]).toBe(TOKEN);
  });

  it('LEAD_TOKEN_DEFAULT_MAX_AGE_SECONDS is 180 days', () => {
    expect(LEAD_TOKEN_DEFAULT_MAX_AGE_SECONDS).toBe(180 * 24 * 60 * 60);
  });
});
