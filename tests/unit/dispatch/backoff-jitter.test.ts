/**
 * Unit tests — dispatch backoff with jitter
 *
 * INV-DISPATCH-007: delay = 2^attempt × (1 ± 0.2 random jitter) seconds.
 * BR-DISPATCH-003: backoff formula used on rate_limit and server_error.
 *
 * Math.random is injectable for deterministic assertions.
 */

import { describe, expect, it } from 'vitest';
import { computeBackoff } from '../../../apps/edge/src/lib/dispatch';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a function that always yields the given value — simulates Math.random. */
function constantRandom(value: number) {
  return () => value;
}

/**
 * Expected range for a given attempt when jitter is ±20%.
 * base = 2^attempt seconds; min = base * 0.8; max = base * 1.2 (before rounding).
 */
function expectedRangeMs(attempt: number) {
  const base = 2 ** attempt;
  return {
    minMs: Math.round(base * 0.8 * 1000),
    maxMs: Math.round(base * 1.2 * 1000),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeBackoff', () => {
  describe('attempt=0 — base 1 second', () => {
    it('returns a value within [800ms, 1200ms] for attempt=0', () => {
      // INV-DISPATCH-007: 2^0 = 1s ±20%
      const { minMs, maxMs } = expectedRangeMs(0);
      // Run 20 times with real random — all results must be in range
      for (let i = 0; i < 20; i++) {
        const ms = computeBackoff(0);
        expect(ms).toBeGreaterThanOrEqual(minMs);
        expect(ms).toBeLessThanOrEqual(maxMs);
      }
    });

    it('returns minimum (~800ms) when random=0', () => {
      // random()=0 → jitter = 0*0.4-0.2 = -0.2 → delay = 1*(1-0.2) = 0.8s
      const ms = computeBackoff(0, constantRandom(0));
      expect(ms).toBe(Math.round(0.8 * 1000)); // 800ms
    });

    it('returns maximum (~1200ms) when random=1', () => {
      // random()=1 → jitter = 1*0.4-0.2 = 0.2 → delay = 1*(1+0.2) = 1.2s
      const ms = computeBackoff(0, constantRandom(1));
      expect(ms).toBe(Math.round(1.2 * 1000)); // 1200ms
    });

    it('returns base (~1000ms) when random=0.5 (zero jitter)', () => {
      // random()=0.5 → jitter = 0.5*0.4-0.2 = 0 → delay = 1s
      const ms = computeBackoff(0, constantRandom(0.5));
      expect(ms).toBe(Math.round(1.0 * 1000)); // 1000ms
    });
  });

  describe('attempt=1 — base 2 seconds', () => {
    it('returns a value within [1600ms, 2400ms] for attempt=1', () => {
      // INV-DISPATCH-007: 2^1 = 2s ±20%
      const { minMs, maxMs } = expectedRangeMs(1);
      for (let i = 0; i < 20; i++) {
        const ms = computeBackoff(1);
        expect(ms).toBeGreaterThanOrEqual(minMs);
        expect(ms).toBeLessThanOrEqual(maxMs);
      }
    });

    it('returns minimum (~1600ms) when random=0', () => {
      const ms = computeBackoff(1, constantRandom(0));
      expect(ms).toBe(Math.round(1.6 * 1000)); // 1600ms
    });

    it('returns maximum (~2400ms) when random=1', () => {
      const ms = computeBackoff(1, constantRandom(1));
      expect(ms).toBe(Math.round(2.4 * 1000)); // 2400ms
    });
  });

  describe('attempt=4 — base 16 seconds', () => {
    it('returns a value within [12800ms, 19200ms] for attempt=4', () => {
      // INV-DISPATCH-007: 2^4 = 16s ±20%
      const { minMs, maxMs } = expectedRangeMs(4);
      for (let i = 0; i < 20; i++) {
        const ms = computeBackoff(4);
        expect(ms).toBeGreaterThanOrEqual(minMs);
        expect(ms).toBeLessThanOrEqual(maxMs);
      }
    });

    it('returns minimum (~12800ms) when random=0', () => {
      const ms = computeBackoff(4, constantRandom(0));
      expect(ms).toBe(Math.round(16 * 0.8 * 1000)); // 12800ms
    });

    it('returns maximum (~19200ms) when random=1', () => {
      const ms = computeBackoff(4, constantRandom(1));
      expect(ms).toBe(Math.round(16 * 1.2 * 1000)); // 19200ms
    });
  });

  describe('jitter randomness', () => {
    it('returns different values across calls (actual random source)', () => {
      // With real Math.random, two calls are very unlikely to be identical
      // Run 10 pairs — at least one pair should differ (probabilistic but safe)
      const results = Array.from({ length: 10 }, () => computeBackoff(3));
      const unique = new Set(results);
      expect(unique.size).toBeGreaterThan(1);
    });

    it('INV-DISPATCH-007: jitter is bounded to ±20% of base (no outliers)', () => {
      // Exhaustively test boundary with extreme random values
      const base = 2 ** 2; // 4s for attempt=2
      const minExpected = Math.round(base * 0.8 * 1000);
      const maxExpected = Math.round(base * 1.2 * 1000);

      // Check values just inside the boundary
      expect(computeBackoff(2, constantRandom(0.001))).toBeGreaterThanOrEqual(
        minExpected,
      );
      expect(computeBackoff(2, constantRandom(0.999))).toBeLessThanOrEqual(
        maxExpected,
      );
    });

    it('returns milliseconds (not seconds)', () => {
      // Even attempt=0 base=1s should return ~1000, not ~1
      const ms = computeBackoff(0, constantRandom(0.5));
      expect(ms).toBeGreaterThan(100); // sanity: definitely milliseconds
    });
  });
});
