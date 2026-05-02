/**
 * Integration tests — INV-TRACKER-007: ensureVisitorId handles document.cookie failures
 *
 * Simulates scenarios where document.cookie access fails:
 *   - Getter throws
 *   - Setter is blocked by browser policy
 *   - document is unavailable
 *
 * INV-TRACKER-007: any failure returns null silently — the host page must never break.
 *
 * Uses vi.stubGlobal following the pattern of tests/unit/tracker/cookies.test.ts.
 * The vitest environment is 'node'; document is simulated via stubs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FVID_COOKIE,
  ensureVisitorId,
} from '../../../apps/tracker/src/cookies';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('INV-TRACKER-007: ensureVisitorId does not throw when document.cookie fails', () => {
  it('returns null when document.cookie read throws — page must not break', () => {
    vi.stubGlobal('document', {
      get cookie(): string {
        throw new Error(
          'SecurityError: cookie access blocked by browser policy',
        );
      },
      set cookie(_value: string) {
        throw new Error('SecurityError: cookie set blocked by browser policy');
      },
    });

    // INV-TRACKER-007: must not throw
    let result: string | null | undefined;
    expect(() => {
      result = ensureVisitorId(true);
    }).not.toThrow();

    // Must return null silently
    expect(result).toBeNull();
  });

  it('returns null without throwing when document is unavailable', () => {
    vi.stubGlobal('document', undefined);

    // INV-TRACKER-007: fail silently
    let result: string | null | undefined;
    expect(() => {
      result = ensureVisitorId(true);
    }).not.toThrow();

    expect(result).toBeNull();
  });

  it('returns null for consentAnalytics=false regardless of document state — no cookie access attempted', () => {
    // When consent is denied, the function returns null immediately
    // without touching document.cookie at all — early return before any try/catch
    const cookieGetCalls: number[] = [];
    vi.stubGlobal('document', {
      get cookie(): string {
        cookieGetCalls.push(1);
        return '';
      },
      set cookie(_value: string) {},
    });

    const result = ensureVisitorId(false);
    expect(result).toBeNull();

    // Verify early return — no cookie read attempted
    expect(cookieGetCalls).toHaveLength(0);
  });

  it('subsequent calls after cookie failure also return null silently', () => {
    // Both getter AND setter throw — simulates a fully blocked cookie API
    vi.stubGlobal('document', {
      get cookie(): string {
        throw new Error('blocked');
      },
      set cookie(_value: string) {
        throw new Error('blocked');
      },
    });

    // Multiple calls must not throw
    for (let i = 0; i < 3; i++) {
      expect(() => ensureVisitorId(true)).not.toThrow();
      expect(ensureVisitorId(true)).toBeNull();
    }
  });

  it('recovers and returns a UUID after document is restored', () => {
    // First: no document
    vi.stubGlobal('document', undefined);
    expect(ensureVisitorId(true)).toBeNull();

    // Then: document available
    const writtenCookies: string[] = [];
    vi.stubGlobal('document', {
      get cookie(): string {
        return '';
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
