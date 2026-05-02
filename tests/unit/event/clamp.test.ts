/**
 * Unit tests for apps/edge/src/lib/event-time-clamp.ts
 *
 * Covers:
 *   BR-EVENT-003: event_time clamped when abs(event_time - received_at) > window
 *   INV-EVENT-002: deterministic clamp with matrix of offsets
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_DRIFT_MS,
  clampEventTime,
} from '../../../apps/edge/src/lib/event-time-clamp';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// received_at = 2026-05-01T20:00:00Z in Unix ms
const SERVER_TS = new Date('2026-05-01T20:00:00Z').getTime();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('clampEventTime', () => {
  it('DEFAULT_MAX_DRIFT_MS is 300 000 ms (5 minutes)', () => {
    expect(DEFAULT_MAX_DRIFT_MS).toBe(300_000);
  });

  // --- Clamped cases ---

  it('BR-EVENT-003: client clock 1 hour behind → clamped to serverTs', () => {
    // offset = 3600s >> 300s
    const clientTs = SERVER_TS - 60 * 60 * 1000; // 1 hour behind
    const result = clampEventTime(clientTs, SERVER_TS);
    expect(result.eventTime).toBe(SERVER_TS);
    expect(result.wasClamped).toBe(true);
  });

  it('BR-EVENT-003: client clock 1 hour ahead → clamped to serverTs', () => {
    const clientTs = SERVER_TS + 60 * 60 * 1000; // 1 hour ahead
    const result = clampEventTime(clientTs, SERVER_TS);
    expect(result.eventTime).toBe(SERVER_TS);
    expect(result.wasClamped).toBe(true);
  });

  it('INV-EVENT-002: very old event_time (2020-01-01) is clamped to received_at (2026-05-01)', () => {
    const oldTs = new Date('2020-01-01T00:00:00Z').getTime();
    const result = clampEventTime(oldTs, SERVER_TS);
    expect(result.eventTime).toBe(SERVER_TS);
    expect(result.wasClamped).toBe(true);
  });

  it('BR-EVENT-003: offset exactly exceeding window (300 001 ms) → clamped', () => {
    const clientTs = SERVER_TS - 300_001;
    const result = clampEventTime(clientTs, SERVER_TS);
    expect(result.eventTime).toBe(SERVER_TS);
    expect(result.wasClamped).toBe(true);
  });

  // --- Preserved cases ---

  it('BR-EVENT-003: offset within window (30s) → preserved', () => {
    const clientTs = SERVER_TS - 30_000; // 30 seconds behind
    const result = clampEventTime(clientTs, SERVER_TS);
    expect(result.eventTime).toBe(clientTs);
    expect(result.wasClamped).toBe(false);
  });

  it('BR-EVENT-003: offset of exactly 300 000 ms (boundary) → preserved', () => {
    // Boundary: abs == maxDriftMs is NOT > maxDriftMs, so no clamp
    const clientTs = SERVER_TS - 300_000;
    const result = clampEventTime(clientTs, SERVER_TS);
    expect(result.eventTime).toBe(clientTs);
    expect(result.wasClamped).toBe(false);
  });

  it('client timestamp equal to server timestamp → preserved', () => {
    const result = clampEventTime(SERVER_TS, SERVER_TS);
    expect(result.eventTime).toBe(SERVER_TS);
    expect(result.wasClamped).toBe(false);
  });

  it('small positive offset (network/clock natural) → preserved', () => {
    const clientTs = SERVER_TS + 150; // 150ms ahead — normal network jitter
    const result = clampEventTime(clientTs, SERVER_TS);
    expect(result.eventTime).toBe(clientTs);
    expect(result.wasClamped).toBe(false);
  });

  // --- Custom window ---

  it('respects custom maxDriftMs when provided', () => {
    const customWindow = 60_000; // 1 minute
    const clientTs = SERVER_TS - 90_000; // 90s behind → exceeds 60s custom window
    const result = clampEventTime(clientTs, SERVER_TS, customWindow);
    expect(result.eventTime).toBe(SERVER_TS);
    expect(result.wasClamped).toBe(true);
  });

  it('custom window: offset within custom window → preserved', () => {
    const customWindow = 60_000; // 1 minute
    const clientTs = SERVER_TS - 30_000; // 30s behind — within 60s window
    const result = clampEventTime(clientTs, SERVER_TS, customWindow);
    expect(result.eventTime).toBe(clientTs);
    expect(result.wasClamped).toBe(false);
  });

  // --- Determinism ---

  it('INV-EVENT-002: same inputs always produce same output (deterministic)', () => {
    const clientTs = SERVER_TS - 999_999;
    const r1 = clampEventTime(clientTs, SERVER_TS);
    const r2 = clampEventTime(clientTs, SERVER_TS);
    expect(r1).toEqual(r2);
  });

  // --- Offset matrix ---

  const offsetMatrix: Array<{ offsetMs: number; shouldClamp: boolean }> = [
    { offsetMs: 0, shouldClamp: false },
    { offsetMs: 1_000, shouldClamp: false },
    { offsetMs: 60_000, shouldClamp: false },
    { offsetMs: 299_999, shouldClamp: false },
    { offsetMs: 300_000, shouldClamp: false }, // boundary — equal, not exceeding
    { offsetMs: 300_001, shouldClamp: true },
    { offsetMs: 600_000, shouldClamp: true },
    { offsetMs: 3_600_000, shouldClamp: true },
    { offsetMs: 86_400_000, shouldClamp: true }, // 1 day
  ];

  it.each(offsetMatrix)(
    'INV-EVENT-002: offset $offsetMs ms → wasClamped=$shouldClamp',
    ({ offsetMs, shouldClamp }) => {
      const clientTs = SERVER_TS - offsetMs;
      const result = clampEventTime(clientTs, SERVER_TS);
      expect(result.wasClamped).toBe(shouldClamp);
    },
  );
});
