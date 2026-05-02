/**
 * Unit tests — apps/edge/src/lib/test-mode.ts (pure request-inspection helpers)
 *
 * T-ID: T-8-006
 *
 * Covers:
 *   isTestModeHeader — detects X-GT-Test-Mode: 1 header
 *   isTestModeCookie — detects __gt_test=1 cookie
 *   isTestModeRequest — detects either signal (header OR cookie)
 *
 * BR-RBAC-002: header/cookie inspection is workspace-agnostic (no side effects, no I/O)
 * BR-PRIVACY-001: no PII involved in detection helpers
 */

import { describe, expect, it } from 'vitest';
import {
  isTestModeCookie,
  isTestModeHeader,
  isTestModeRequest,
} from '../../../apps/edge/src/lib/test-mode.js';

// ---------------------------------------------------------------------------
// isTestModeHeader
// ---------------------------------------------------------------------------

describe('isTestModeHeader', () => {
  it('returns true when X-GT-Test-Mode header equals "1"', () => {
    const headers = new Headers({ 'X-GT-Test-Mode': '1' });
    expect(isTestModeHeader(headers)).toBe(true);
  });

  it('returns false when X-GT-Test-Mode header is absent', () => {
    const headers = new Headers();
    expect(isTestModeHeader(headers)).toBe(false);
  });

  it('returns false when X-GT-Test-Mode header equals "0"', () => {
    const headers = new Headers({ 'X-GT-Test-Mode': '0' });
    expect(isTestModeHeader(headers)).toBe(false);
  });

  it('returns false when X-GT-Test-Mode header equals empty string', () => {
    const headers = new Headers({ 'X-GT-Test-Mode': '' });
    expect(isTestModeHeader(headers)).toBe(false);
  });

  it('returns false when X-GT-Test-Mode header equals "true" (not "1")', () => {
    const headers = new Headers({ 'X-GT-Test-Mode': 'true' });
    expect(isTestModeHeader(headers)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isTestModeCookie
// ---------------------------------------------------------------------------

describe('isTestModeCookie', () => {
  it('returns true when cookie header contains __gt_test=1', () => {
    expect(isTestModeCookie('__gt_test=1')).toBe(true);
  });

  it('returns false when cookie header is null', () => {
    expect(isTestModeCookie(null)).toBe(false);
  });

  it('returns false when cookie header is empty string', () => {
    expect(isTestModeCookie('')).toBe(false);
  });

  it('returns false when __gt_test cookie is absent from other cookies', () => {
    expect(isTestModeCookie('other_cookie=value; another=123')).toBe(false);
  });

  it('returns false when __gt_test=0 (not "1")', () => {
    expect(isTestModeCookie('__gt_test=0')).toBe(false);
  });

  it('returns true when __gt_test=1 is among multiple cookies', () => {
    expect(isTestModeCookie('session=abc; __gt_test=1; other=xyz')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isTestModeRequest
// ---------------------------------------------------------------------------

describe('isTestModeRequest', () => {
  it('returns true when X-GT-Test-Mode: 1 header is present', () => {
    const headers = new Headers({ 'X-GT-Test-Mode': '1' });
    expect(isTestModeRequest(headers)).toBe(true);
  });

  it('returns true when __gt_test=1 cookie is present (no header)', () => {
    const headers = new Headers({ cookie: '__gt_test=1' });
    expect(isTestModeRequest(headers)).toBe(true);
  });

  it('returns true when both header and cookie are present', () => {
    const headers = new Headers({
      'X-GT-Test-Mode': '1',
      cookie: '__gt_test=1',
    });
    expect(isTestModeRequest(headers)).toBe(true);
  });

  it('returns false when neither header nor cookie is present', () => {
    const headers = new Headers();
    expect(isTestModeRequest(headers)).toBe(false);
  });

  it('returns false when header is "0" and cookie is absent', () => {
    const headers = new Headers({ 'X-GT-Test-Mode': '0' });
    expect(isTestModeRequest(headers)).toBe(false);
  });

  it('returns false when cookie is __gt_test=0 and header is absent', () => {
    const headers = new Headers({ cookie: '__gt_test=0' });
    expect(isTestModeRequest(headers)).toBe(false);
  });
});
