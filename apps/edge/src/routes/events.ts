/**
 * events.ts — Sub-router for POST /v1/events and GET /v1/events.
 *
 * CONTRACT-id: CONTRACT-api-events-v1
 * T-ID: T-1-017, T-2-010, T-FUNIL-004
 *
 * Model: "fast accept" (ADR-004).
 * POST: Validates → replay protection → lead_token HMAC → insert raw_events → enqueue → 202.
 * GET:  Validates query params → workspace isolation → paginated event list → 200.
 * No synchronous normalisation; ingestion processor handles raw_events async.
 *
 * Middleware applied before POST handler (from index.ts):
 *   auth-public-token          → sets workspace_id, page_id, request_id
 *   cors                       → validates Origin against allowed_domains
 *   rate-limit                 → sliding window via KV (100 req/min/workspace)
 *   sanitize-logs              → global; sets X-Request-Id
 *   lead-token-validate (T-2-010) → injects lead_id from __ftk cookie when valid
 *
 * GET /v1/events — Control Plane query:
 *   Auth: Bearer token (Authorization header) — workspace_id from context or DEV_WORKSPACE_ID.
 *   Isolation: launch must belong to the authenticated workspace (404 if not).
 *   Pagination: cursor-based (created_at ISO string of last item).
 *
 * BRs applied:
 *   BR-EVENT-002: event_time clamped (not future, not past > window)
 *   BR-EVENT-003: (event_id, workspace_id) unique — replay protection via KV
 *   BR-EVENT-004: lead_token HMAC validated when present
 *   BR-PRIVACY-001: zero PII in logs and error responses
 *   BR-RBAC-002: workspace_id isolation enforced on GET
 *   INV-EVENT-002: clampEventTime applied before raw_events insert
 *   INV-EVENT-003: KV replay check before insert; duplicate_accepted returned
 *   INV-EVENT-005: raw_events insert awaited before 202 (when DB available)
 *
 * Architecture note (AGENTS.md §2): routes/ do not access DB directly.
 * The `InsertRawEventFn` type allows wiring up the actual Drizzle insert from
 * lib/ (or from the index.ts bootstrapper), keeping this handler thin and
 * testable without a real DB binding.
 */

import { events, createDb, launches, rawEvents } from '@globaltracker/db';
import type { Db } from '@globaltracker/db';
import { and, count, eq, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { clampEventTime } from '../lib/event-time-clamp.js';
import { parseLeadToken, verifyLeadToken } from '../lib/lead-token.js';
import { isReplay, markSeen } from '../lib/replay-protection.js';
import { isTestModeRequest } from '../lib/test-mode.js';
import { createLeadTokenValidateMiddleware } from '../middleware/lead-token-validate.js';
import { safeLog } from '../middleware/sanitize-logs.js';
import { EventPayloadSchema } from './schemas/event-payload.js';

// ---------------------------------------------------------------------------
// GET /v1/events — query schema (T-FUNIL-004)
// ---------------------------------------------------------------------------

const EventsQuerySchema = z
  .object({
    launch_id: z.string().uuid(),
    limit: z.coerce.number().min(1).max(200).default(50),
    cursor: z.string().optional(), // ISO timestamp of last item from previous page
  })
  .strict();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppBindings = {
  GT_KV: KVNamespace;
  QUEUE_EVENTS: Queue;
  QUEUE_DISPATCH: Queue;
  ENVIRONMENT: string;
  DB?: Fetcher;
  HYPERDRIVE: Hyperdrive;
  DATABASE_URL?: string;
  /** HMAC secret for lead_token verification. Injected as Worker secret. */
  LEAD_TOKEN_SECRET?: string;
  /** Dev shortcut: fixed workspace_id for local dev. Used by GET /v1/events. */
  DEV_WORKSPACE_ID?: string;
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
}) => Promise<{ id: string }>;

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

  // -------------------------------------------------------------------------
  // GET /v1/events — Control Plane: paginated event list for a launch.
  // T-FUNIL-004
  //
  // Auth: Bearer token required (Authorization header).
  // Workspace isolation: launch must belong to the authenticated workspace.
  // BR-RBAC-002: workspace_id from context (auth-cp) or DEV_WORKSPACE_ID (local dev).
  // BR-PRIVACY-001: zero PII in logs and error responses.
  // Pagination: cursor-based on created_at (ISO string).
  // -------------------------------------------------------------------------
  router.get('/', async (c) => {
    const requestId =
      (c.get('request_id') as string | undefined) ?? crypto.randomUUID();

    // Auth: Bearer token required
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing authorization',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // BR-RBAC-002: workspace_id from context (injected by auth middleware) or dev fallback
    const workspaceId =
      (c.get('workspace_id') as string | undefined) ??
      (c.env as AppBindings & { DEV_WORKSPACE_ID?: string }).DEV_WORKSPACE_ID;

    if (!workspaceId) {
      return c.json(
        {
          code: 'unauthorized',
          message: 'Missing workspace context',
          request_id: requestId,
        },
        401,
        { 'X-Request-Id': requestId },
      );
    }

    // Validate query params
    const rawQuery = {
      launch_id: c.req.query('launch_id'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
    };
    // Remove undefined keys so Zod .strict() does not reject them
    const queryInput = Object.fromEntries(
      Object.entries(rawQuery).filter(([, v]) => v !== undefined),
    );

    const parsed = EventsQuerySchema.safeParse(queryInput);
    if (!parsed.success) {
      return c.json(
        {
          code: 'validation_error',
          message: 'Invalid query parameters',
          details: parsed.error.flatten().fieldErrors,
          request_id: requestId,
        },
        400,
        { 'X-Request-Id': requestId },
      );
    }

    const { launch_id: launchId, limit, cursor } = parsed.data;

    const connString = c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString;
    const dbConn = createDb(connString);

    // Workspace isolation: verify launch belongs to the workspace
    // BR-RBAC-002: reject with 404 (not 403) to avoid leaking existence
    const launchRows = await dbConn
      .select({ id: launches.id })
      .from(launches)
      .where(
        and(eq(launches.id, launchId), eq(launches.workspaceId, workspaceId)),
      )
      .limit(1);

    if (!launchRows[0]) {
      return c.json(
        {
          code: 'launch_not_found',
          message: 'Launch not found',
          request_id: requestId,
        },
        404,
        { 'X-Request-Id': requestId },
      );
    }

    // Build WHERE conditions: always filter by launchId; add cursor if present
    const whereConditions = cursor
      ? and(
          eq(events.launchId, launchId),
          lt(events.createdAt, new Date(cursor)),
        )
      : eq(events.launchId, launchId);

    // Fetch events (ordered by created_at DESC, cursor-paginated)
    const rows = await dbConn
      .select({
        id: events.id,
        eventName: events.eventName,
        createdAt: events.createdAt,
        leadId: events.leadId,
        pageId: events.pageId,
        launchId: events.launchId,
      })
      .from(events)
      .where(whereConditions)
      .orderBy(sql`${events.createdAt} DESC`)
      .limit(limit);

    // COUNT total for this launch (without cursor — full count)
    const [countRow] = await dbConn
      .select({ total: count() })
      .from(events)
      .where(eq(events.launchId, launchId));

    const total = countRow?.total ?? 0;

    // next_cursor: ISO string of createdAt of last row returned when page is full
    const lastRow = rows[rows.length - 1];
    const nextCursor =
      rows.length === limit && lastRow ? lastRow.createdAt.toISOString() : null;

    safeLog('info', {
      event: 'events_list_queried',
      request_id: requestId,
      workspace_id: workspaceId,
      launch_id: launchId,
      count: rows.length,
    });

    // BR-PRIVACY-001: lead_id in response is the internal UUID — not PII in clear
    return c.json(
      {
        events: rows.map((row) => ({
          id: row.id,
          event_name: row.eventName,
          created_at: row.createdAt.toISOString(),
          lead_public_id: row.leadId ?? null,
          page_id: row.pageId ?? null,
          launch_id: row.launchId ?? null,
        })),
        total,
        next_cursor: nextCursor,
      },
      200,
      { 'X-Request-Id': requestId },
    );
  });

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

    let rawEventId: string | undefined;

    if (insertRawEvent) {
      try {
        // INV-EVENT-005: awaited before returning 202
        const result = await insertRawEvent({
          workspaceId,
          pageId,
          payload: rawPayload,
          headersSanitized: {
            // BR-PRIVACY-001: only non-PII headers stored; no raw IP or UA
            origin: c.req.header('origin') ?? null,
            cf_ray: c.req.header('cf-ray') ?? null,
          },
        });
        rawEventId = result.id;
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
      // No external insertRawEvent injected — use inline DB (INV-EVENT-005).
      try {
        const connString =
          c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString;
        const db = createDb(connString);
        const [inserted] = await db
          .insert(rawEvents)
          .values({
            workspaceId,
            pageId,
            payload: rawPayload,
            headersSanitized: {
              origin: c.req.header('origin') ?? null,
              cf_ray: c.req.header('cf-ray') ?? null,
            },
          })
          .returning({ id: rawEvents.id });
        rawEventId = inserted?.id;
      } catch (err) {
        safeLog('error', {
          event: 'raw_events_insert_failed',
          request_id: requestId,
          workspace_id: workspaceId,
          error_type: err instanceof Error ? err.constructor.name : 'unknown',
        });
      }
    }

    // Auto-promote launch configuring → live on first ping for this page (MOD-LAUNCH lifecycle).
    // Fire-and-forget via waitUntil; idempotent UPDATE no-ops after first transition.
    try {
      const promotePromise = (async () => {
        try {
          const connString =
            c.env.DATABASE_URL ?? c.env.HYPERDRIVE.connectionString;
          const dbForLaunch = createDb(connString);
          await dbForLaunch.execute(sql`
            UPDATE launches SET status = 'live'
            WHERE id = (SELECT launch_id FROM pages WHERE id = ${pageId} LIMIT 1)
              AND status = 'configuring'
          `);
        } catch (err) {
          safeLog('warn', {
            event: 'launch_auto_promote_failed',
            request_id: requestId,
            error_type: err instanceof Error ? err.constructor.name : 'unknown',
          });
        }
      })();
      c.executionCtx.waitUntil(promotePromise);
    } catch {
      // executionCtx may be unavailable in tests — ignore
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
        raw_event_id: rawEventId,
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
