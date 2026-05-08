/**
 * sendflow-raw-events-processor.ts — Queue processor for SendFlow webhook events.
 *
 * T-ID: T-SENDFLOW-PROC-001
 *
 * Consumes raw_events rows with platform='sendflow' (enriched by the SendFlow
 * webhook handler). Normalises the payload → events / lead_stages tables,
 * mirroring the pattern in guru-raw-events-processor.ts.
 *
 * BRs applied:
 *   BR-WEBHOOK-002: event_id derived from payload.id (injected by handler)
 *   BR-PRIVACY-001: PII never in logs
 *   BR-EVENT-002: idempotency by (workspace_id, event_id) — pre-insert dedup
 *   INV-EVENT-001: (workspace_id, event_id) unique in events
 *   INV-EVENT-003: replay protection — raw_event already processed → skip
 *   BR-IDENTITY-003: use lead_id injected by handler (resolved at ingest time)
 */

import type { Db } from '@globaltracker/db';
import { events, leadStages, rawEvents, workspaces } from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';
import {
  type Result,
  type ProcessingError,
  getBlueprintForLaunch,
  matchesStageFilters,
} from './raw-events-processor.js';
import { createDispatchJobs, type DispatchJobInput } from './dispatch.js';

export type { ProcessingError, Result };

// ---------------------------------------------------------------------------
// Zod schema for the SendFlow-enriched raw_event payload
// ---------------------------------------------------------------------------

const SendflowRawEventPayloadSchema = z
  .object({
    _provider: z.literal('sendflow'),
    // Original SendFlow fields
    id: z.string().min(1),
    event: z.enum(['group.updated.members.added', 'group.updated.members.removed']),
    data: z.object({
      campaignId: z.string(),
      campaignName: z.string().nullish(),
      groupName: z.string().nullish(),
      groupId: z.string().nullish(),
      number: z.string().nullish(),
      createdAt: z.string().nullish(),
    }).passthrough(),
    // Fields injected by the webhook handler
    _resolved_event_name: z.string(),
    _resolved_stage: z.string().nullish(),
    launch_id: z.string().uuid().nullish(),
    lead_id: z.string().uuid().nullish(),
    wpp_campaign_role: z.string().nullish(),
  })
  .passthrough();

type SendflowRawEventPayload = z.infer<typeof SendflowRawEventPayloadSchema>;

// ---------------------------------------------------------------------------
// Helpers (shared pattern with guru-raw-events-processor)
// ---------------------------------------------------------------------------

function isUniqueViolation(message: string): boolean {
  return (
    message.includes('23505') ||
    message.toLowerCase().includes('unique') ||
    message.toLowerCase().includes('duplicate key')
  );
}

async function markRawEventProcessed(raw_event_id: string, db: Db): Promise<void> {
  await db
    .update(rawEvents)
    .set({ processingStatus: 'processed', processedAt: new Date() })
    .where(eq(rawEvents.id, raw_event_id));
}

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
    if (!isUniqueViolation(message)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Processes a single raw_events row that originated from a SendFlow webhook.
 *
 * Steps:
 *   1. Fetch raw_events row (skip if already processed)
 *   2. Validate payload via SendflowRawEventPayloadSchema
 *   3. Pre-insert dedup check on (workspace_id, event_id)
 *   4. Insert events row
 *   5. Insert lead_stages if lead_id + launch_id + _resolved_stage present
 *   6. Create dispatch_jobs for enabled integrations (meta_capi, ga4_mp, google_ads)
 *   7. Mark raw_event processed
 */
export async function processSendflowRawEvent(
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
      error: { code: 'not_found', message: `raw_event not found: ${raw_event_id}` },
    };
  }

  // INV-EVENT-003: replay protection
  if (rawEvent.processingStatus === 'processed') {
    return {
      ok: true,
      value: { event_id: raw_event_id, dispatch_jobs_created: 0, dispatch_job_ids: [] },
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
  // Step 2: Validate payload
  // -------------------------------------------------------------------------
  const parseResult = SendflowRawEventPayloadSchema.safeParse(rawEvent.payload);

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
        message: 'SendFlow payload validation failed',
        details: parseResult.error.issues,
      },
    };
  }

  const payload: SendflowRawEventPayload = parseResult.data;

  const eventId = payload.id;
  const resolvedLeadId = payload.lead_id ?? null;
  const launchId = payload.launch_id ?? null;
  const resolvedStage = payload._resolved_stage ?? null;
  const eventName = payload._resolved_event_name;
  const campaignId = payload.data.campaignId;

  // -------------------------------------------------------------------------
  // Step 3: Pre-insert dedup (same partition issue as Guru — no ON CONFLICT)
  // -------------------------------------------------------------------------
  const existingEvent = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, rawEvent.workspaceId),
        eq(events.eventId, eventId),
      ),
    )
    .limit(1);

  if (existingEvent[0]) {
    safeLog('info', {
      event: 'sendflow_webhook_duplicate_skipped',
      raw_event_id,
      workspace_id: rawEvent.workspaceId,
    });
    await markRawEventProcessed(raw_event_id, db);
    return {
      ok: true,
      value: { event_id: eventId, dispatch_jobs_created: 0, dispatch_job_ids: [] },
    };
  }

  // -------------------------------------------------------------------------
  // Step 4: Insert events row
  // -------------------------------------------------------------------------
  const eventTime = (() => {
    const raw = payload.data.createdAt;
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
        launchId: launchId ?? undefined,
        leadId: resolvedLeadId ?? undefined,
        eventId,
        eventName,
        eventSource: 'webhook:sendflow',
        schemaVersion: 1,
        eventTime,
        receivedAt: rawEvent.receivedAt,
        attribution: {},
        userData: {},
        customData: {
          // campaign_id → group_id: GA4 mapper reads cd.group_id for join_group params.
          group_id: campaignId,
          campaign_id: campaignId,
          wpp_campaign_role: payload.wpp_campaign_role ?? null,
        },
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
    if (!row) throw new Error('Insert returned no rows');
    insertedEventId = row.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (isUniqueViolation(message)) {
      await markRawEventProcessed(raw_event_id, db);
      return {
        ok: true,
        value: { event_id: eventId, dispatch_jobs_created: 0, dispatch_job_ids: [] },
      };
    }

    await markRawEventFailed(raw_event_id, `db_insert: ${message.slice(0, 500)}`, db);
    return { ok: false, error: { code: 'db_error', message } };
  }

  // -------------------------------------------------------------------------
  // Step 5: Insert lead_stages
  // -------------------------------------------------------------------------
  if (resolvedLeadId && launchId && resolvedStage) {
    let blueprint = null;
    try {
      blueprint = await getBlueprintForLaunch(launchId, db);
    } catch {
      blueprint = null;
    }

    if (blueprint !== null) {
      const customDataForFilters: Record<string, unknown> = {
        wpp_campaign_role: payload.wpp_campaign_role ?? null,
      };
      for (const stage of blueprint.stages) {
        if (matchesStageFilters(eventName, customDataForFilters, stage)) {
          await insertLeadStageIgnoreDuplicate(
            {
              workspaceId: rawEvent.workspaceId,
              leadId: resolvedLeadId,
              launchId,
              stage: stage.slug,
              isRecurring: stage.is_recurring,
              sourceEventId: insertedEventId,
            },
            db,
          );
        }
      }
    } else {
      // Fallback: use _resolved_stage from handler
      await insertLeadStageIgnoreDuplicate(
        {
          workspaceId: rawEvent.workspaceId,
          leadId: resolvedLeadId,
          launchId,
          stage: resolvedStage,
          isRecurring: false,
          sourceEventId: insertedEventId,
        },
        db,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Create dispatch_jobs for enabled integrations
  // Events that are internal analytics only — no value for ad platforms.
  // -------------------------------------------------------------------------
  const SENDFLOW_INTERNAL_ONLY = new Set(['custom:wpp_left']);

  let dispatchJobsCreated = 0;
  const dispatchJobIds: Array<{ id: string; destination: string }> = [];

  if (SENDFLOW_INTERNAL_ONLY.has(eventName)) {
    await markRawEventProcessed(raw_event_id, db);
    return {
      ok: true,
      value: { event_id: eventId, dispatch_jobs_created: 0, dispatch_job_ids: [] },
    };
  }

  try {
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, rawEvent.workspaceId),
      columns: { config: true },
    });

    type IntegrationConfig = {
      meta?: { pixel_id?: string; capi_token?: string } | null;
      ga4?: { measurement_id?: string; api_secret?: string } | null;
      google_ads?: {
        customer_id?: string | null;
        oauth_token_state?: 'pending' | 'connected' | 'expired' | null;
        conversion_actions?: Record<string, string | null> | null;
        enabled?: boolean | null;
      } | null;
    };

    const rawConfig = ws?.config as Record<string, unknown> | string | null | undefined;
    const config: Record<string, unknown> | null =
      typeof rawConfig === 'string'
        ? (() => { try { return JSON.parse(rawConfig) as Record<string, unknown>; } catch { return null; } })()
        : (rawConfig ?? null);
    const integrations = config?.integrations as IntegrationConfig | undefined;

    const jobInputs: DispatchJobInput[] = [];

    if (integrations?.meta?.pixel_id && integrations.meta.capi_token) {
      jobInputs.push({
        workspace_id: rawEvent.workspaceId,
        event_id: insertedEventId,
        lead_id: resolvedLeadId ?? null,
        destination: 'meta_capi',
        destination_account_id: integrations.meta.pixel_id,
        destination_resource_id: integrations.meta.pixel_id,
      });
    }

    if (integrations?.ga4?.measurement_id && integrations.ga4.api_secret) {
      jobInputs.push({
        workspace_id: rawEvent.workspaceId,
        event_id: insertedEventId,
        lead_id: resolvedLeadId ?? null,
        destination: 'ga4_mp',
        destination_account_id: integrations.ga4.measurement_id,
        destination_resource_id: integrations.ga4.measurement_id,
      });
    }

    // ADR-030: custom:* events skip Google Ads (only canonical events fan out).
    if (!eventName.startsWith('custom:')) {
      const ga = integrations?.google_ads;
      if (
        ga?.enabled === true &&
        ga.oauth_token_state === 'connected' &&
        typeof ga.customer_id === 'string' &&
        ga.customer_id.length > 0 &&
        ga.conversion_actions
      ) {
        const conversionActionId = ga.conversion_actions[eventName];
        if (typeof conversionActionId === 'string' && conversionActionId.length > 0) {
          jobInputs.push({
            workspace_id: rawEvent.workspaceId,
            event_id: insertedEventId,
            lead_id: resolvedLeadId ?? null,
            destination: 'google_ads_conversion',
            destination_account_id: ga.customer_id,
            destination_resource_id: conversionActionId,
            destination_subresource: conversionActionId,
          });
          jobInputs.push({
            workspace_id: rawEvent.workspaceId,
            event_id: insertedEventId,
            lead_id: resolvedLeadId ?? null,
            destination: 'google_enhancement',
            destination_account_id: ga.customer_id,
            destination_resource_id: conversionActionId,
            destination_subresource: conversionActionId,
          });
        }
      }
    }

    if (jobInputs.length > 0) {
      const created = await createDispatchJobs(jobInputs, db);
      dispatchJobsCreated = created.length;
      for (const job of created) {
        dispatchJobIds.push({ id: job.id, destination: job.destination });
      }
    }
  } catch (dispatchErr) {
    safeLog('error', {
      event: 'dispatch_jobs_creation_failed',
      raw_event_id,
      error: dispatchErr instanceof Error ? dispatchErr.message.slice(0, 200) : String(dispatchErr),
    });
  }

  // -------------------------------------------------------------------------
  // Step 7: Mark raw_event as processed
  // -------------------------------------------------------------------------
  await markRawEventProcessed(raw_event_id, db);

  return {
    ok: true,
    value: {
      event_id: eventId,
      dispatch_jobs_created: dispatchJobsCreated,
      dispatch_job_ids: dispatchJobIds,
    },
  };
}
