/**
 * events.ts — Sub-router for POST /v1/events.
 *
 * CONTRACT-id: CONTRACT-api-events-v1
 * T-ID: T-1-017, T-2-010
 *
 * Model: "fast accept" (ADR-004).
 * Validates → replay protection → lead_token HMAC → insert raw_events → enqueue → 202.
 * No synchronous normalisation; ingestion processor handles raw_events async.
 *
 * Middleware applied before this handler (from index.ts):
 *   auth-public-token          → sets workspace_id, page_id, request_id
 *   cors                       → validates Origin against allowed_domains
 *   rate-limit                 → sliding window via KV (100 req/min/workspace)
 *   sanitize-logs              → global; sets X-Request-Id
 *   lead-token-validate (T-2-010) → injects lead_id from __ftk cookie when valid
 *
 * BRs applied:
 *   BR-EVENT-002: event_time clamped (not future, not past > window)
 *   BR-EVENT-003: (event_id, workspace_id) unique — replay protection via KV
 *   BR-EVENT-004: lead_token HMAC validated when present
 *   BR-PRIVACY-001: zero PII in logs and error responses
 *   INV-EVENT-002: clampEventTime applied before raw_events insert
 *   INV-EVENT-003: KV replay check before insert; duplicate_accepted returned
 *   INV-EVENT-005: raw_events insert awaited before 202 (when DB available)
 *
 * Architecture note (AGENTS.md §2): routes/ do not access DB directly.
 * The `InsertRawEventFn` type allows wiring up the actual Drizzle insert from
 * lib/ (or from the index.ts bootstrapper), keeping this handler thin and
 * testable without a real DB binding.
 */

import type { Db } from '@globaltracker/db';
import { Hono } from 'hono';
import { clampEventTime } from '../lib/event-time-clamp.js';
import { isTestModeRequest } from '../lib/test-mode.js';
import { parseLeadToken, verifyLeadToken } from '../lib/lead-token.js';
import { isReplay, markSeen } from '../lib/replay-protection.js';
import { createLeadTokenValidateMiddleware } from '../middleware/lead-token-validate.js';
import { safeLog } from '../middleware/sanitize-logs.js';
import { EventPayloadSchema } from './schemas/event-payload.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
  /** HMAC secret for lead_token verification. Injected as Worker secret. */
  LEAD_TOKEN_SECRET?: string;
};

type AppVariables = {
  workspace_id: string;
  page_id: string;
  request_id: string;
  /** Injected by lead-token-validate middleware (T-2-010) when __ftk cookie is valid. */
  lead_id?: string;
};

type AppEnv = { Bindings: AppBindings; Variables: AppVariables };

/**
 * Minimal raw_events insert interface.
 * Injected by the app bootstrapper (index.ts) or left undefined in tests.
 *
 * When undefined, the handler proceeds optimistically (no DB insert) and
 * logs a warning. INV-EVENT-005 is still honoured when this function is
 * provided: the insert is awaited before 202 is returned.
 */
export type InsertRawEventFn = (params: {
  workspaceId: string;
  pageId: string;
  payload: Record<string, unknown>;
  headersSanitized: Record<string, unknown>;
}) => Promise<void>;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

/**
 * Create the events sub-router with optional DB and raw_events insert function.
 *
 * @param insertRawEvent - injected by app bootstrapper; undefined in tests
 * @param db             - Drizzle DB for lead-token-validate middleware (T-2-010)
 */
export function createEventsRoute(
  insertRawEvent?: InsertRawEventFn,
  db?: Db,
): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  // T-2-010: apply lead-token-validate middleware before the POST handler.
  // Injects lead_id when __ftk cookie is present and valid.
  // Anonymous events (no cookie or invalid cookie) pass through unblocked.
  router.use('/', createLeadTokenValidateMiddleware(db));

  router.post('/', async (c) => {
    const requestId = c.get('request_id');
    const workspaceId = c.get('workspace_id');
    const pageId = c.get('page_id');

    // -----------------------------------------------------------------------
    // Step 1: Parse JSON body
    // -----------------------------------------------------------------------
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      // BR-PRIVACY-001: no PII in error response
      return c.json(
        {
          error: 'validation_error',
          details: 'invalid json',
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Zod validation
    // CONTRACT-api-events-v1: body must conform to EventPayloadSchema
    // -----------------------------------------------------------------------
    const parsed = EventPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      // BR-PRIVACY-001: zodError.flatten() contains field names, not values
      return c.json(
        {
          error: 'validation_error',
          details: parsed.error.flatten(),
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const payload = parsed.data;

    // -----------------------------------------------------------------------
    // Step 3: Clamp event_time
    // BR-EVENT-002: event_time must not be in the future or past > clamp window.
    // INV-EVENT-002: clampEventTime applied transparently — never rejects.
    // -----------------------------------------------------------------------
    const receivedAtMs = Date.now();
    const clientTs = new Date(payload.event_time).getTime();
    const { eventTime: clampedTs, wasClamped } = clampEventTime(
      clientTs,
      receivedAtMs,
    );

    if (wasClamped) {
      // BR-PRIVACY-001: log only non-PII fields
      safeLog('warn', {
        event: 'event_time_clamped',
        request_id: requestId,
        workspace_id: workspaceId,
        page_id: pageId,
        event_id: payload.event_id,
      });
    }

    const effectiveEventTime = new Date(clampedTs).toISOString();

    // -----------------------------------------------------------------------
    // Step 4: Replay protection
    // BR-EVENT-003: (event_id, workspace_id) must be unique within 7-day window.
    // INV-EVENT-003: duplicate event_id → 202 duplicate_accepted (idempotent).
    // -----------------------------------------------------------------------
    const duplicate = await isReplay(
      payload.event_id,
      workspaceId,
      c.env.GT_KV,
    );
    if (duplicate) {
      // BR-EVENT-003: replay — return 202 idempotently, no insert
      safeLog('info', {
        event: 'event_duplicate_accepted',
        request_id: requestId,
        workspace_id: workspaceId,
        event_id: payload.event_id,
      });
      return c.json(
        {
          event_id: payload.event_id,
          status: 'duplicate_accepted' as const,
          request_id: requestId,
        },
        202,
        { 'X-Request-Id': requestId },
      );
    }

    // -----------------------------------------------------------------------
    // Step 5: Validate lead_token HMAC when present
    // BR-EVENT-004: lead_token HMAC must be valid; invalid → 401.
    // INV-IDENTITY-006: verifyLeadToken is timing-safe (crypto.subtle.verify).
    // -----------------------------------------------------------------------
    if (payload.lead_token) {
      const token = payload.lead_token;
      const secret = c.env.LEAD_TOKEN_SECRET;

      if (!secret) {
        // Secret not configured — cannot validate; reject to be safe
        safeLog('error', {
          event: 'lead_token_secret_missing',
          request_id: requestId,
          workspace_id: workspaceId,
        });
        return c.json(
          { error: 'invalid_lead_token', request_id: requestId },
          401,
          { 'X-Request-Id': requestId },
        );
      }

      // Parse token to extract leadId for HMAC verification
      const tokenPayload = parseLeadToken(token);
      if (!tokenPayload) {
        // BR-PRIVACY-001: no PII in response; do not echo token
        return c.json(
          { error: 'invalid_lead_token', request_id: requestId },
          401,
          { 'X-Request-Id': requestId },
        );
      }

      // Verify workspace claim matches the authenticated workspace
      if (tokenPayload.workspaceId !== workspaceId) {
        return c.json(
          { error: 'invalid_lead_token', request_id: requestId },
          401,
          { 'X-Request-Id': requestId },
        );
      }

      // BR-EVENT-004: timing-safe HMAC verification via crypto.subtle.verify
      const secretBytes = new TextEncoder().encode(secret);
      const valid = await verifyLeadToken(
        token,
        tokenPayload.leadId,
        tokenPayload.workspaceId,
        secretBytes,
      );

      if (!valid) {
        // BR-PRIVACY-001: do not log token value
        safeLog('warn', {
          event: 'lead_token_hmac_invalid',
          request_id: requestId,
          workspace_id: workspaceId,
        });
        return c.json(
          { error: 'invalid_lead_token', request_id: requestId },
          401,
          { 'X-Request-Id': requestId },
        );
      }
    }

    // -----------------------------------------------------------------------
    // Step 6: Insert into raw_events
    // INV-EVENT-005: raw_events insert awaited before 202 is returned.
    // BR-EVENT-001: Edge persists raw_events before returning 202.
    //
    // If insertRawEvent is undefined (no DB wired), skip silently and log warn.
    // -----------------------------------------------------------------------
    // T-8-004: detect test mode from header/cookie and embed in payload
    const isTest = isTestModeRequest(c.req.raw.headers);
    const rawPayload: Record<string, unknown> = {
      ...(rawBody as Record<string, unknown>),
      // Store clamped event_time so processor sees the corrected value
      event_time: effectiveEventTime,
      // BR-TEST-MODE: propagate test flag to processor for events.is_test
      is_test: isTest,
    };

    if (insertRawEvent) {
      try {
        // INV-EVENT-005: awaited before returning 202
        await insertRawEvent({
          workspaceId,
          pageId,
          payload: rawPayload,
          headersSanitized: {
            // BR-PRIVACY-001: only non-PII headers stored; no raw IP or UA
            origin: c.req.header('origin') ?? null,
            cf_ray: c.req.header('cf-ray') ?? null,
          },
        });
      } catch (err) {
        // DB error — log without PII, continue to enqueue (at-least-once durability)
        // BR-PRIVACY-001: no PII in log
        safeLog('error', {
          event: 'raw_events_insert_failed',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
        // Do NOT return 500 — enqueue still proceeds for durability
      }
    } else {
      // BR-PRIVACY-001: log only safe fields; no DB available
      safeLog('warn', {
        event: 'raw_events_skipped_no_db',
        request_id: requestId,
        workspace_id: workspaceId,
      });
    }

    // -----------------------------------------------------------------------
    // Step 7: Mark event as seen in replay protection KV
    // Must happen after insert attempt so a failed insert still deduplicates
    // on retry (idempotent behaviour).
    // BR-EVENT-003: KV TTL 7 days.
    // -----------------------------------------------------------------------
    await markSeen(payload.event_id, workspaceId, c.env.GT_KV);

    // -----------------------------------------------------------------------
    // Step 8: Enqueue to QUEUE_EVENTS for async ingestion
    // Ingestion processor normalises raw_events → events + dispatch_jobs.
    // T-2-010: include lead_id when injected by lead-token-validate middleware
    // -----------------------------------------------------------------------
    // lead_id is set by lead-token-validate middleware when __ftk is valid.
    // When absent the event is anonymous — still enqueued (valid path).
    const resolvedLeadId = c.get('lead_id');

    try {
      await c.env.QUEUE_EVENTS.send({
        event_id: payload.event_id,
        workspace_id: workspaceId,
        page_id: pageId,
        received_at: new Date(receivedAtMs).toISOString(),
        // T-2-010: lead_id from validated cookie; undefined for anonymous events
        ...(resolvedLeadId ? { lead_id: resolvedLeadId } : {}),
      });
    } catch (err) {
      // Queue error — log but still return 202 (raw_events already persisted)
      // BR-PRIVACY-001: no PII in log
      safeLog('error', {
        event: 'queue_events_enqueue_failed',
        request_id: requestId,
        workspace_id: workspaceId,
        error_type: err instanceof Error ? err.constructor.name : 'unknown',
      });
    }

    // -----------------------------------------------------------------------
    // Step 9: Return 202 Accepted
    // CONTRACT-api-events-v1: response { event_id, status, request_id }
    // -----------------------------------------------------------------------
    return c.json(
      {
        event_id: payload.event_id,
        status: 'accepted' as const,
        request_id: requestId,
      },
      202,
      { 'X-Request-Id': requestId },
    );
  });

  return router;
}

/**
 * Default export for mounting in index.ts without DB wiring.
 * To wire DB insert, use createEventsRoute(insertFn) instead.
 *
 * CONTRACT-api-events-v1: mounted at /v1/events by the orchestrator.
 */
export const eventsRoute = createEventsRoute();
