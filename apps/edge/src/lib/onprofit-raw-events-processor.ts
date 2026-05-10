/**
 * onprofit-raw-events-processor.ts — Queue processor for OnProfit webhook events.
 *
 * Consumes raw_events rows with platform='onprofit' (enriched by the OnProfit
 * webhook handler). Normalises the payload → events / lead_stages tables,
 * mirroring the Guru processor pattern in guru-raw-events-processor.ts.
 *
 * Why a dedicated processor (vs reusing Guru): OnProfit's payload carries
 * fbc/fbp browser cookies natively, sends amounts in centavos (Guru sends in
 * units), uses a different lead-hint hierarchy, and has different status
 * semantics. Diverging keeps each processor cohesive.
 *
 * BRs applied:
 *   BR-WEBHOOK-004: lead resolution hierarchy (lead_public_id > email > cell > phone)
 *   BR-PRIVACY-001: PII never in logs — hash before any log statement
 *   BR-EVENT-002: idempotency via pre-insert lookup on (workspace_id, event_id)
 *   INV-EVENT-001: (workspace_id, event_id) unique in events
 *   INV-EVENT-003: replay protection — raw_event already processed → skip re-insert
 *   BR-IDENTITY-003: merged lead → use canonical lead_id from resolveLeadByAliases
 *   BR-PRODUCT-001 / BR-PRODUCT-002: auto-create product + lifecycle promote on Purchase
 */

import type { Db } from '@globaltracker/db';
import {
  events,
  leadStages,
  leads,
  rawEvents,
  workspaces,
} from '@globaltracker/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { safeLog } from '../middleware/sanitize-logs.js';
import { type DispatchJobInput, createDispatchJobs } from './dispatch.js';
import { jsonb } from './jsonb-cast.js';
import { normalizePhone, resolveLeadByAliases } from './lead-resolver.js';
import { applyTagRules } from './lead-tags.js';
import { promoteLeadLifecycle } from './lifecycle-promoter.js';
import { lifecycleForCategory } from './lifecycle-rules.js';
import { enrichLeadPii } from './pii-enrich.js';
import { hashPiiExternal, splitName } from './pii.js';
import { upsertProduct } from './products-resolver.js';
import {
  type FunnelBlueprint,
  type ProcessingError,
  type Result,
  getBlueprintForLaunch,
  matchesStageFilters,
} from './raw-events-processor.js';

export type { ProcessingError, Result };

// ---------------------------------------------------------------------------
// Zod schema — OnProfit-enriched raw_event payload
// ---------------------------------------------------------------------------

/**
 * Schema for the enriched JSONB stored by the OnProfit webhook handler.
 * `_onprofit_*` fields are injected by the route handler.
 *
 * passthrough() is intentional — we tolerate new OnProfit fields without
 * failing validation.
 */
const OnProfitRawEventPayloadSchema = z
  .object({
    _onprofit_event_id: z.string(),
    _onprofit_event_type: z.enum([
      'Purchase',
      'InitiateCheckout',
      'RefundProcessed',
      'Chargeback',
    ]),

    // OnProfit native fields we depend on
    id: z.number(),
    status: z.string(),
    /** CENTAVOS — divided by 100 before storing as currency unit */
    price: z.number(),
    currency: z.string(),
    payment_type: z.string().nullish(),
    purchase_date: z.string().nullish(),
    confirmation_purchase_date: z.string().nullish(),

    // Item / offer metadata (real payload 2026-05-10).
    // ONPROFIT-W1-TYPES: item_type / offer_hash / transactions are required by
    // Wave 3 (transaction_group_id + skip-dispatch on order_bumps). Schema
    // accepts them now so the processor can persist them downstream without
    // failing validation; mapper logic stays untouched.
    // Strings here (not enums) — mapper owns the discriminator decision.
    item_type: z.string().nullish(),
    product_id: z.number().nullish(),
    product_link: z.number().nullish(),
    offer_id: z.number().nullish(),
    offer_hash: z.string().nullish(),
    offer_name: z.string().nullish(),
    offer_price: z.number().nullish(),
    comission: z.string().nullish(),
    /**
     * Gateway transactions array — passthrough only. We do not validate
     * gateway internals; downstream consumers narrow as needed.
     */
    transactions: z.array(z.unknown()).nullish(),

    // UTMs
    utm_source: z.string().nullish(),
    utm_medium: z.string().nullish(),
    utm_campaign: z.string().nullish(),
    utm_content: z.string().nullish(),
    utm_term: z.string().nullish(),

    // Meta browser cookies (the headline reason this integration exists)
    fbc: z.string().nullish(),
    fbp: z.string().nullish(),

    // Loose extras
    src: z.string().nullish(),
    sck: z.string().nullish(),

    customer: z
      .object({
        name: z.string().nullish(),
        lastname: z.string().nullish(),
        document: z.string().nullish(),
        email: z.string().email().nullish(),
        phone: z.string().nullish(),
        cell: z.string().nullish(),
      })
      .optional(),

    customer_address: z
      .object({
        city: z.string().nullish(),
        state: z.string().nullish(),
        zip_code: z.string().nullish(),
        country: z.string().nullish(),
      })
      .nullish(),

    product: z
      .object({
        id: z.number(),
        name: z.string().nullish(),
        hash: z.string().nullish(),
      })
      .optional(),

    /**
     * ONPROFIT-W1-TYPES (2026-05-10): real payload may send `custom_fields`
     * as an empty array `[]` (default when operator did not configure custom
     * fields in the checkout) instead of an object. The previous schema
     * rejected the array form and forced the whole event into 'failed'.
     * Accept either shape here; consumers must narrow with `Array.isArray()`
     * before reading `.lead_public_id`.
     */
    custom_fields: z
      .union([
        z.array(z.unknown()),
        z
          .object({
            lead_public_id: z.string().nullish(),
          })
          .passthrough(),
      ])
      .nullish(),

    // Derived fields injected pela rota webhook (resolveLaunchForOnProfitEvent).
    // ONPROFIT-LAUNCH-RESOLVER (2026-05-09): paridade com Guru.
    launch_id: z.string().uuid().optional(),
    funnel_role: z.string().optional(),
  })
  .passthrough();

type OnProfitRawEventPayload = z.infer<typeof OnProfitRawEventPayloadSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractOnProfitEventIdFromPayload(payload: unknown): string | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    '_onprofit_event_id' in payload &&
    typeof (payload as Record<string, unknown>)._onprofit_event_id === 'string'
  ) {
    return (payload as Record<string, unknown>)._onprofit_event_id as string;
  }
  return null;
}

function isUniqueViolation(message: string): boolean {
  return (
    message.includes('23505') ||
    message.toLowerCase().includes('unique') ||
    message.toLowerCase().includes('duplicate key')
  );
}

async function markRawEventProcessed(
  raw_event_id: string,
  db: Db,
): Promise<void> {
  await db
    .update(rawEvents)
    .set({ processingStatus: 'processed', processedAt: new Date() })
    .where(eq(rawEvents.id, raw_event_id));
}

/**
 * BR-PRIVACY-001: errorMessage must never contain PII — caller is responsible.
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

/**
 * Resolve lead_id from pptc.
 * BR-WEBHOOK-004: pptc = lead_public_id which equals internal lead.id.
 */
async function resolveLeadByPptc(
  pptc: string,
  workspaceId: string,
  db: Db,
): Promise<string | null> {
  const rows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, pptc), eq(leads.workspaceId, workspaceId)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Parses OnProfit's "YYYY-MM-DD HH:mm:ss" timestamps.
 * No timezone in payload — treated as UTC (best available; documented in
 * mapper.ts parseOnProfitTimestamp).
 */
function parseOnProfitTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const isoLike = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZ =
    isoLike.endsWith('Z') || /[+-]\d\d:?\d\d$/.test(isoLike)
      ? isoLike
      : `${isoLike}Z`;
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * ONPROFIT-W3-PROCESSOR (2026-05-10): derives a deterministic group id that
 * unites the main-product webhook + N order-bump webhooks of the same OnProfit
 * transaction. Each OnProfit checkout fires N webhooks (one per item_type),
 * each with its own _onprofit_event_id, but sharing `offer_hash` + customer
 * email + roughly the same timestamp. Wave 4 will use this id in the
 * dispatcher to aggregate value across rows.
 *
 * Convention: sha256(workspaceId + ":" + emailNormalized + ":" + offerHash +
 *                    ":" + bucket(occurredAt, 5min))[:32]
 *
 * Bucket = floor(epoch_seconds / 300) * 300. 5min is safe against typical
 * webhook delay (up to ~60s observed) yet tight enough to avoid colliding two
 * distinct orders of the same customer that happen to land minutes apart.
 *
 * BR-PRIVACY-001: email is normalized + hashed; never appears raw in the
 * returned id nor in any log.
 *
 * Returns null when email or offer_hash are missing — caller still persists,
 * just loses aggregation capability (degrades to 1 dispatch per event).
 */
async function deriveTransactionGroupId(input: {
  workspaceId: string;
  email: string | null | undefined;
  offerHash: string | null | undefined;
  occurredAt: Date;
}): Promise<string | null> {
  if (!input.email || !input.offerHash) return null;
  const emailNorm = input.email.trim().toLowerCase();
  const bucketSec = Math.floor(input.occurredAt.getTime() / 1000 / 300) * 300;
  const raw = `${input.workspaceId}:${emailNorm}:${input.offerHash}:${bucketSec}`;
  const enc = new TextEncoder().encode(raw);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Processes a single raw_events row that originated from an OnProfit webhook.
 *
 * Steps:
 *   1. Fetch raw_events row; short-circuit if already processed (INV-EVENT-003)
 *   2. Validate payload (Zod)
 *   3. Resolve lead identity: pptc → resolveLeadByAliases(email, phone) → null
 *   4. Update fn/ln hashes from customer.name + customer.lastname
 *   5. Enrich in-clear PII (email_enc / phone_enc / name_enc) — non-blocking
 *   6. Auto-create product + promote lifecycle (Purchase only) — non-blocking
 *   7. Pre-insert dedup lookup on (workspace_id, event_id) — BR-EVENT-002
 *   8. Insert events row with attribution + Meta cookies + geo from address
 *   9. Insert lead_stages via blueprint (or fallback for Purchase)
 *  10. Apply blueprint tag_rules — non-blocking
 *  11. Create dispatch_jobs for enabled integrations (meta_capi, ga4, google_ads)
 *  12. Mark raw_event as 'processed'
 *
 * BR-WEBHOOK-004: lead resolution hierarchy
 * BR-EVENT-002: idempotency via pre-insert lookup
 * BR-PRIVACY-001: PII never in logs
 * INV-EVENT-001: unique on (workspace_id, event_id)
 * INV-EVENT-003: replay protection
 * BR-IDENTITY-003: canonical lead_id after merge
 * BR-PRODUCT-001 / BR-PRODUCT-002: auto-product + lifecycle promotion
 */
export async function processOnprofitRawEvent(
  raw_event_id: string,
  db: Db,
  // T-CONTACTS-PII-001: optional master key for in-clear PII enrichment.
  // Mirrors processGuruRawEvent signature so the queue handler in index.ts
  // can forward `env.PII_MASTER_KEY_V1`. INV-PRIVACY-006-soft: missing key
  // never blocks the pipeline.
  masterKeyHex?: string,
): Promise<
  Result<
    {
      event_id: string;
      dispatch_jobs_created: number;
      dispatch_job_ids: Array<{
        id: string;
        destination: string;
        delay_seconds?: number;
      }>;
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

  // INV-EVENT-003: replay protection
  if (rawEvent.processingStatus === 'processed') {
    const payloadEventId = extractOnProfitEventIdFromPayload(rawEvent.payload);
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
  // Step 2: Validate payload
  // -------------------------------------------------------------------------
  const parseResult = OnProfitRawEventPayloadSchema.safeParse(rawEvent.payload);

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
        message: 'OnProfit payload validation failed',
        details: parseResult.error.issues,
      },
    };
  }

  const payload: OnProfitRawEventPayload = parseResult.data;

  // -------------------------------------------------------------------------
  // Step 3: Resolve lead identity
  //
  // Hierarchy (BR-WEBHOOK-004):
  //   a) custom_fields.lead_public_id → leads.id lookup (highest priority)
  //   b) customer.email
  //   c) customer.cell (already E.164 — preferred over .phone)
  //   d) customer.phone (display-formatted, fallback)
  //
  // BR-PRIVACY-001: email/phone never logged in clear.
  // BR-IDENTITY-003: canonical lead_id after potential merge.
  // -------------------------------------------------------------------------

  let resolvedLeadId: string | null = null;

  // T-CONTACTS-LASTSEEN-002: derive event time once and pass to resolver so
  // backfills/replays do not bump the lead's last_seen_at to NOW().
  const onprofitEventTimeForLead =
    parseOnProfitTime(payload.confirmation_purchase_date) ??
    parseOnProfitTime(payload.purchase_date) ??
    rawEvent.receivedAt ??
    new Date();

  // Priority a: lead_public_id from custom_fields.
  // ONPROFIT-W1-TYPES: `custom_fields` may be an empty array (default) or an
  // object with named keys — narrow before reading. Array form carries no
  // pptc by construction.
  const cf = payload.custom_fields;
  const pptc =
    cf && !Array.isArray(cf)
      ? ((cf as { lead_public_id?: string | null }).lead_public_id ?? null)
      : null;
  if (pptc) {
    resolvedLeadId = await resolveLeadByPptc(pptc, rawEvent.workspaceId, db);
    if (!resolvedLeadId) {
      safeLog('warn', {
        event: 'onprofit_pptc_not_found',
        raw_event_id,
        // pptc is a UUID (non-PII internal ID); safe to log per BR-PRIVACY-001.
        pptc,
      });
    }
  }

  // Priority b/c/d: email + phone via resolver
  if (!resolvedLeadId) {
    // Coerce null → undefined: resolveLeadByAliases types email/phone as
    // `string | undefined`, not `string | null`. Zod's .nullish() emits
    // `string | null | undefined`, so we normalize at the boundary.
    const email = payload.customer?.email ?? undefined;
    // Prefer cell (E.164) over phone (display-formatted).
    const phone =
      payload.customer?.cell ?? payload.customer?.phone ?? undefined;

    if (email || phone) {
      // BR-PRIVACY-001: do NOT log email/phone in clear — pass to resolver only.
      const resolveResult = await resolveLeadByAliases(
        { email, phone },
        rawEvent.workspaceId,
        db,
        { eventTime: onprofitEventTimeForLead },
      );

      if (resolveResult.ok) {
        // BR-IDENTITY-003: canonical lead_id (merge may have run).
        resolvedLeadId = resolveResult.value.lead_id;
      } else {
        // Non-fatal — persist event without lead link rather than dropping.
        safeLog('warn', {
          event: 'onprofit_lead_resolution_failed',
          raw_event_id,
          error_code: resolveResult.error.code,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: fn/ln hash refresh (BR-PRIVACY-002 — only hash persists).
  // OnProfit ships first + last name as separate fields, so we don't need
  // splitName. Still using it defensively in case lastname is empty and
  // name carries the full string.
  // -------------------------------------------------------------------------
  if (
    resolvedLeadId &&
    (payload.customer?.name || payload.customer?.lastname)
  ) {
    let firstName: string | null = null;
    let lastName: string | null = null;

    if (payload.customer?.name && payload.customer?.lastname) {
      firstName = payload.customer.name;
      lastName = payload.customer.lastname;
    } else if (payload.customer?.name) {
      // Only `name` present — try to split (handles operator misconfiguration)
      const split = splitName(payload.customer.name);
      firstName = split.first;
      lastName = split.last;
    } else if (payload.customer?.lastname) {
      lastName = payload.customer.lastname;
    }

    const fnHashVal = firstName ? await hashPiiExternal(firstName) : null;
    const lnHashVal = lastName ? await hashPiiExternal(lastName) : null;

    if (fnHashVal !== null || lnHashVal !== null) {
      await db
        .update(leads)
        .set({
          ...(fnHashVal ? { fnHash: fnHashVal } : {}),
          ...(lnHashVal ? { lnHash: lnHashVal } : {}),
        })
        .where(
          and(
            eq(leads.id, resolvedLeadId),
            eq(leads.workspaceId, rawEvent.workspaceId),
          ),
        );
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: enrich in-clear PII (email_enc / phone_enc / name_enc + leads.name)
  //
  // BR-PRIVACY-004: versioned encryption (pii_key_version=1).
  // BR-PRIVACY-001: helper logs no plaintext PII; we also log no PII here.
  // INV-PRIVACY-006-soft: enrichment failure must NOT block the pipeline.
  // ADR-034: leads.name plaintext populated for ILIKE search on Contatos UI.
  // -------------------------------------------------------------------------
  if (resolvedLeadId) {
    const customer = payload.customer;
    const email = customer?.email ?? undefined;
    const rawPhone = customer?.cell ?? customer?.phone ?? undefined;
    const phoneForEnc: string | undefined = rawPhone
      ? (normalizePhone(rawPhone) ?? rawPhone)
      : undefined;

    // Compose full name for `leads.name` plaintext.
    let nameForEnc: string | undefined;
    if (customer?.name && customer?.lastname) {
      nameForEnc = `${customer.name} ${customer.lastname}`.trim();
    } else if (customer?.name) {
      nameForEnc = customer.name;
    } else if (customer?.lastname) {
      nameForEnc = customer.lastname;
    }

    if (email || phoneForEnc || nameForEnc) {
      try {
        await enrichLeadPii(
          { email, phone: phoneForEnc, name: nameForEnc },
          {
            leadId: resolvedLeadId,
            workspaceId: rawEvent.workspaceId,
            db,
            masterKeyHex,
            requestId: raw_event_id,
          },
        );
      } catch (err) {
        // INV-PRIVACY-006-soft: never block the queue processor on enrichment.
        safeLog('warn', {
          event: 'onprofit_enrich_lead_pii_threw',
          raw_event_id,
          workspace_id: rawEvent.workspaceId,
          // BR-PRIVACY-001: no PII; only error message slice.
          message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: BR-PRODUCT-001 + BR-PRODUCT-002 — auto-create product + lifecycle.
  // Only on Purchase. Failure non-fatal (INV-PRIVACY-006-soft pattern).
  // -------------------------------------------------------------------------
  let productDbId: string | null = null;
  if (
    payload._onprofit_event_type === 'Purchase' &&
    resolvedLeadId &&
    payload.product?.id
  ) {
    try {
      const product = await upsertProduct(db, {
        workspaceId: rawEvent.workspaceId,
        externalProvider: 'onprofit',
        externalProductId: String(payload.product.id),
        name: payload.product.name ?? 'Produto sem nome',
      });
      productDbId = product.id;

      // BR-PRODUCT-001: monotonic promotion based on current product category
      const candidate = lifecycleForCategory(
        rawEvent.workspaceId,
        product.category,
      );
      await promoteLeadLifecycle(db, resolvedLeadId, candidate);
    } catch (err) {
      // BR-PRODUCT non-fatal: never block Purchase processing.
      safeLog('warn', {
        event: 'onprofit_product_lifecycle_promotion_failed',
        raw_event_id,
        // BR-PRIVACY-001: lead_id and product.id are internal IDs, not PII.
        lead_id: resolvedLeadId,
        product_id: String(payload.product?.id ?? ''),
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 7: Pre-insert idempotency lookup on (workspace_id, event_id)
  //
  // INV-EVENT-001 / BR-EVENT-002. The events table is PARTITIONED BY RANGE
  // (received_at), so the technical UNIQUE constraint includes received_at —
  // retries with different received_at values would slip through and create
  // duplicates. Pre-SELECT covers all retries deterministically.
  // -------------------------------------------------------------------------
  const eventTime =
    parseOnProfitTime(payload.confirmation_purchase_date) ??
    parseOnProfitTime(payload.purchase_date) ??
    new Date();

  const existingEvent = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, rawEvent.workspaceId),
        eq(events.eventId, payload._onprofit_event_id),
      ),
    )
    .limit(1);

  if (existingEvent[0]) {
    safeLog('info', {
      event: 'onprofit_webhook_duplicate_skipped',
      raw_event_id,
      workspace_id: rawEvent.workspaceId,
      event_id: payload._onprofit_event_id,
      existing_event_uuid: existingEvent[0].id,
    });
    await markRawEventProcessed(raw_event_id, db);
    return {
      ok: true,
      value: {
        event_id: payload._onprofit_event_id,
        dispatch_jobs_created: 0,
        dispatch_job_ids: [],
      },
    };
  }

  // -------------------------------------------------------------------------
  // Step 8: Insert events row.
  //
  // OnProfit `price` is in CENTAVOS — divide by 100 so events.custom_data.amount
  // matches Guru's unit-currency convention. DO NOT REMOVE: Meta CAPI / GA4
  // would receive 100x the value and inflate reported revenue 100x.
  //
  // user_data carries fbc/fbp from payload (the headline value of OnProfit
  // vs Guru) and geo_* from customer_address (better than IP geolocation for
  // Meta CAPI ct/st/zp/country hash).
  // -------------------------------------------------------------------------
  const amountUnit = payload.price / 100;

  // ONPROFIT-W3-PROCESSOR: derive transaction_group_id (unites main product +
  // order_bumps of the same OnProfit checkout). Persisted under custom_data so
  // Wave 4 dispatcher can aggregate value across grouped rows. Null when email
  // or offer_hash missing — pipeline still proceeds (1 dispatch per row).
  const transactionGroupId = await deriveTransactionGroupId({
    workspaceId: rawEvent.workspaceId,
    email: payload.customer?.email,
    offerHash: payload.offer_hash,
    occurredAt: eventTime,
  });

  let insertedEventId: string;

  try {
    const inserted = await db
      .insert(events)
      .values({
        workspaceId: rawEvent.workspaceId,
        // ONPROFIT-LAUNCH-RESOLVER (2026-05-09): launch_id é injetado pela
        // rota webhook via resolveLaunchForOnProfitEvent (mesmo padrão Guru).
        // Quando launch_id não é resolvido (productId não mapeado +
        // lead inédito), permanece undefined e lead_stages é skipado.
        launchId: payload.launch_id ?? undefined,
        leadId: resolvedLeadId ?? undefined,
        eventId: payload._onprofit_event_id,
        eventName: payload._onprofit_event_type, // "Purchase", "InitiateCheckout", …
        eventSource: 'webhook:onprofit',
        schemaVersion: 1,
        eventTime,
        receivedAt: rawEvent.receivedAt,
        attribution: jsonb({
          utm_source: payload.utm_source ?? null,
          utm_campaign: payload.utm_campaign ?? null,
          utm_medium: payload.utm_medium ?? null,
          utm_content: payload.utm_content ?? null,
          utm_term: payload.utm_term ?? null,
        }),
        userData: jsonb({
          // Meta cookies — copied from payload when present. THIS IS THE
          // PRIMARY VALUE-ADD vs Guru: Guru does not carry these, so OnProfit
          // orders attributed via Meta ads get dramatically better match
          // quality on the CAPI dispatch.
          ...(payload.fbc ? { fbc: payload.fbc } : {}),
          ...(payload.fbp ? { fbp: payload.fbp } : {}),
          // Geo from billing address — more accurate than IP-geo for Meta
          // CAPI ct/st/zp/country hash. Each dispatcher applies normalization.
          ...(payload.customer_address?.city
            ? { geo_city: payload.customer_address.city }
            : {}),
          ...(payload.customer_address?.state
            ? { geo_region_code: payload.customer_address.state }
            : {}),
          ...(payload.customer_address?.zip_code
            ? { geo_postal_code: payload.customer_address.zip_code }
            : {}),
          ...(payload.customer_address?.country
            ? { geo_country: payload.customer_address.country }
            : {}),
        }),
        customData: jsonb({
          // BR-EVENT-002: amount in currency UNIT (BRL), NOT centavos.
          // OnProfit native units are centavos — we divide by 100 above.
          amount: amountUnit,
          currency: payload.currency,
          payment_type: payload.payment_type ?? null,
          product_id: payload.product?.id ?? null,
          product_name: payload.product?.name ?? null,
          ...(productDbId ? { product_db_id: productDbId } : {}),
          // src/sck stored raw (no documented contract — preserved for future
          // analysis without fabricating semantics).
          src: payload.src ?? null,
          sck: payload.sck ?? null,
          // OnProfit native status preserved for downstream segmentation.
          onprofit_status: payload.status,
          // ONPROFIT-W3-PROCESSOR: discriminator between main product + order
          // bumps of the same checkout. UI (Wave 6) reads this to render the
          // grouped Purchase visual; dispatcher (Wave 4) reads it to decide
          // skip vs aggregate.
          item_type: payload.item_type ?? 'product',
          // ONPROFIT-W3-PROCESSOR: deterministic group id for aggregation;
          // null when email/offer_hash absent (degrades gracefully).
          ...(transactionGroupId !== null && {
            transaction_group_id: transactionGroupId,
          }),
        }),
        // Buyer who completed checkout → implicit consent granted.
        // INV-EVENT-006: consent_snapshot populated on every event.
        consentSnapshot: jsonb({
          analytics: 'granted',
          marketing: 'granted',
          ad_user_data: 'granted',
          ad_personalization: 'granted',
          customer_match: 'granted',
        }),
        requestContext: jsonb({}),
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

    // BR-EVENT-002: unique violation → idempotent success.
    if (isUniqueViolation(message)) {
      await markRawEventProcessed(raw_event_id, db);
      return {
        ok: true,
        value: {
          event_id: payload._onprofit_event_id,
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
  // Step 9 + 10: lead_stages + tag_rules (ONPROFIT-LAUNCH-RESOLVER, 2026-05-09).
  //
  // Mirror estrutural do equivalente em guru-raw-events-processor.ts.
  // payload.launch_id é injetado pela rota webhook via
  // resolveLaunchForOnProfitEvent. Quando ausente (productId não mapeado +
  // lead inédito), bloco é skipado — events.launchId fica null, mas o evento
  // ainda flui pra Meta CAPI / GA4 / Google Ads (fbc/fbp lift independente).
  // -------------------------------------------------------------------------
  if (resolvedLeadId && payload.launch_id) {
    let blueprint: FunnelBlueprint | null = null;
    try {
      blueprint = await getBlueprintForLaunch(payload.launch_id, db);
    } catch {
      blueprint = null;
    }

    const customDataForFilters: Record<string, unknown> = {
      funnel_role: payload.funnel_role ?? null,
    };

    if (blueprint !== null) {
      // Dynamic blueprint-driven stage resolution.
      for (const stage of blueprint.stages) {
        if (
          matchesStageFilters(
            payload._onprofit_event_type,
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
    } else if (payload._onprofit_event_type === 'Purchase') {
      // Fallback: hardcoded stage para launches sem blueprint.
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

    // T-LEADS-VIEW-002: aplicar tag_rules. BR-PRIVACY-001: nenhum PII.
    // Falha não bloqueia pipeline (mesmo padrão de promoteLeadLifecycle).
    try {
      await applyTagRules({
        db,
        workspaceId: rawEvent.workspaceId,
        leadId: resolvedLeadId,
        eventName: payload._onprofit_event_type,
        eventContext: {
          funnel_role: payload.funnel_role ?? undefined,
          // ONPROFIT-W3-PROCESSOR: expose item_type so the blueprint rule
          // `purchased_order_bump` (Wave 7) can match `when: { item_type:
          // 'order_bump' }`. Defaults to 'product' to align with the value
          // persisted in events.custom_data.
          item_type: payload.item_type ?? 'product',
        },
        tagRules: blueprint?.tag_rules,
      });
    } catch (tagErr) {
      safeLog('warn', {
        event: 'apply_tag_rules_failed',
        raw_event_id,
        workspace_id: rawEvent.workspaceId,
        error:
          tagErr instanceof Error
            ? tagErr.message.slice(0, 200)
            : String(tagErr),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 11: Create dispatch_jobs for enabled integrations.
  //
  // Mirrors guru-raw-events-processor.ts. OnProfit events are always
  // canonical (Purchase / InitiateCheckout / RefundProcessed / Chargeback)
  // — no internal-only filter needed.
  // -------------------------------------------------------------------------
  let dispatchJobsCreated = 0;
  const dispatchJobIds: Array<{
    id: string;
    destination: string;
    delay_seconds?: number;
  }> = [];

  // ONPROFIT-W3-PROCESSOR: order_bump rows are internal-only — they generate
  // event rows, lead_stages and tag_rules (handled above), but MUST NOT create
  // dispatch_jobs. The main product row (item_type='product') of the same
  // checkout fans out to Meta/GA4/Google Ads carrying the aggregated value
  // (Wave 4). Dropping a duplicate Purchase per OB avoids inflating reported
  // revenue Nx in Meta/GA4 dashboards.
  const isOrderBump = payload.item_type === 'order_bump';

  try {
    if (isOrderBump) {
      safeLog('info', {
        event: 'onprofit_dispatch_skipped_order_bump',
        raw_event_id,
        workspace_id: rawEvent.workspaceId,
        event_id: payload._onprofit_event_id,
        transaction_group_id: transactionGroupId,
        // BR-PRIVACY-001: product.id is an internal OnProfit numeric id, not PII.
        onprofit_product_id: String(payload.product?.id ?? ''),
      });
    } else {
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

    // ADR-030: only canonical events fan out to Google Ads.
    // OnProfit event types (Purchase, RefundProcessed, …) are all canonical.
    const ga = integrations?.google_ads;
    if (
      ga?.enabled === true &&
      ga.oauth_token_state === 'connected' &&
      typeof ga.customer_id === 'string' &&
      ga.customer_id.length > 0 &&
      ga.conversion_actions
    ) {
      const conversionActionId =
        ga.conversion_actions[payload._onprofit_event_type];
      if (
        typeof conversionActionId === 'string' &&
        conversionActionId.length > 0
      ) {
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
      // ONPROFIT-W4: produto principal espera 80s antes do dispatch externo —
      // dá tempo para que webhooks de order bumps cheguem e fiquem disponíveis
      // para agregação por transaction_group_id no dispatcher Meta CAPI.
      // BR-DISPATCH-007: consolida valor consolidado da transação OnProfit.
      const isMainProduct = payload.item_type === 'product' || !payload.item_type;
      const delaySeconds = isMainProduct ? 80 : undefined;
      for (const job of created) {
        dispatchJobIds.push({
          id: job.id,
          destination: job.destination,
          ...(delaySeconds !== undefined && { delay_seconds: delaySeconds }),
        });
      }
    }
    } // end of else (isOrderBump === false)
  } catch (dispatchErr) {
    safeLog('error', {
      event: 'onprofit_dispatch_jobs_creation_failed',
      raw_event_id,
      error:
        dispatchErr instanceof Error
          ? dispatchErr.message.slice(0, 200)
          : String(dispatchErr),
    });
  }

  // -------------------------------------------------------------------------
  // Step 12: Mark raw_event as processed.
  // -------------------------------------------------------------------------
  await markRawEventProcessed(raw_event_id, db);

  return {
    ok: true,
    value: {
      event_id: payload._onprofit_event_id,
      dispatch_jobs_created: dispatchJobsCreated,
      dispatch_job_ids: dispatchJobIds,
    },
  };
}
