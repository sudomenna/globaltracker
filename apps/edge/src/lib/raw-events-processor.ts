/**
 * Raw events processor — processRawEvent()
 *
 * Ingestion processor for MOD-EVENT: normalises raw_events → events / lead_stages.
 *
 * Consumes:
 *   MOD-IDENTITY.resolveLeadByAliases()  — lead resolution
 *   MOD-ATTRIBUTION.recordTouches()      — attribution touches
 *
 * Dispatch jobs (dispatch_jobs table):
 *   Skipped in Sprint 2 — integration config table not yet implemented (OQ-011).
 *   Returns dispatch_jobs_created=0 until MOD-DISPATCH.createDispatchJobs() is wired in Sprint 3.
 *
 * BR-EVENT-001: raw_events insert before 202 is handled by the Edge route (not this processor)
 * BR-EVENT-002: idempotency by (workspace_id, event_id) — catch unique violation → mark 'processed' as duplicate
 * BR-PRIVACY-001: PII never in logs — hash before any log statement
 * BR-IDENTITY-003: merged lead → use canonical lead_id returned by resolveLeadByAliases
 * INV-EVENT-001: (workspace_id, event_id) unique in events
 * INV-EVENT-003: replay protection — raw_event already processed → skip re-insert
 * INV-EVENT-006: consent_snapshot populated on every event (all 'unknown' if absent)
 * INV-EVENT-007: events with valid lead_token have lead_id resolved by processor
 */

import type { Db } from '@globaltracker/db';
import { events, leadStages, rawEvents } from '@globaltracker/db';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { type AttributionParams, recordTouches } from './attribution.js';
import type { KvStore } from './idempotency.js';
import { resolveLeadByAliases } from './lead-resolver.js';
import { hashPii } from './pii.js';

// ---------------------------------------------------------------------------
// Re-export Result type (canonical pattern across lib/)
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ProcessingError =
  | { code: 'not_found'; message: string }
  | { code: 'wrong_status'; message: string; current_status: string }
  | { code: 'invalid_payload'; message: string; details?: unknown }
  | { code: 'lead_resolution_failed'; message: string }
  | { code: 'db_error'; message: string };

// ---------------------------------------------------------------------------
// Zod schemas for payload validation
// ---------------------------------------------------------------------------

/**
 * user_data accepts only canonical hashed/pseudonymous keys.
 * INV-EVENT-004: no PII in clear — only hashes and platform cookies.
 * BR-EVENT-005: user_data canonical only.
 */
const UserDataSchema = z
  .object({
    em: z.string().optional(), // email_hash (SHA-256 hex)
    ph: z.string().optional(), // phone_hash (SHA-256 hex)
    external_id_hash: z.string().optional(),
    fbc: z.string().optional(),
    fbp: z.string().optional(),
    _gcl_au: z.string().optional(),
    client_id_ga4: z.string().optional(),
    session_id_ga4: z.string().optional(),
  })
  .strict(); // BR-EVENT-005: reject unknown keys (including email, phone, name in clear)

const ConsentValueSchema = z.enum(['granted', 'denied', 'unknown']);

/**
 * consent_snapshot shape — 5 finalidades.
 * INV-EVENT-006: populated on every event; defaults all keys to 'unknown'.
 */
const ConsentSnapshotSchema = z
  .object({
    analytics: ConsentValueSchema.default('unknown'),
    marketing: ConsentValueSchema.default('unknown'),
    ad_user_data: ConsentValueSchema.default('unknown'),
    ad_personalization: ConsentValueSchema.default('unknown'),
    customer_match: ConsentValueSchema.default('unknown'),
  })
  .default({
    analytics: 'unknown',
    marketing: 'unknown',
    ad_user_data: 'unknown',
    ad_personalization: 'unknown',
    customer_match: 'unknown',
  });

/**
 * Attribution snapshot from payload.
 */
const AttributionPayloadSchema = z
  .object({
    utm_source: z.string().optional(),
    utm_medium: z.string().optional(),
    utm_campaign: z.string().optional(),
    utm_content: z.string().optional(),
    utm_term: z.string().optional(),
    fbclid: z.string().optional(),
    gclid: z.string().optional(),
    gbraid: z.string().optional(),
    wbraid: z.string().optional(),
    fbc: z.string().optional(),
    fbp: z.string().optional(),
    _gcl_au: z.string().optional(),
    _ga: z.string().optional(),
    referrer_domain: z.string().optional(),
    link_id: z.string().optional(),
    ad_account_id: z.string().optional(),
    campaign_id: z.string().optional(),
    adset_id: z.string().optional(),
    ad_id: z.string().optional(),
    creative_id: z.string().optional(),
  })
  .optional()
  .default({});

/**
 * Raw event payload schema — all fields passed from Edge to the processor.
 * PII fields (email, phone) are accepted here because the payload is in transit;
 * processor will hash them before any persistence or logging (BR-PRIVACY-001).
 */
const RawEventPayloadSchema = z.object({
  event_id: z.string().min(1).max(256),
  event_name: z.string().min(1).max(128),
  event_time: z.string().datetime({ offset: true }),
  lead_id: z.string().uuid().optional(), // pre-resolved by Edge when lead_token was valid
  lead_token: z.string().optional(), // original token (informational only; resolution is via lead_id)
  // PII fields for lead resolution — hashed before logging (BR-PRIVACY-001)
  email: z.string().email().optional(),
  phone: z.string().optional(),
  external_id: z.string().optional(),
  // Nested objects
  attribution: AttributionPayloadSchema,
  user_data: z.record(z.unknown()).optional().default({}),
  custom_data: z.record(z.unknown()).optional().default({}),
  consent: ConsentSnapshotSchema,
  // visitor_id: anonymous visitor cookie (__fvid) — present only when consent_analytics='granted'
  // INV-TRACKER-003: tracker enforces presence; processor accepts and persists as-is
  visitor_id: z.string().optional(),
  // Launch context (optional — some events arrive without a launch)
  launch_id: z.string().uuid().optional(),
  // Request context snapshot
  request_context: z.record(z.unknown()).optional().default({}),
  // is_test: injected by Edge when X-GT-Test-Mode: 1 header or __gt_test=1 cookie (T-8-004)
  is_test: z.boolean().optional().default(false),
});

type RawEventPayload = z.infer<typeof RawEventPayloadSchema>;

// ---------------------------------------------------------------------------
// Identify-type event names
// ---------------------------------------------------------------------------

/** Event names that indicate a lead identification — trigger resolveLeadByAliases. */
const LEAD_IDENTIFY_EVENT_NAMES = new Set(['Lead', 'lead_identify', 'Contact']);

/** Event names that should create a 'lead_identified' lead_stage. */
const LEAD_STAGE_IDENTIFY_EVENT_NAMES = new Set(['Lead', 'lead_identify']);

/** Event names that should create a 'purchased' lead_stage. */
const PURCHASE_EVENT_NAMES = new Set(['Purchase']);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Process a single raw_event row through the ingestion pipeline.
 *
 * Steps:
 *  1. Fetch raw_events row (must be status='pending')
 *  2. Parse and validate payload (Zod)
 *  3. Resolve lead identity when event has PII identifiers (resolveLeadByAliases)
 *  4. Insert events row
 *  5. Insert lead_stages when applicable
 *  6. Create dispatch_jobs — SKIPPED in Sprint 2 (OQ-011); returns 0
 *  7. Mark raw_events.processing_status = 'processed'
 *
 * Idempotency (BR-EVENT-002 / INV-EVENT-001):
 *   If events row already exists for (workspace_id, event_id), marks raw_event as 'processed'
 *   with note 'duplicate' and returns successfully without re-inserting.
 *
 * @param raw_event_id  UUID of the raw_events row to process
 * @param db            Drizzle Db instance (DI — never imported as singleton)
 * @param _kv           KV store (reserved for future replay-protection in processor; unused in Sprint 2)
 */
export async function processRawEvent(
  raw_event_id: string,
  db: Db,
  _kv?: KvStore,
): Promise<
  Result<{ event_id: string; dispatch_jobs_created: number }, ProcessingError>
> {
  // -------------------------------------------------------------------------
  // Step 1: Fetch raw_events row
  // -------------------------------------------------------------------------
  const rawRows = await db
    .select()
    .from(rawEvents)
    .where(eq(rawEvents.id, raw_event_id))
    .limit(1);

  const rawEvent = rawRows[0];

  if (!rawEvent) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `raw_event not found: ${raw_event_id}`,
      },
    };
  }

  // INV-EVENT-003: replay protection — already processed raw_events are skipped
  if (rawEvent.processingStatus === 'processed') {
    // Already processed — return the stored event_id from payload if available
    const payloadEventId = extractEventIdFromPayload(rawEvent.payload);
    return {
      ok: true,
      value: {
        event_id: payloadEventId ?? raw_event_id,
        dispatch_jobs_created: 0,
      },
    };
  }

  if (rawEvent.processingStatus !== 'pending') {
    return {
      ok: false,
      error: {
        code: 'wrong_status',
        message: 'raw_event is not pending; cannot process',
        current_status: rawEvent.processingStatus,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: Parse and validate payload
  // -------------------------------------------------------------------------
  const parseResult = RawEventPayloadSchema.safeParse(rawEvent.payload);

  if (!parseResult.success) {
    // Mark as failed before returning error
    await markRawEventFailed(
      raw_event_id,
      `payload_validation: ${parseResult.error.message.slice(0, 500)}`,
      db,
    );
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message: 'Payload validation failed',
        details: parseResult.error.issues,
      },
    };
  }

  const payload = parseResult.data;

  // INV-TRACKER-003: visitor_id only present when consent_analytics='granted' (tracker enforces);
  // processor accepts and persists whatever the tracker sends — null if absent
  const visitorId: string | null = payload.visitor_id ?? null;

  // -------------------------------------------------------------------------
  // Step 3: Resolve lead identity
  //
  // Lead resolution occurs when:
  //   a) payload.lead_id is already provided (Edge resolved via lead_token), OR
  //   b) event is an identify-type event with email/phone/external_id
  //
  // BR-IDENTITY-003: if merge was executed, use the canonical lead_id
  // BR-PRIVACY-001: PII never in logs — hash before logging
  // INV-EVENT-007: events with valid lead_token have lead_id resolved by processor
  // -------------------------------------------------------------------------

  let resolvedLeadId: string | null = payload.lead_id ?? null;
  let attributionWasRecorded = false;

  const hasIdentifiers = Boolean(
    payload.email || payload.phone || payload.external_id,
  );
  const isIdentifyEvent = LEAD_IDENTIFY_EVENT_NAMES.has(payload.event_name);

  if (!resolvedLeadId && isIdentifyEvent && hasIdentifiers) {
    // BR-PRIVACY-001: do NOT log email/phone in clear — log hashes only
    const resolveResult = await resolveLeadByAliases(
      {
        email: payload.email,
        phone: payload.phone,
        external_id: payload.external_id,
      },
      rawEvent.workspaceId,
      db,
    );

    if (!resolveResult.ok) {
      await markRawEventFailed(
        raw_event_id,
        `lead_resolution: ${resolveResult.error.code}`,
        db,
      );
      return {
        ok: false,
        error: {
          code: 'lead_resolution_failed',
          message: resolveResult.error.message,
        },
      };
    }

    // BR-IDENTITY-003: use canonical lead_id (merge may have been executed)
    resolvedLeadId = resolveResult.value.lead_id;

    // Record attribution touches when lead was created or merged (new association)
    if (
      (resolveResult.value.was_created || resolveResult.value.merge_executed) &&
      payload.launch_id
    ) {
      const touchResult = await recordTouches(
        {
          lead_id: resolvedLeadId,
          launch_id: payload.launch_id,
          workspace_id: rawEvent.workspaceId,
          attribution: payload.attribution as AttributionParams,
          event_time: new Date(payload.event_time),
        },
        db,
      );
      // Attribution failure is non-fatal — log but don't fail the whole processor
      if (touchResult.ok) {
        attributionWasRecorded = true;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: Validate user_data against canonical schema
  // INV-EVENT-004: only canonical keys allowed in user_data
  // BR-EVENT-005: user_data canonical only
  // -------------------------------------------------------------------------
  const userDataParseResult = UserDataSchema.safeParse(payload.user_data);
  const safeUserData: Record<string, unknown> = userDataParseResult.success
    ? (userDataParseResult.data as Record<string, unknown>)
    : {}; // Strip non-canonical keys rather than failing the whole event

  // -------------------------------------------------------------------------
  // Step 5: Build consent snapshot
  // INV-EVENT-006: consent_snapshot populated on every event (all 'unknown' if absent)
  // -------------------------------------------------------------------------
  const consentSnapshot = payload.consent; // already defaulted by Zod schema

  // -------------------------------------------------------------------------
  // Step 6: Insert events row
  // INV-EVENT-001: (workspace_id, event_id) unique — catch unique violation → duplicate
  // BR-EVENT-002: idempotency by (workspace_id, event_id)
  // -------------------------------------------------------------------------
  let insertedEventId: string;

  try {
    const inserted = await db
      .insert(events)
      .values({
        workspaceId: rawEvent.workspaceId,
        pageId: rawEvent.pageId ?? undefined,
        launchId: payload.launch_id ?? undefined,
        leadId: resolvedLeadId ?? undefined,
        visitorId: visitorId ?? undefined,
        eventId: payload.event_id,
        eventName: payload.event_name,
        eventSource: 'tracker', // fixed for events from tracker.js
        schemaVersion: 1, // fixed for Sprint 2
        eventTime: new Date(payload.event_time),
        receivedAt: rawEvent.receivedAt,
        attribution: payload.attribution as Record<string, unknown>,
        userData: safeUserData,
        customData: payload.custom_data as Record<string, unknown>,
        consentSnapshot: consentSnapshot as Record<string, unknown>,
        requestContext: payload.request_context as Record<string, unknown>,
        processingStatus: 'accepted',
        isTest: payload.is_test,
      })
      .returning({ id: events.id });

    const row = inserted[0];
    if (!row) {
      throw new Error('Insert returned no rows');
    }
    insertedEventId = row.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // BR-EVENT-002: unique violation on (workspace_id, event_id) → idempotent success
    // INV-EVENT-001: (workspace_id, event_id) unique — duplicate detected here
    if (isUniqueViolation(message)) {
      await markRawEventProcessed(raw_event_id, db);
      return {
        ok: true,
        value: {
          event_id: payload.event_id,
          dispatch_jobs_created: 0,
        },
      };
    }

    await markRawEventFailed(
      raw_event_id,
      `db_insert: ${message.slice(0, 500)}`,
      db,
    );
    return {
      ok: false,
      error: { code: 'db_error', message },
    };
  }

  // -------------------------------------------------------------------------
  // Step 6b: Retroactive backfill — link anonymous events to resolved lead_id
  //
  // INV-EVENT-007: events with valid lead_token have lead_id resolved by processor
  // When a lead is resolved and the current event has a visitor_id, backfill
  // lead_id on prior anonymous events (lead_id IS NULL) sharing the same visitor_id.
  //
  // Idempotency: WHERE lead_id IS NULL ensures re-executions are noop for already-linked rows.
  // Non-fatal: backfill failure never blocks the main event processing — log and continue.
  // INV-TRACKER-003: visitor_id is only present when consent_analytics='granted' (tracker enforces).
  // -------------------------------------------------------------------------
  if (resolvedLeadId && visitorId) {
    try {
      await db
        .update(events)
        .set({ leadId: resolvedLeadId })
        .where(
          and(
            eq(events.workspaceId, rawEvent.workspaceId),
            eq(events.visitorId, visitorId),
            isNull(events.leadId),
          ),
        );
    } catch (backfillErr) {
      // BR-PRIVACY-001: log only non-PII context — no visitor_id or lead_id values in message
      const backfillMsg =
        backfillErr instanceof Error
          ? backfillErr.message
          : String(backfillErr);
      // eslint-disable-next-line no-console -- safeLog unavailable here; no PII in message
      console.error(
        `[visitor_id backfill failed] raw_event_id=${raw_event_id} err=${backfillMsg.slice(0, 200)}`,
      );
      // Continue — event was already inserted successfully
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: Insert lead_stages when applicable
  //
  // Lead stage rules:
  //   'Lead' | 'lead_identify' → stage='lead_identified', is_recurring=false
  //   'Purchase'               → stage='purchased',       is_recurring=false
  //
  // Requires: resolvedLeadId + launch_id (both must be present for a stage row)
  // -------------------------------------------------------------------------
  if (resolvedLeadId && payload.launch_id) {
    if (LEAD_STAGE_IDENTIFY_EVENT_NAMES.has(payload.event_name)) {
      await insertLeadStageIgnoreDuplicate(
        {
          workspaceId: rawEvent.workspaceId,
          leadId: resolvedLeadId,
          launchId: payload.launch_id,
          stage: 'lead_identified',
          isRecurring: false,
          sourceEventId: insertedEventId,
        },
        db,
      );
    } else if (PURCHASE_EVENT_NAMES.has(payload.event_name)) {
      await insertLeadStageIgnoreDuplicate(
        {
          workspaceId: rawEvent.workspaceId,
          leadId: resolvedLeadId,
          launchId: payload.launch_id,
          stage: 'purchased',
          isRecurring: false,
          sourceEventId: insertedEventId,
        },
        db,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 8: Create dispatch_jobs
  //
  // OQ-011: dispatch_jobs creation requires integration config per workspace
  // (table not yet implemented — Sprint 3+). Skip silently.
  // dispatch_jobs_created = 0 until MOD-DISPATCH.createDispatchJobs() is wired.
  // -------------------------------------------------------------------------
  const dispatchJobsCreated = 0;

  // -------------------------------------------------------------------------
  // Step 9: Mark raw_event as processed
  // -------------------------------------------------------------------------
  await markRawEventProcessed(raw_event_id, db);

  return {
    ok: true,
    value: {
      event_id: payload.event_id,
      dispatch_jobs_created: dispatchJobsCreated,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extracts event_id from a raw payload object (pre-validation, best-effort).
 * Used when returning early for already-processed raw_events.
 */
function extractEventIdFromPayload(payload: unknown): string | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'event_id' in payload &&
    typeof (payload as Record<string, unknown>).event_id === 'string'
  ) {
    return (payload as Record<string, unknown>).event_id as string;
  }
  return null;
}

/**
 * Returns true when the DB error message indicates a unique constraint violation.
 * Covers Postgres error code 23505 and Drizzle/postgres.js message patterns.
 */
function isUniqueViolation(message: string): boolean {
  return (
    message.includes('23505') ||
    message.toLowerCase().includes('unique') ||
    message.toLowerCase().includes('duplicate key')
  );
}

/**
 * Marks a raw_event as 'processed' with processed_at = now().
 */
async function markRawEventProcessed(
  raw_event_id: string,
  db: Db,
): Promise<void> {
  await db
    .update(rawEvents)
    .set({
      processingStatus: 'processed',
      processedAt: new Date(),
    })
    .where(eq(rawEvents.id, raw_event_id));
}

/**
 * Marks a raw_event as 'failed' with an error message.
 * BR-PRIVACY-001: error message must never contain PII — caller is responsible.
 */
async function markRawEventFailed(
  raw_event_id: string,
  errorMessage: string,
  db: Db,
): Promise<void> {
  await db
    .update(rawEvents)
    .set({
      processingStatus: 'failed',
      processedAt: new Date(),
      processingError: errorMessage,
    })
    .where(eq(rawEvents.id, raw_event_id));
}

/**
 * Inserts a lead_stages row, ignoring unique constraint violations
 * (INV-FUNNEL-001: non-recurring stages are unique per lead+launch+stage).
 */
async function insertLeadStageIgnoreDuplicate(
  input: {
    workspaceId: string;
    leadId: string;
    launchId: string;
    stage: string;
    isRecurring: boolean;
    sourceEventId: string;
  },
  db: Db,
): Promise<void> {
  try {
    await db.insert(leadStages).values({
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      launchId: input.launchId,
      stage: input.stage,
      isRecurring: input.isRecurring,
      sourceEventId: input.sourceEventId,
    });
  } catch (err) {
    // INV-FUNNEL-001: duplicate stage for non-recurring entry → ignore silently
    const message = err instanceof Error ? err.message : String(err);
    if (!isUniqueViolation(message)) {
      throw err; // Re-throw non-duplicate errors
    }
  }
}

// ---------------------------------------------------------------------------
// Exported helpers (useful for tests)
// ---------------------------------------------------------------------------

export { UserDataSchema, ConsentSnapshotSchema, RawEventPayloadSchema };
export type { RawEventPayload };
