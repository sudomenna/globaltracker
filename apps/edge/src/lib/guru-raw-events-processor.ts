/**
 * guru-raw-events-processor.ts — Queue processor for Guru webhook events.
 *
 * T-ID: T-GURU-PROC-001
 *
 * Consumes raw_events rows with platform='guru' (enriched by the Guru webhook handler).
 * Normalises the payload → events / lead_stages tables, mirroring the tracker
 * processor pattern in raw-events-processor.ts.
 *
 * BRs applied:
 *   BR-WEBHOOK-004: lead resolution hierarchy (pptc > email > phone)
 *   BR-PRIVACY-001: PII never in logs — hash before any log statement
 *   BR-EVENT-002: idempotency by (workspace_id, event_id) — catch unique violation
 *   INV-EVENT-001: (workspace_id, event_id) unique in events
 *   INV-EVENT-003: replay protection — raw_event already processed → skip re-insert
 *   BR-IDENTITY-003: merged lead → use canonical lead_id returned by resolveLeadByAliases
 */

import type { Db } from '@globaltracker/db';
import { events, leadStages, leads, rawEvents } from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';
import { resolveLeadByAliases } from './lead-resolver.js';
import {
  type FunnelBlueprint,
  type Result,
  type ProcessingError,
  getBlueprintForLaunch,
  matchesStageFilters,
} from './raw-events-processor.js';

// Re-export ProcessingError for callers that want to type the error union.
export type { ProcessingError, Result };

// ---------------------------------------------------------------------------
// Zod schema for the Guru-enriched raw_event payload
// ---------------------------------------------------------------------------

/**
 * Schema for the enriched JSONB stored by the Guru webhook handler.
 * Fields prefixed with _ are injected by the handler (not from Guru's API).
 *
 * passthrough() is intentional: we do not break on future Guru fields.
 */
const GuruRawEventPayloadSchema = z
  .object({
    _guru_event_id: z.string(),
    _guru_event_type: z.string(),
    launch_id: z.string().uuid().optional(),
    funnel_role: z.string().optional(),
    webhook_type: z.string(),
    contact: z
      .object({
        email: z.string().email().nullish(),
        phone_number: z.string().nullish(),
        phone_local_code: z.string().nullish(),
      })
      .optional(),
    source: z
      .object({
        pptc: z.string().nullish(),
        utm_source: z.string().nullish(),
        utm_campaign: z.string().nullish(),
        utm_medium: z.string().nullish(),
        utm_content: z.string().nullish(),
        utm_term: z.string().nullish(),
      })
      .optional(),
    payment: z
      .object({
        total: z.number().nullish(),
        currency: z.string().nullish(),
      })
      .optional(),
    product: z
      .object({
        id: z.string().nullish(),
        name: z.string().nullish(),
      })
      .optional(),
    confirmed_at: z.string().nullish(),
    created_at: z.string().nullish(),
  })
  .passthrough();

type GuruRawEventPayload = z.infer<typeof GuruRawEventPayloadSchema>;

// ---------------------------------------------------------------------------
// Helper: extract _guru_event_id from an already-processed raw payload
// ---------------------------------------------------------------------------

function extractGuruEventIdFromPayload(payload: unknown): string | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    '_guru_event_id' in payload &&
    typeof (payload as Record<string, unknown>)._guru_event_id === 'string'
  ) {
    return (payload as Record<string, unknown>)._guru_event_id as string;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: is unique constraint violation
// ---------------------------------------------------------------------------

function isUniqueViolation(message: string): boolean {
  return (
    message.includes('23505') ||
    message.toLowerCase().includes('unique') ||
    message.toLowerCase().includes('duplicate key')
  );
}

// ---------------------------------------------------------------------------
// Helper: mark raw_event processed
// ---------------------------------------------------------------------------

async function markRawEventProcessed(
  raw_event_id: string,
  db: Db,
): Promise<void> {
  await db
    .update(rawEvents)
    .set({ processingStatus: 'processed', processedAt: new Date() })
    .where(eq(rawEvents.id, raw_event_id));
}

// ---------------------------------------------------------------------------
// Helper: mark raw_event failed
// BR-PRIVACY-001: errorMessage must never contain PII — caller is responsible
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helper: insert lead_stages row ignoring unique constraint duplicates
// ---------------------------------------------------------------------------

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
    const message = err instanceof Error ? err.message : String(err);
    if (!isUniqueViolation(message)) {
      throw err;
    }
    // INV-FUNNEL-001: duplicate non-recurring stage → ignore silently
  }
}

// ---------------------------------------------------------------------------
// Helper: resolve lead_id from pptc (lead_public_id = internal lead.id)
// BR-WEBHOOK-004: pptc is highest-priority lead resolution signal
// ---------------------------------------------------------------------------

async function resolveLeadByPptc(
  pptc: string,
  workspaceId: string,
  db: Db,
): Promise<string | null> {
  // BR-WEBHOOK-004: pptc = lead_public_id which equals internal lead.id (no
  // separate public_id column on leads — confirmed by lead.ts line 299).
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, pptc), eq(leads.workspaceId, workspaceId)))
    .limit(1);

  return rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Processes a single raw_events row that originated from a Guru webhook.
 *
 * Steps:
 *   1. Fetch raw_events row (must be status='pending' or return early if already 'processed')
 *   2. Validate / extract payload fields via GuruRawEventPayloadSchema (Zod)
 *   3. Resolve lead identity: pptc → resolveLeadByAliases(email, phone) → null
 *   4. Insert events row (idempotent on (workspace_id, event_id) unique violation)
 *   5. Insert lead_stages when resolvedLeadId + launch_id are available
 *   6. Mark raw_event as 'processed'
 *   7. Return result
 *
 * BR-WEBHOOK-004: lead resolution hierarchy (pptc > email > phone)
 * BR-EVENT-002: idempotency by (workspace_id, event_id)
 * BR-PRIVACY-001: PII never in logs
 * INV-EVENT-001: unique constraint on (workspace_id, event_id)
 * INV-EVENT-003: replay protection — skip if already processed
 * BR-IDENTITY-003: canonical lead_id after merge
 */
export async function processGuruRawEvent(
  raw_event_id: string,
  db: Db,
): Promise<
  Result<
    {
      event_id: string;
      dispatch_jobs_created: number;
      dispatch_job_ids: Array<{ id: string; destination: string }>;
    },
    ProcessingError
  >
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

  // INV-EVENT-003: replay protection — already processed → skip
  if (rawEvent.processingStatus === 'processed') {
    const payloadEventId = extractGuruEventIdFromPayload(rawEvent.payload);
    return {
      ok: true,
      value: {
        event_id: payloadEventId ?? raw_event_id,
        dispatch_jobs_created: 0,
        dispatch_job_ids: [],
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
  // Step 2: Validate / extract payload
  // -------------------------------------------------------------------------
  const parseResult = GuruRawEventPayloadSchema.safeParse(rawEvent.payload);

  if (!parseResult.success) {
    await markRawEventFailed(
      raw_event_id,
      `payload_validation: ${parseResult.error.message.slice(0, 500)}`,
      db,
    );
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message: 'Guru payload validation failed',
        details: parseResult.error.issues,
      },
    };
  }

  const payload: GuruRawEventPayload = parseResult.data;

  // -------------------------------------------------------------------------
  // Step 3: Resolve lead identity
  //
  // Hierarchy (BR-WEBHOOK-004):
  //   a) source.pptc → lookup leads by id (lead_public_id = internal lead.id)
  //   b) contact.email or contact.phone → resolveLeadByAliases()
  //   c) None available → resolvedLeadId = null (event without lead link; non-fatal)
  //
  // BR-PRIVACY-001: email/phone never logged in clear
  // BR-IDENTITY-003: canonical lead_id after potential merge
  // -------------------------------------------------------------------------

  let resolvedLeadId: string | null = null;

  // Priority a: pptc
  // BR-WEBHOOK-004: pptc is highest-priority lead resolution signal
  if (payload.source?.pptc) {
    resolvedLeadId = await resolveLeadByPptc(
      payload.source.pptc,
      rawEvent.workspaceId,
      db,
    );
    // Non-fatal if pptc doesn't resolve (stale or wrong token) — fall through
    if (!resolvedLeadId) {
      safeLog('warn', {
        event: 'guru_pptc_not_found',
        raw_event_id,
        // BR-PRIVACY-001: pptc is a UUID (non-PII internal ID); safe to log
        pptc: payload.source.pptc,
      });
    }
  }

  // Priority b: email / phone via resolveLeadByAliases
  if (!resolvedLeadId) {
    const email = payload.contact?.email;
    // Compose E.164-style phone from local_code + number when both are present.
    // Guru sends phone_number without country prefix; phone_local_code is the dialing code.
    const rawPhone = payload.contact?.phone_number;
    const localCode = payload.contact?.phone_local_code;
    const phone =
      rawPhone && localCode ? `+${localCode}${rawPhone}` : rawPhone ?? null;

    if (email || phone) {
      // BR-PRIVACY-001: do NOT log email or phone in clear — pass to resolver only
      const resolveResult = await resolveLeadByAliases(
        { email, phone },
        rawEvent.workspaceId,
        db,
      );

      if (resolveResult.ok) {
        // BR-IDENTITY-003: use canonical lead_id (merge may have been executed)
        resolvedLeadId = resolveResult.value.lead_id;
      } else {
        // Lead resolution failure is non-fatal for Guru events:
        // we persist the event without a lead link rather than dropping it.
        safeLog('warn', {
          event: 'guru_lead_resolution_failed',
          raw_event_id,
          error_code: resolveResult.error.code,
        });
      }
    }
  }

  // Priority c: no identifier available — resolvedLeadId remains null

  // -------------------------------------------------------------------------
  // Step 4: Insert events row
  // INV-EVENT-001: (workspace_id, event_id) unique
  // BR-EVENT-002: idempotency via unique violation catch
  // -------------------------------------------------------------------------

  const eventTime = (() => {
    const raw = payload.confirmed_at ?? payload.created_at;
    if (raw) {
      const d = new Date(raw);
      return isNaN(d.getTime()) ? new Date() : d;
    }
    return new Date();
  })();

  let insertedEventId: string;

  try {
    const inserted = await db
      .insert(events)
      .values({
        workspaceId: rawEvent.workspaceId,
        launchId: payload.launch_id ?? undefined,
        leadId: resolvedLeadId ?? undefined,
        eventId: payload._guru_event_id,
        eventName: payload._guru_event_type, // "Purchase", "RefundProcessed", etc.
        eventSource: 'webhook:guru',
        schemaVersion: 1,
        eventTime,
        receivedAt: rawEvent.receivedAt,
        attribution: {
          utm_source: payload.source?.utm_source ?? null,
          utm_campaign: payload.source?.utm_campaign ?? null,
          utm_medium: payload.source?.utm_medium ?? null,
          utm_content: payload.source?.utm_content ?? null,
          utm_term: payload.source?.utm_term ?? null,
        },
        userData: {},
        customData: {
          funnel_role: payload.funnel_role ?? null,
          // BR-EVENT-002: amount stored in base unit (currency units), not centavos
          amount:
            payload.payment?.total != null
              ? payload.payment.total / 100
              : null,
          currency: payload.payment?.currency ?? null,
          product_id: payload.product?.id ?? null,
          product_name: payload.product?.name ?? null,
        },
        // Buyer who completed checkout → implicit consent granted
        // INV-EVENT-006: consent_snapshot populated on every event
        consentSnapshot: {
          analytics: 'granted',
          marketing: 'granted',
          ad_user_data: 'granted',
          ad_personalization: 'granted',
          customer_match: 'granted',
        },
        requestContext: {},
        processingStatus: 'accepted',
        isTest: false,
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
    if (isUniqueViolation(message)) {
      await markRawEventProcessed(raw_event_id, db);
      return {
        ok: true,
        value: {
          event_id: payload._guru_event_id,
          dispatch_jobs_created: 0,
          dispatch_job_ids: [],
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
  // Step 5: Insert lead_stages
  //
  // Requires resolvedLeadId + launch_id (both must be present).
  //
  // Dynamic path (blueprint): iterate stages, match via source_events + filters.
  //   customData = { funnel_role } so that source_event_filters.funnel_role
  //   correctly triggers product-specific stages (e.g. purchased_workshop).
  //
  // Fallback (no blueprint): Purchase → stage='purchased'.
  // -------------------------------------------------------------------------
  if (resolvedLeadId && payload.launch_id) {
    let blueprint: FunnelBlueprint | null = null;
    try {
      blueprint = await getBlueprintForLaunch(payload.launch_id, db);
    } catch {
      // getBlueprintForLaunch already handles errors internally; this is belt-and-suspenders
      blueprint = null;
    }

    const customDataForFilters: Record<string, unknown> = {
      funnel_role: payload.funnel_role ?? null,
    };

    if (blueprint !== null) {
      // Dynamic blueprint-driven stage resolution
      for (const stage of blueprint.stages) {
        if (
          matchesStageFilters(
            payload._guru_event_type,
            customDataForFilters,
            stage,
          )
        ) {
          await insertLeadStageIgnoreDuplicate(
            {
              workspaceId: rawEvent.workspaceId,
              leadId: resolvedLeadId,
              launchId: payload.launch_id,
              stage: stage.slug,
              isRecurring: stage.is_recurring,
              sourceEventId: insertedEventId,
            },
            db,
          );
        }
      }
    } else {
      // Fallback: hardcoded stage rules for launches without a blueprint
      if (payload._guru_event_type === 'Purchase') {
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
  }

  // -------------------------------------------------------------------------
  // Step 6: Mark raw_event as processed
  // -------------------------------------------------------------------------
  await markRawEventProcessed(raw_event_id, db);

  // -------------------------------------------------------------------------
  // Step 7: Return
  // -------------------------------------------------------------------------
  return {
    ok: true,
    value: {
      event_id: payload._guru_event_id,
      dispatch_jobs_created: 0,
      dispatch_job_ids: [],
    },
  };
}
