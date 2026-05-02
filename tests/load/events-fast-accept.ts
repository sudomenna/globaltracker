/**
 * events-fast-accept.ts — Load test for POST /v1/events
 *
 * T-ID: T-1-022
 * CONTRACT-id: CONTRACT-api-events-v1
 *
 * Validates RNF-001:
 *   - 1000 req/s sustained for 1 minute
 *   - p95 < 50ms
 *   - zero 5xx errors (< 0.1% failure rate)
 *
 * Run with wrangler dev and required env vars (see README.md).
 *
 * k6 TypeScript runtime — NOT Node.js.
 * Import only from 'k6', 'k6/http', 'k6/metrics', 'k6/execution'.
 */

import { check } from 'k6';
import http from 'k6/http';
import { Rate } from 'k6/metrics';
import type { Options } from 'k6/options';

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

/**
 * Tracks the rate of duplicate_accepted responses.
 * In fast-accept mode with unique event_ids per iteration this should be near 0,
 * but the endpoint spec allows duplicate_accepted as a valid 202 response.
 * BR-EVENT-003: replay protection returns duplicate_accepted idempotently.
 */
const duplicateRate = new Rate('duplicate_events');

/**
 * Tracks response body parse success — catches cases where 202 is returned
 * but the body is malformed (e.g., wrong Content-Type, truncated body).
 */
const bodyParseErrors = new Rate('body_parse_errors');

// ---------------------------------------------------------------------------
// Test options — RNF-001
// ---------------------------------------------------------------------------

export const options: Options = {
  scenarios: {
    events_load: {
      executor: 'constant-arrival-rate',
      /**
       * RNF-001: 1000 req/s sustained for 1 minute.
       * constant-arrival-rate attempts to hit exactly `rate` iterations per
       * `timeUnit` regardless of VU response times.
       */
      rate: 1000,
      timeUnit: '1s',
      duration: '1m',
      /**
       * preAllocatedVUs: initial pool. k6 will reuse VUs across iterations.
       * With p95 < 50ms and 1000 req/s, ~50 concurrent VUs theoretically
       * sufficient. Pre-allocate 100 for headroom.
       */
      preAllocatedVUs: 100,
      maxVUs: 200,
    },
  },
  thresholds: {
    /**
     * RNF-001: p95 latency < 50ms.
     * Measured against wrangler dev (local); in production (CF edge +
     * Hyperdrive) latency will be lower.
     */
    http_req_duration: ['p(95)<50'],
    /**
     * Zero 5xx: threshold allows < 0.1% to accommodate transient wrangler dev
     * startup noise. In practice this should be 0.
     */
    http_req_failed: ['rate<0.001'],
    /**
     * > 99% of checks must pass.
     */
    checks: ['rate>0.99'],
    /**
     * Body parse errors must be essentially zero.
     */
    body_parse_errors: ['rate<0.001'],
  },
};

// ---------------------------------------------------------------------------
// UUID utility
// ---------------------------------------------------------------------------

/**
 * Generates a UUID v4-like string.
 *
 * k6 does not expose crypto.randomUUID(). This implementation uses
 * Math.random() which is acceptable in load tests where uniqueness is
 * statistical (collision probability negligible at 1000 req/s for 60s = 60k
 * events).
 *
 * NOTE: do NOT use Math.random() without justification in unit tests —
 * this is load-test specific (non-determinism is intentional here).
 */
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

/**
 * Required env vars (passed via k6 -e flag):
 *   BASE_URL          — e.g. http://localhost:8787
 *   LAUNCH_PUBLIC_ID  — public ID of the launch under test
 *   PAGE_PUBLIC_ID    — public ID of the page under test
 *   PAGE_TOKEN        — X-Funil-Site header value (pk_live_... or pk_test_...)
 *
 * Fail fast if vars are missing so the operator knows before the test ramps.
 */
const BASE_URL: string = __ENV.BASE_URL ?? 'http://localhost:8787';
const LAUNCH_PUBLIC_ID: string = __ENV.LAUNCH_PUBLIC_ID ?? '';
const PAGE_PUBLIC_ID: string = __ENV.PAGE_PUBLIC_ID ?? '';
const PAGE_TOKEN: string = __ENV.PAGE_TOKEN ?? '';

// ---------------------------------------------------------------------------
// Setup: validate env vars before load starts
// ---------------------------------------------------------------------------

export function setup(): void {
  if (!LAUNCH_PUBLIC_ID) {
    throw new Error(
      'Missing required env var: LAUNCH_PUBLIC_ID. Pass via: k6 run -e LAUNCH_PUBLIC_ID=<id>',
    );
  }
  if (!PAGE_PUBLIC_ID) {
    throw new Error(
      'Missing required env var: PAGE_PUBLIC_ID. Pass via: k6 run -e PAGE_PUBLIC_ID=<id>',
    );
  }
  if (!PAGE_TOKEN) {
    throw new Error(
      'Missing required env var: PAGE_TOKEN. Pass via: k6 run -e PAGE_TOKEN=<token>',
    );
  }
}

// ---------------------------------------------------------------------------
// Default function — executed once per VU per iteration
// ---------------------------------------------------------------------------

/**
 * Sends a single POST /v1/events request with a unique event_id.
 *
 * Checks applied per iteration:
 *   1. HTTP 202 — fast-accept response (RNF-001 / CONTRACT-api-events-v1)
 *   2. Response body contains event_id — CONTRACT-api-events-v1
 *   3. Status is 'accepted' or 'duplicate_accepted' — CONTRACT-api-events-v1
 *
 * BR-EVENT-002: event_time is set to current ISO timestamp (within clamp window).
 * BR-EVENT-003: unique event_id per iteration minimises duplicate_accepted;
 *               the check allows it as a valid idempotent response.
 */
export default function (): void {
  const eventId = uuid();
  const requestId = uuid();
  const eventTime = new Date().toISOString();

  const payload = JSON.stringify({
    event_id: eventId,
    schema_version: 1,
    launch_public_id: LAUNCH_PUBLIC_ID,
    page_public_id: PAGE_PUBLIC_ID,
    event_name: 'LoadTest',
    event_time: eventTime,
    attribution: {},
    custom_data: {},
    consent: {
      analytics: true,
      marketing: true,
      functional: true,
    },
  });

  const headers = {
    'Content-Type': 'application/json',
    /**
     * X-Funil-Site: page_token authenticating the request.
     * CONTRACT-api-events-v1: required header.
     */
    'X-Funil-Site': PAGE_TOKEN,
    /**
     * X-Request-Id: unique per request for tracing.
     * Middleware echoes this in response headers.
     */
    'X-Request-Id': requestId,
  };

  const res = http.post(`${BASE_URL}/v1/events`, payload, { headers });

  // -------------------------------------------------------------------------
  // Parse response body
  // -------------------------------------------------------------------------
  let body: { event_id?: string; status?: string } | null = null;
  let parseOk = true;

  try {
    body = JSON.parse(res.body as string) as {
      event_id?: string;
      status?: string;
    };
  } catch {
    parseOk = false;
  }

  bodyParseErrors.add(!parseOk);

  // -------------------------------------------------------------------------
  // Checks — CONTRACT-api-events-v1
  // -------------------------------------------------------------------------
  const passed = check(res, {
    /**
     * RNF-001 + CONTRACT-api-events-v1: fast accept returns 202.
     */
    'status is 202': (r) => r.status === 202,

    /**
     * CONTRACT-api-events-v1: response body includes echo of event_id.
     */
    'body has event_id': (_r) => body?.event_id !== undefined,

    /**
     * CONTRACT-api-events-v1: status field is 'accepted' or 'duplicate_accepted'.
     * BR-EVENT-003: duplicate_accepted is valid idempotent response.
     */
    'status is accepted or duplicate_accepted': (_r) =>
      body?.status === 'accepted' || body?.status === 'duplicate_accepted',
  });

  // -------------------------------------------------------------------------
  // Record duplicate rate
  // BR-EVENT-003: duplicate_accepted means replay protection fired.
  // In load tests with unique UUIDs this should be near zero.
  // -------------------------------------------------------------------------
  if (body?.status === 'duplicate_accepted') {
    duplicateRate.add(1);
  } else {
    duplicateRate.add(0);
  }

  // No sleep: constant-arrival-rate executor manages request pacing.
  // Adding sleep here would reduce effective throughput.
  void passed;
}
