/**
 * Event time clamp helper.
 *
 * BR-EVENT-003: event_time is clamped when abs(event_time - received_at) exceeds window.
 * INV-EVENT-002: Edge clamps event_time when offset > EVENT_TIME_CLAMP_WINDOW_SEC.
 *
 * Compatible with Cloudflare Workers runtime (pure computation, no I/O).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default maximum allowed clock drift in milliseconds (5 minutes).
 * BR-EVENT-003: default window = 300s.
 */
export const DEFAULT_MAX_DRIFT_MS = 300_000; // 5 * 60 * 1000

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClampResult {
  /** The effective event_time to use (either original or server time if clamped). */
  eventTime: number;
  /** Whether the original client timestamp was replaced. */
  wasClamped: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clamp an event timestamp to be within `maxDriftMs` of the server receive time.
 *
 * If the absolute difference between clientTs and serverTs exceeds maxDriftMs,
 * the server timestamp is used and wasClamped=true is signalled for metrics.
 *
 * BR-EVENT-003: clamp event_time when offset > EVENT_TIME_CLAMP_WINDOW_SEC.
 * INV-EVENT-002: deterministic — same inputs always produce same output.
 *
 * @param clientTs  - event_time provided by the client (Unix ms or epoch ms)
 * @param serverTs  - received_at server timestamp (Unix ms or epoch ms)
 * @param maxDriftMs - maximum allowed difference in ms (default 300 000 ms = 5 min)
 * @returns ClampResult with effective timestamp and clamped flag
 */
export function clampEventTime(
  clientTs: number,
  serverTs: number,
  maxDriftMs: number = DEFAULT_MAX_DRIFT_MS,
): ClampResult {
  // BR-EVENT-003: abs(event_time - received_at) > window → use received_at
  const drift = Math.abs(clientTs - serverTs);

  if (drift > maxDriftMs) {
    return { eventTime: serverTs, wasClamped: true };
  }

  return { eventTime: clientTs, wasClamped: false };
}
