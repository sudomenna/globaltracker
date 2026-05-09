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
import {
  events,
  launches,
  leadStages,
  rawEvents,
  workspaces,
} from '@globaltracker/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';
import { type AttributionParams, recordTouches } from './attribution.js';
import { type DispatchJobInput, createDispatchJobs } from './dispatch.js';
import type { KvStore } from './idempotency.js';
import { jsonb } from './jsonb-cast.js';
import { resolveLeadByAliases } from './lead-resolver.js';
import { applyTagRules } from './lead-tags.js';
import { promoteLeadLifecycle } from './lifecycle-promoter.js';
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
    em: z.string().nullish(), // email_hash (SHA-256 hex)
    ph: z.string().nullish(), // phone_hash (SHA-256 hex)
    external_id_hash: z.string().nullish(),
    fbc: z.string().nullish(),
    fbp: z.string().nullish(),
    _gcl_au: z.string().nullish(),
    _ga: z.string().nullish(), // GA4 client cookie
    client_id_ga4: z.string().nullish(),
    session_id_ga4: z.string().nullish(),
    fvid: z.string().nullish(), // GlobalTracker visitor fingerprint
    // T-16-001B / BR-PRIVACY-001 (revisada): IP/UA capturados em /v1/events para EMQ Meta CAPI / Google Enhanced.
    client_ip_address: z.string().nullish(),
    client_user_agent: z.string().nullish(),
    // Geo derivado de Cloudflare request.cf (eventos browser) ou contact.address do Guru (Purchase).
    // Raw (plain text) — cada dispatcher aplica normalização/hash conforme sua spec.
    geo_city: z.string().nullish(),
    geo_region_code: z.string().nullish(),
    geo_postal_code: z.string().nullish(),
    geo_country: z.string().nullish(),
  })
  .strict(); // BR-EVENT-005: reject unknown keys (including email, phone, name in clear)

const ConsentValueSchema = z.preprocess(
  (val) => {
    if (val === true) return 'granted';
    if (val === false) return 'denied';
    return val;
  },
  z.enum(['granted', 'denied', 'unknown']),
);

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
// tracker.js sends null for unset fields; accept both string|null|undefined.
const AttributionPayloadSchema = z
  .object({
    utm_source: z.string().nullish(),
    utm_medium: z.string().nullish(),
    utm_campaign: z.string().nullish(),
    utm_content: z.string().nullish(),
    utm_term: z.string().nullish(),
    fbclid: z.string().nullish(),
    gclid: z.string().nullish(),
    gbraid: z.string().nullish(),
    wbraid: z.string().nullish(),
    fbc: z.string().nullish(),
    fbp: z.string().nullish(),
    _gcl_au: z.string().nullish(),
    _ga: z.string().nullish(),
    referrer: z.string().nullish(),
    referrer_domain: z.string().nullish(),
    link_id: z.string().nullish(),
    ad_account_id: z.string().nullish(),
    campaign_id: z.string().nullish(),
    adset_id: z.string().nullish(),
    ad_id: z.string().nullish(),
    creative_id: z.string().nullish(),
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
  // visitor_id: anonymous visitor cookie (__fvid) — present only when consent_analytics='granted'
  // INV-TRACKER-003: tracker enforces consent before sending
  visitor_id: z.string().optional(),
  // PII fields for lead resolution — hashed before logging (BR-PRIVACY-001)
  email: z.string().email().optional(),
  phone: z.string().optional(),
  external_id: z.string().optional(),
  // Nested objects
  attribution: AttributionPayloadSchema,
  user_data: z.record(z.unknown()).optional().default({}),
  custom_data: z.record(z.unknown()).optional().default({}),
  consent: ConsentSnapshotSchema,
  // Launch context (optional — some events arrive without a launch)
  launch_id: z.string().uuid().optional(),
  // Request context snapshot
  request_context: z.record(z.unknown()).optional().default({}),
  // Test mode flag (T-8-004): injected by Edge when X-GT-Test-Mode: 1 header or __gt_test=1 cookie
  is_test: z.boolean().optional().default(false),
});

type RawEventPayload = z.infer<typeof RawEventPayloadSchema>;

// ---------------------------------------------------------------------------
// FunnelBlueprint schema (Sprint 10 — dynamic stage resolution)
//
// Defined inline because:
//   1. packages/shared/src/schemas/funnel-blueprint.ts does not exist yet (Sprint 10 adds it).
//   2. @globaltracker/shared is not yet a declared dependency of @globaltracker/edge.
//   When Sprint 11 stabilises the shared package, this can be extracted and imported from there.
// ---------------------------------------------------------------------------

/**
 * Source event filter — optional payload predicates that must ALL match for the
 * stage to be triggered.
 *
 * NOTE: source_event_filters.funnel_role only works when Phase 3 (Sprint 11)
 * injects `funnel_role` into the event payload. Before Sprint 11, events that
 * do not carry `funnel_role` will NOT match a stage that requires it, so both
 * Purchase events from different products will fall through to the hardcoded
 * fallback stage ('purchased') instead of product-specific stages.
 */
const SourceEventFiltersSchema = z.record(z.string(), z.unknown()).optional();

/**
 * A single stage definition within a funnel blueprint.
 * source_events: list of event_name values that trigger this stage.
 * source_event_filters: optional payload key=value predicates (AND logic).
 */
const BlueprintStageSchema = z.object({
  // INV-FUNNEL-003: stage slug is non-empty and ≤ 64 chars
  slug: z.string().min(1).max(64),
  label: z.string().optional(),
  source_events: z.array(z.string().min(1).max(128)),
  source_event_filters: SourceEventFiltersSchema,
  is_recurring: z.boolean().default(false),
});

/**
 * T-LEADS-VIEW-002: tag rule schema. Espelha TagRuleSchema de
 * @globaltracker/shared (não importado aqui pelos mesmos motivos do
 * FunnelBlueprintSchema inline). Aplicação acontece em lead-tags.ts.
 *
 * `when` usa passthrough() para tolerar futuras chaves de filtro sem
 * exigir alterações de schema.
 */
const BlueprintTagRuleSchema = z.object({
  event: z.string().min(1),
  when: z
    .object({
      funnel_role: z.string().optional(),
    })
    .passthrough()
    .optional(),
  tag: z.string().min(1),
});

/**
 * Funnel blueprint stored in launches.funnel_blueprint (jsonb, nullable).
 * Added by migration 0029. Migration 0044 (T-LEADS-VIEW-001) acrescentou
 * `tag_rules` (opcional para retrocompat com blueprints antigos).
 */
const FunnelBlueprintSchema = z.object({
  version: z
    .preprocess(
      (v) => (typeof v === 'string' ? Number(v) : v),
      z.number().int().positive(),
    )
    .default(1),
  stages: z.array(BlueprintStageSchema),
  // T-LEADS-VIEW-002: optional — blueprints anteriores à migration 0044 não têm.
  tag_rules: z.array(BlueprintTagRuleSchema).optional(),
});

type FunnelBlueprint = z.infer<typeof FunnelBlueprintSchema>;

// ---------------------------------------------------------------------------
// Blueprint cache (module-level, per-launch TTL)
//
// Avoids a DB round-trip per event for the same launch within the TTL window.
// Cache key = launchId (internal UUID — unique per workspace, no cross-workspace leak).
// ---------------------------------------------------------------------------

const blueprintCache = new Map<
  string,
  { blueprint: FunnelBlueprint | null; fetchedAt: number }
>();

/**
 * TTL for blueprint cache entries.
 * Production: 60 s. Tests can override via BLUEPRINT_CACHE_TTL_MS env var (set to 0 or 5000).
 */
const BLUEPRINT_CACHE_TTL_MS =
  typeof globalThis !== 'undefined' &&
  typeof (globalThis as unknown as Record<string, unknown>)
    .BLUEPRINT_CACHE_TTL_MS === 'number'
    ? (globalThis as unknown as Record<string, number>).BLUEPRINT_CACHE_TTL_MS
    : 60_000;

/**
 * Fetches and caches the FunnelBlueprint for a launch.
 *
 * 1. Cache hit within TTL → return cached value (may be null for launches without blueprint).
 * 2. Cache miss / expired → SELECT funnel_blueprint FROM launches WHERE id = $launchId.
 * 3. null column → cache null, return null.
 * 4. Parse with FunnelBlueprintSchema.safeParse — on failure log warning, cache null.
 * 5. Return parsed blueprint.
 *
 * DI: db is injected (no singleton import) — compatible with Cloudflare Workers per-request Db.
 */
async function getBlueprintForLaunch(
  launchId: string,
  db: Db,
): Promise<FunnelBlueprint | null> {
  const now = Date.now();
  const cached = blueprintCache.get(launchId);

  if (cached !== undefined && now - cached.fetchedAt < BLUEPRINT_CACHE_TTL_MS) {
    return cached.blueprint;
  }

  // Cache miss or TTL expired — fetch from DB.
  // launches.funnel_blueprint was added by migration 0029; Drizzle schema not yet
  // regenerated with the new column — use sql`` template to reach it directly so the
  // TS type of `launches` doesn't need to be updated here.
  let rows: Array<{ funnelBlueprint: unknown }>;
  try {
    rows = await db
      .select({ funnelBlueprint: sql<unknown>`funnel_blueprint` })
      .from(launches)
      .where(eq(launches.id, launchId))
      .limit(1);
  } catch {
    // Gracefully degrade — fall back to hardcoded stage rules.
    // This also handles test environments where launches is not included in the DB mock.
    blueprintCache.set(launchId, { blueprint: null, fetchedAt: now });
    return null;
  }

  const row = rows[0];

  if (
    !row ||
    row.funnelBlueprint === null ||
    row.funnelBlueprint === undefined
  ) {
    blueprintCache.set(launchId, { blueprint: null, fetchedAt: now });
    return null;
  }

  // jsonb via sql`` template may come back as a string — parse if needed.
  const bpValue =
    typeof row.funnelBlueprint === 'string'
      ? (() => {
          try {
            return JSON.parse(row.funnelBlueprint);
          } catch {
            return row.funnelBlueprint;
          }
        })()
      : row.funnelBlueprint;
  const parsed = FunnelBlueprintSchema.safeParse(bpValue);

  if (!parsed.success) {
    // BR-PRIVACY-001: no PII in logs — launchId is a UUID, safe to log.
    safeLog('warn', {
      event: 'invalid_funnel_blueprint',
      launch_id: launchId,
      error: parsed.error.message.slice(0, 200),
    });
    blueprintCache.set(launchId, { blueprint: null, fetchedAt: now });
    return null;
  }

  blueprintCache.set(launchId, { blueprint: parsed.data, fetchedAt: now });
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Blueprint stage match helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the event matches a blueprint stage's source_events and
 * optional source_event_filters.
 *
 * Filter match rules (AND logic, null-safe):
 *   - If filters is undefined → any payload passes.
 *   - For each filter key: payload[key] must === filter value.
 *   - If payload does not have the key at all → NO match (return false).
 *
 * NOTE: source_event_filters.funnel_role only works when Sprint 11 injects
 * `funnel_role` into the event payload. Until then, events without `funnel_role`
 * will not match stages that require it — they fall through to the fallback.
 */
function matchesStageFilters(
  eventName: string,
  customData: Record<string, unknown>,
  stage: z.infer<typeof BlueprintStageSchema>,
): boolean {
  if (!stage.source_events.includes(eventName)) {
    return false;
  }

  const filters = stage.source_event_filters;
  if (!filters || Object.keys(filters).length === 0) {
    return true; // No filters — event_name match is sufficient
  }

  for (const [key, expectedValue] of Object.entries(filters)) {
    if (!(key in customData)) {
      // Null-safe: field absent → no match
      return false;
    }
    if (customData[key] !== expectedValue) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Identify-type event names
// ---------------------------------------------------------------------------

/** Event names that indicate a lead identification — trigger resolveLeadByAliases. */
const LEAD_IDENTIFY_EVENT_NAMES = new Set(['Lead', 'lead_identify', 'Contact']);

/** Event names that should create a 'lead_identified' lead_stage. */
const LEAD_STAGE_IDENTIFY_EVENT_NAMES = new Set(['Lead', 'lead_identify']);

/** Event names that should create a 'purchased' lead_stage. */
const PURCHASE_EVENT_NAMES = new Set(['Purchase']);

/**
 * Event names that are internal-only and must NEVER create dispatch_jobs.
 *
 * Rationale:
 *   - `lead_identify` is fired by tracker.js on identity rebind (multiple times per
 *     session); it represents `visitor_id` ↔ `lead_id` linkage, not a marketing
 *     conversion. Sending to Meta/Google as a custom event is noise — Meta flags
 *     it under "Eventos personalizados que pertencem a você" requiring manual
 *     confirmation, and it has no value for ad optimization.
 *   - `event_duplicate_accepted` is the dedup signal returned by /v1/events when
 *     the same event_id is replayed within a session window; pure telemetry.
 *
 * Adding an event here prevents dispatch_jobs creation entirely (Step 9) — saves
 * DB rows, eligibility-check compute, and prevents accidental delivery if
 * eligibility logic changes.
 */
const INTERNAL_ONLY_EVENT_NAMES = new Set([
  'lead_identify',
  'event_duplicate_accepted',
]);

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

  // INV-EVENT-003: replay protection — already processed raw_events are skipped
  if (rawEvent.processingStatus === 'processed') {
    // Already processed — return the stored event_id from payload if available
    const payloadEventId = extractEventIdFromPayload(rawEvent.payload);
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

  // INV-TRACKER-003: visitor_id only present when consent_analytics='granted' (tracker enforces).
  const visitorId: string | null = payload.visitor_id ?? null;

  const hasIdentifiers = Boolean(
    payload.email || payload.phone || payload.external_id,
  );
  const isIdentifyEvent = LEAD_IDENTIFY_EVENT_NAMES.has(payload.event_name);

  if (!resolvedLeadId && isIdentifyEvent && hasIdentifiers) {
    // BR-PRIVACY-001: do NOT log email/phone in clear — log hashes only
    // T-CONTACTS-LASTSEEN-002: pass the original event_time so reprocessing or
    // late-arriving events does not bump leads.last_seen_at to NOW().
    const resolveResult = await resolveLeadByAliases(
      {
        email: payload.email,
        phone: payload.phone,
        external_id: payload.external_id,
      },
      rawEvent.workspaceId,
      db,
      { eventTime: new Date(payload.event_time) },
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
  // INV-EVENT-001: (workspace_id, event_id) unique
  // BR-EVENT-002: idempotency by (workspace_id, event_id)
  //
  // T-13-008: pre-insert dedup. A tabela events é PARTITIONED BY RANGE
  // (received_at) e a unique constraint inclui received_at — então retries
  // do tracker (sessions diferentes, mesmo event_id) chegam com received_at
  // distintos e PASSAM no constraint, criando duplicatas. SELECT prévio por
  // (workspace_id, event_id) cobre o caso. Mesmo padrão já aplicado em
  // guru-raw-events-processor.ts (T-FUNIL-047).
  // -------------------------------------------------------------------------

  const existingEvent = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, rawEvent.workspaceId),
        eq(events.eventId, payload.event_id),
      ),
    )
    .limit(1);

  if (existingEvent[0]) {
    safeLog('info', {
      event: 'tracker_event_duplicate_skipped',
      raw_event_id,
      workspace_id: rawEvent.workspaceId,
      event_id: payload.event_id,
      existing_event_uuid: existingEvent[0].id,
    });
    await markRawEventProcessed(raw_event_id, db);
    return {
      ok: true,
      value: {
        event_id: payload.event_id,
        dispatch_jobs_created: 0,
        dispatch_job_ids: [],
      },
    };
  }

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
        attribution: jsonb(payload.attribution),
        userData: jsonb(safeUserData),
        customData: jsonb(payload.custom_data),
        consentSnapshot: jsonb(consentSnapshot),
        requestContext: jsonb(payload.request_context ?? {}),
        isTest: payload.is_test,
        processingStatus: 'accepted',
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
  // BR-PRODUCT-001: tracker disparou Lead event com lead resolvido → promove
  // para 'lead'. Idempotente/monotônico — não regride se já é 'cliente' ou
  // superior. INV-PRIVACY-006-soft: falha aqui é não-fatal.
  // -------------------------------------------------------------------------
  if (insertedEventId && resolvedLeadId && payload.event_name === 'Lead') {
    try {
      await promoteLeadLifecycle(db, resolvedLeadId, 'lead');
    } catch (err) {
      safeLog('warn', {
        event: 'lead_lifecycle_promotion_failed',
        raw_event_id,
        // BR-PRIVACY-001: sem PII em logs.
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: Insert lead_stages when applicable
  //
  // Dynamic blueprint lookup (Sprint 10 — T-FUNIL-012):
  //   If launches.funnel_blueprint is set, iterate its stages and match by
  //   source_events + optional source_event_filters (AND logic, null-safe).
  //
  // Fallback (backward-compat — launches without blueprint):
  //   'Lead' | 'lead_identify' → stage='lead_identified', is_recurring=false
  //   'Purchase'               → stage='purchased',       is_recurring=false
  //
  // Requires: resolvedLeadId + launch_id (both must be present for a stage row)
  // -------------------------------------------------------------------------
  if (resolvedLeadId && payload.launch_id) {
    const blueprint = await getBlueprintForLaunch(payload.launch_id, db);

    if (blueprint !== null) {
      // Dynamic path: blueprint-driven stage resolution
      // T-FUNIL-012: iterate stages and match by source_events + filters
      for (const stage of blueprint.stages) {
        const customData = payload.custom_data as Record<string, unknown>;
        if (matchesStageFilters(payload.event_name, customData, stage)) {
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
      // Fallback path: hardcoded stage rules for launches without a blueprint.
      // NOTE: source_event_filters.funnel_role (used in blueprint path) only works
      // when Sprint 11 (Phase 3) injects `funnel_role` into the event payload.
      // Until then, both Purchase events (regardless of product) map to the generic
      // 'purchased' stage via this fallback. This is intentional and backward-compatible.
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

    // -----------------------------------------------------------------------
    // T-LEADS-VIEW-002: aplicar tag_rules do blueprint para este evento.
    //
    // Tags são atributos binários atemporais workspace-scoped — complementam
    // stages (progressão monotônica) e events (fatos pontuais). A regra
    // dispara dentro deste mesmo bloco (resolvedLeadId + launch_id presentes)
    // porque blueprint vem da launch.
    //
    // BR-PRIVACY-001: só workspace_id, lead_id (UUIDs) e tag_name (string de
    // domínio) circulam — nenhum PII. INV-LEAD-TAG-001/002 enforced em
    // applyTagRules. Falha não bloqueia o pipeline (mesmo padrão do
    // promoteLeadLifecycle acima).
    //
    // tracker.js não emite Purchase nem injeta funnel_role hoje, então o
    // contexto do `when` típico para este processador é vazio (`{}`) — regras
    // sem `when` (ex.: `custom:wpp_joined` → `joined_group`) já funcionam.
    // -----------------------------------------------------------------------
    try {
      await applyTagRules({
        db,
        workspaceId: rawEvent.workspaceId,
        leadId: resolvedLeadId,
        eventName: payload.event_name,
        eventContext: {
          // tracker payload pode trazer funnel_role via custom_data (futuro);
          // null-safe quando ausente.
          funnel_role:
            typeof (payload.custom_data as Record<string, unknown>)
              ?.funnel_role === 'string'
              ? ((payload.custom_data as Record<string, unknown>)
                  .funnel_role as string)
              : undefined,
        },
        tagRules: blueprint?.tag_rules,
      });
    } catch (tagErr) {
      safeLog('warn', {
        event: 'apply_tag_rules_failed',
        raw_event_id,
        workspace_id: rawEvent.workspaceId,
        // BR-PRIVACY-001: sem PII.
        error:
          tagErr instanceof Error
            ? tagErr.message.slice(0, 200)
            : String(tagErr),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 8: Retroactive visitor_id → lead_id backfill (INV-EVENT-007)
  //
  // When a lead is resolved and the current event has a visitor_id, backfill
  // lead_id on prior anonymous events (lead_id IS NULL) sharing the same visitor_id.
  // This links anonymous PageViews to the lead after identification.
  //
  // INV-TRACKER-003: visitor_id is only present when consent_analytics='granted'.
  // -------------------------------------------------------------------------
  if (resolvedLeadId && visitorId) {
    try {
      await db
        .update(events)
        .set({ leadId: resolvedLeadId })
        .where(
          sql`workspace_id = ${rawEvent.workspaceId}::uuid
            AND lead_id IS NULL
            AND visitor_id = ${visitorId}`,
        );
    } catch (backfillErr) {
      const backfillMsg =
        backfillErr instanceof Error
          ? backfillErr.message
          : String(backfillErr);
      // BR-PRIVACY-001: log only non-PII context — no visitor_id or lead_id values in message
      safeLog('error', {
        event: 'visitor_id_backfill_failed',
        raw_event_id,
        error: backfillMsg.slice(0, 200),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 9: Create dispatch_jobs for enabled integrations
  //
  // Only for events with an insertedEventId (new events, not duplicates).
  // Reads workspaces.config.integrations to determine enabled destinations.
  // -------------------------------------------------------------------------
  let dispatchJobsCreated = 0;
  const dispatchJobIds: Array<{ id: string; destination: string }> = [];

  if (insertedEventId && !INTERNAL_ONLY_EVENT_NAMES.has(payload.event_name)) {
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
          login_customer_id?: string | null;
          oauth_token_state?: 'pending' | 'connected' | 'expired' | null;
          conversion_actions?: Record<string, string | null> | null;
          enabled?: boolean | null;
        } | null;
      };

      // Defensive parse: workspaces.config can arrive as string or object
      // depending on the underlying driver/Hyperdrive serialization path.
      const rawConfig = ws?.config as
        | Record<string, unknown>
        | string
        | null
        | undefined;
      const config: Record<string, unknown> | null =
        typeof rawConfig === 'string'
          ? (() => {
              try {
                return JSON.parse(rawConfig) as Record<string, unknown>;
              } catch {
                return null;
              }
            })()
          : (rawConfig ?? null);
      const integrations = config?.integrations as
        | IntegrationConfig
        | undefined;

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

      // Google Ads fanout (T-14-008).
      // ADR-030: only canonical events fan out to Google Ads — `custom:*`
      // events stay out of the conversion pipeline (mapping table is keyed
      // by canonical names only).
      // Effective-enabled gate: workspace must (a) have explicitly opted in
      // (enabled === true), (b) hold a connected OAuth state, (c) have a
      // customer_id, and (d) have a conversion_action mapped for the event.
      // We intentionally do NOT log per-skip here: every event in workspaces
      // without Google Ads would emit warns and pollute logs (BR-PRIVACY-001
      // is satisfied trivially since no PII is touched).
      // We always enqueue the `google_enhancement` job alongside
      // `google_ads_conversion`; downstream consumer (T-14-009) decides
      // eligibility based on event kind + PII availability and emits the
      // skip_reason per BR-DISPATCH-004.
      const isCanonicalEvent = !payload.event_name.startsWith('custom:');
      const ga = integrations?.google_ads;
      if (
        isCanonicalEvent &&
        ga?.enabled === true &&
        ga.oauth_token_state === 'connected' &&
        typeof ga.customer_id === 'string' &&
        ga.customer_id.length > 0 &&
        ga.conversion_actions
      ) {
        const conversionActionId = ga.conversion_actions[payload.event_name];
        if (
          typeof conversionActionId === 'string' &&
          conversionActionId.length > 0
        ) {
          // BR-DISPATCH-001: idempotency_key includes destination_subresource;
          // we set it to the conversion_action_id so two different conversion
          // actions on the same (workspace, event, customer) hash distinctly.
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
        error:
          dispatchErr instanceof Error
            ? dispatchErr.message.slice(0, 200)
            : String(dispatchErr),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 10: Mark raw_event as processed
  // -------------------------------------------------------------------------
  await markRawEventProcessed(raw_event_id, db);

  return {
    ok: true,
    value: {
      event_id: payload.event_id,
      dispatch_jobs_created: dispatchJobsCreated,
      dispatch_job_ids: dispatchJobIds,
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

export {
  UserDataSchema,
  ConsentSnapshotSchema,
  RawEventPayloadSchema,
  FunnelBlueprintSchema,
  blueprintCache,
  getBlueprintForLaunch,
  matchesStageFilters,
};
export type { RawEventPayload, FunnelBlueprint };
