/**
 * Unit tests — health-cp.ts aggregation helpers
 *
 * Tests the pure functions computeProviderState and aggregateState exported
 * from the health-cp route module.
 *
 * docs/70-ux/07-component-health-badges.md §3
 */

import { describe, expect, it } from 'vitest';
import {
  type DispatchHealthRow,
  aggregateState,
  computeProviderState,
} from '../../../apps/edge/src/routes/health-cp.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(
  overrides: Partial<DispatchHealthRow> = {},
): DispatchHealthRow {
  return {
    destination: 'meta_capi',
    succeeded: 100,
    failed: 0,
    skipped: 0,
    dlq_count: 0,
    total: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeProviderState
// ---------------------------------------------------------------------------

describe('computeProviderState', () => {
  it('returns healthy when no failures and no DLQ', () => {
    const row = makeRow({ succeeded: 100, failed: 0, dlq_count: 0 });
    expect(computeProviderState(row)).toBe('healthy');
  });

  it('returns healthy when failure_rate below 0.01 threshold', () => {
    // 0 failures out of 100 = 0% rate
    const row = makeRow({ succeeded: 100, failed: 0, dlq_count: 0 });
    expect(computeProviderState(row)).toBe('healthy');
  });

  it('returns degraded when failure_rate is in [0.01, 0.05)', () => {
    // 2 failures out of 100 = 2% rate
    const row = makeRow({ succeeded: 98, failed: 2, dlq_count: 0 });
    expect(computeProviderState(row)).toBe('degraded');
  });

  it('returns degraded at exactly 1% failure rate (lower boundary)', () => {
    // 1 failure out of 100 = 1% rate
    const row = makeRow({ succeeded: 99, failed: 1, dlq_count: 0 });
    expect(computeProviderState(row)).toBe('degraded');
  });

  it('returns unhealthy when failure_rate >= 0.05', () => {
    // BR-DISPATCH-005: high failure rate → unhealthy
    // 5 failures out of 100 = 5% rate
    const row = makeRow({ succeeded: 95, failed: 5, dlq_count: 0 });
    expect(computeProviderState(row)).toBe('unhealthy');
  });

  it('returns unhealthy when failure_rate > 0.05', () => {
    // 10 failures out of 100 = 10% rate
    const row = makeRow({ succeeded: 90, failed: 10, dlq_count: 0 });
    expect(computeProviderState(row)).toBe('unhealthy');
  });

  it('BR-DISPATCH-005: returns unhealthy when dlq_count > 0 even with zero failures', () => {
    // dead_letter is terminal failure state
    const row = makeRow({ succeeded: 100, failed: 0, dlq_count: 1 });
    expect(computeProviderState(row)).toBe('unhealthy');
  });

  it('BR-DISPATCH-005: dlq_count takes priority over degraded failure_rate', () => {
    // 2% failure rate (normally degraded) but DLQ items present → unhealthy
    const row = makeRow({ succeeded: 98, failed: 2, dlq_count: 3 });
    expect(computeProviderState(row)).toBe('unhealthy');
  });

  it('returns healthy when zero total events (zero denominator fallback)', () => {
    // No events dispatched — failure rate defaults to 0
    const row = makeRow({ succeeded: 0, failed: 0, dlq_count: 0 });
    expect(computeProviderState(row)).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// aggregateState
// ---------------------------------------------------------------------------

describe('aggregateState', () => {
  it('returns unknown when states array is empty', () => {
    expect(aggregateState([])).toBe('unknown');
  });

  it('returns healthy when all providers are healthy', () => {
    expect(aggregateState(['healthy', 'healthy', 'healthy'])).toBe('healthy');
  });

  it('returns unhealthy when at least one provider is unhealthy', () => {
    expect(aggregateState(['healthy', 'unhealthy', 'healthy'])).toBe(
      'unhealthy',
    );
  });

  it('returns unhealthy when unhealthy and degraded mixed', () => {
    expect(aggregateState(['degraded', 'unhealthy'])).toBe('unhealthy');
  });

  it('returns degraded when at least one degraded and none unhealthy', () => {
    expect(aggregateState(['healthy', 'degraded', 'healthy'])).toBe('degraded');
  });

  it('returns degraded when all providers are degraded', () => {
    expect(aggregateState(['degraded', 'degraded'])).toBe('degraded');
  });

  it('returns healthy for single healthy state', () => {
    expect(aggregateState(['healthy'])).toBe('healthy');
  });

  it('returns unhealthy for single unhealthy state', () => {
    expect(aggregateState(['unhealthy'])).toBe('unhealthy');
  });

  it('returns degraded for single degraded state', () => {
    expect(aggregateState(['degraded'])).toBe('degraded');
  });
});
