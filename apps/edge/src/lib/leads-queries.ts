/**
 * leads-queries.ts — DB query implementations for the leads timeline route.
 *
 * BR-PRIVACY-001: no PII in logs.
 * BR-IDENTITY-013: lead_public_id = leads.id (UUID) — no separate public_id column.
 */

import {
  createDb,
  dispatchAttempts,
  dispatchJobs,
  events,
  launches,
  leadAttributions,
  leadConsents,
  leadMerges,
  leadStages,
  leadTags,
  leads,
  pages,
} from '@globaltracker/db';
import { and, asc, desc, eq, gt, ilike, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { decryptPii, hashPii } from './pii.js';
import { normalizeEmail, normalizePhone } from './lead-resolver.js';
import type { LifecycleStatus } from './lifecycle-rules.js';
import type {
  GetDispatchJobsFn,
  GetEventsFn,
  GetLeadAttributionsFn,
  GetLeadByPublicIdFn,
  GetLeadConsentsFn,
  GetLeadMergesFn,
  GetLeadStagesFn,
  GetLeadTagsFn,
  LeadLookupResult,
} from '../routes/leads-timeline.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LeadSummary = {
  lead_public_id: string;
  display_name: string | null;
  display_email: string | null;
  display_phone: string | null;
  status: 'active' | 'merged' | 'erased';
  lifecycle_status: LifecycleStatus;
  first_seen_at: string;
  last_seen_at: string;
};

export type LeadListItem = {
  lead_public_id: string;
  display_name: string | null;
  display_email: string | null;
  display_phone: string | null;
  status: 'active' | 'merged' | 'erased';
  lifecycle_status: LifecycleStatus;
  first_seen_at: string;
  last_seen_at: string;
};

export type SortField = 'last_seen_at' | 'first_seen_at' | 'name' | 'lifecycle_status';
export type SortDir = 'asc' | 'desc';

export type ListLeadsOpts = {
  workspaceId: string;
  q?: string; // UUID / email / phone / name substring
  launchPublicId?: string;
  lifecycle?: LifecycleStatus;
  cursor?: Date | null;
  limit: number;
  sortBy?: SortField;
  sortDir?: SortDir;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+\d][\d\s\-()]+$/;

// ---------------------------------------------------------------------------
// Factory — builds all query fns bound to a single DB connection string
// ---------------------------------------------------------------------------

export function createLeadsQueryFns(
  connectionString: string,
  masterKeyRegistry: Record<number, string>,
) {
  const db = createDb(connectionString);

  // -------------------------------------------------------------------------
  // getLeadByPublicId
  // BR-IDENTITY-013: lead_public_id = leads.id
  // -------------------------------------------------------------------------
  const getLeadByPublicId: GetLeadByPublicIdFn = async (
    publicId,
    workspaceId,
  ): Promise<LeadLookupResult> => {
    const rows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          eq(leads.workspaceId, workspaceId),
          eq(leads.id, publicId),
        ),
      )
      .limit(1);

    if (!rows[0]) return { found: false };
    return { found: true, leadId: rows[0].id };
  };

  // -------------------------------------------------------------------------
  // getLeadSummary — returns plaintext name (ADR-034) + decrypted email/phone
  // -------------------------------------------------------------------------
  async function getLeadSummary(
    publicId: string,
    workspaceId: string,
  ): Promise<LeadSummary | null> {
    const rows = await db
      .select({
        id: leads.id,
        status: leads.status,
        lifecycleStatus: leads.lifecycleStatus,
        name: leads.name,
        nameEnc: leads.nameEnc,
        emailEnc: leads.emailEnc,
        phoneEnc: leads.phoneEnc,
        piiKeyVersion: leads.piiKeyVersion,
        firstSeenAt: leads.firstSeenAt,
        lastSeenAt: leads.lastSeenAt,
      })
      .from(leads)
      .where(
        and(eq(leads.workspaceId, workspaceId), eq(leads.id, publicId)),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    // ADR-034: prefer plaintext leads.name. Fall back to decrypt name_enc for
    // legacy rows not yet backfilled.
    let displayName: string | null = row.name;
    if (!displayName && row.nameEnc) {
      const result = await decryptPii(
        row.nameEnc,
        workspaceId,
        masterKeyRegistry,
        row.piiKeyVersion,
      );
      if (result.ok) displayName = result.value;
    }

    const [displayEmail, displayPhone] = await Promise.all([
      decryptOrNull(row.emailEnc, workspaceId, row.piiKeyVersion),
      decryptOrNull(row.phoneEnc, workspaceId, row.piiKeyVersion),
    ]);

    return {
      lead_public_id: row.id,
      display_name: displayName,
      display_email: displayEmail,
      display_phone: displayPhone,
      status: row.status as LeadSummary['status'],
      lifecycle_status: row.lifecycleStatus as LifecycleStatus,
      first_seen_at: row.firstSeenAt.toISOString(),
      last_seen_at: row.lastSeenAt.toISOString(),
    };
  }

  async function decryptOrNull(
    ciphertext: string | null,
    workspaceId: string,
    keyVersion: number,
  ): Promise<string | null> {
    if (!ciphertext) return null;
    const r = await decryptPii(
      ciphertext,
      workspaceId,
      masterKeyRegistry,
      keyVersion,
    );
    return r.ok ? r.value : null;
  }

  // -------------------------------------------------------------------------
  // getEvents
  // -------------------------------------------------------------------------
  // T-17-001: enriched event rows — join pages.public_id (page_name surrogate;
  // pages.title does not exist in current schema) and launches.name; expose
  // event_source, processing_status, custom_data.
  const getEvents: GetEventsFn = async ({ leadId, workspaceId, cursor, limit }) => {
    const conditions = [
      eq(events.workspaceId, workspaceId),
      eq(events.leadId, leadId),
    ];
    if (cursor) conditions.push(lt(events.eventTime, cursor));

    return db
      .select({
        id: events.id,
        eventName: events.eventName,
        eventTime: events.eventTime,
        receivedAt: events.receivedAt,
        pageId: events.pageId,
        attribution: events.attribution,
        eventSource: events.eventSource,
        customData: events.customData,
        processingStatus: events.processingStatus,
        pageName: pages.publicId,
        launchName: launches.name,
      })
      .from(events)
      .leftJoin(pages, eq(pages.id, events.pageId))
      .leftJoin(launches, eq(launches.id, events.launchId))
      .where(and(...conditions))
      .orderBy(desc(events.eventTime))
      .limit(limit);
  };

  // -------------------------------------------------------------------------
  // getDispatchJobs
  // -------------------------------------------------------------------------
  // T-17-002: enriched dispatch rows — destination_resource_id, attempt_count,
  // replayed_from_dispatch_job_id read directly from dispatch_jobs (already
  // tracked there). request_payload_sanitized + response_status/error_code come
  // from the latest dispatch_attempt via correlated subquery.
  const getDispatchJobs: GetDispatchJobsFn = async ({
    leadId,
    workspaceId,
    cursor,
    limit,
  }) => {
    const conditions = [
      eq(dispatchJobs.workspaceId, workspaceId),
      eq(dispatchJobs.leadId, leadId),
    ];
    if (cursor) conditions.push(lt(dispatchJobs.createdAt, cursor));

    // Correlated subqueries to fetch latest attempt fields (avoids GROUP BY +
    // window-function gymnastics; latest = max attempt_number per job).
    const latestAttempt = sql<string>`(
      SELECT da.id FROM dispatch_attempts da
      WHERE da.dispatch_job_id = ${dispatchJobs.id}
      ORDER BY da.attempt_number DESC
      LIMIT 1
    )`;

    const rows = await db
      .select({
        id: dispatchJobs.id,
        eventId: dispatchJobs.eventId,
        destination: dispatchJobs.destination,
        status: dispatchJobs.status,
        skipReason: dispatchJobs.skipReason,
        idempotencyKey: dispatchJobs.idempotencyKey,
        nextAttemptAt: dispatchJobs.nextAttemptAt,
        createdAt: dispatchJobs.createdAt,
        destinationResourceId: dispatchJobs.destinationResourceId,
        attemptCount: dispatchJobs.attemptCount,
        replayedFromDispatchJobId: dispatchJobs.replayedFromDispatchJobId,
        responseStatus: sql<number | null>`(
          SELECT da.response_status FROM dispatch_attempts da
          WHERE da.id = ${latestAttempt}
        )`,
        errorCode: sql<string | null>`(
          SELECT da.error_code FROM dispatch_attempts da
          WHERE da.id = ${latestAttempt}
        )`,
        // BR-PRIVACY-001: payload is already sanitized at write time
        // (dispatch_attempts.request_payload_sanitized column).
        requestPayloadSanitized: sql<unknown>`(
          SELECT da.request_payload_sanitized FROM dispatch_attempts da
          WHERE da.id = ${latestAttempt}
        )`,
      })
      .from(dispatchJobs)
      .where(and(...conditions))
      .orderBy(desc(dispatchJobs.createdAt))
      .limit(limit);

    return rows;
  };

  // -------------------------------------------------------------------------
  // getLeadAttributions
  // -------------------------------------------------------------------------
  // T-17-003: enriched attribution rows.
  const getLeadAttributions: GetLeadAttributionsFn = async ({
    leadId,
    workspaceId,
  }) => {
    return db
      .select({
        id: leadAttributions.id,
        touchType: leadAttributions.touchType,
        source: leadAttributions.source,
        medium: leadAttributions.medium,
        campaign: leadAttributions.campaign,
        createdAt: leadAttributions.createdAt,
        content: leadAttributions.content,
        term: leadAttributions.term,
        fbclid: leadAttributions.fbclid,
        gclid: leadAttributions.gclid,
        adId: leadAttributions.adId,
        campaignId: leadAttributions.campaignId,
        linkId: leadAttributions.linkId,
      })
      .from(leadAttributions)
      .where(
        and(
          eq(leadAttributions.workspaceId, workspaceId),
          eq(leadAttributions.leadId, leadId),
        ),
      )
      .orderBy(desc(leadAttributions.createdAt));
  };

  // -------------------------------------------------------------------------
  // getLeadStages
  // -------------------------------------------------------------------------
  // T-17-003: enriched stage rows. from_stage is computed via LAG window
  // function ordered chronologically. funnel_role is intentionally omitted —
  // column does not exist on lead_stages (schema gap; see T-17-003 notes).
  const getLeadStages: GetLeadStagesFn = async ({ leadId, workspaceId }) => {
    return db
      .select({
        id: leadStages.id,
        stage: leadStages.stage,
        ts: leadStages.ts,
        sourceEventId: leadStages.sourceEventId,
        launchId: leadStages.launchId,
        isRecurring: leadStages.isRecurring,
        fromStage: sql<string | null>`LAG(${leadStages.stage}) OVER (
          PARTITION BY ${leadStages.workspaceId}, ${leadStages.leadId}, ${leadStages.launchId}
          ORDER BY ${leadStages.ts} ASC
        )`,
      })
      .from(leadStages)
      .where(
        and(
          eq(leadStages.workspaceId, workspaceId),
          eq(leadStages.leadId, leadId),
        ),
      )
      .orderBy(desc(leadStages.ts));
  };

  // T-17-004: tag_added rows from lead_tags (workspace+lead scoped).
  const getLeadTags: GetLeadTagsFn = async ({ leadId, workspaceId }) => {
    return db
      .select({
        id: leadTags.id,
        tagName: leadTags.tagName,
        setAt: leadTags.setAt,
        setBy: leadTags.setBy,
      })
      .from(leadTags)
      .where(
        and(
          eq(leadTags.workspaceId, workspaceId),
          eq(leadTags.leadId, leadId),
        ),
      )
      .orderBy(desc(leadTags.setAt));
  };

  // T-17-004: consent_updated rows. Computes the previous-row snapshot via
  // LAG() so the route can derive purposes_diff without an extra round-trip.
  const getLeadConsents: GetLeadConsentsFn = async ({ leadId, workspaceId }) => {
    const rows = await db
      .select({
        id: leadConsents.id,
        ts: leadConsents.ts,
        source: leadConsents.source,
        policyVersion: leadConsents.policyVersion,
        consentAnalytics: leadConsents.consentAnalytics,
        consentMarketing: leadConsents.consentMarketing,
        consentAdUserData: leadConsents.consentAdUserData,
        consentAdPersonalization: leadConsents.consentAdPersonalization,
        consentCustomerMatch: leadConsents.consentCustomerMatch,
        prevAnalytics: sql<string | null>`LAG(${leadConsents.consentAnalytics}) OVER (
          PARTITION BY ${leadConsents.workspaceId}, ${leadConsents.leadId}
          ORDER BY ${leadConsents.ts} ASC
        )`,
        prevMarketing: sql<string | null>`LAG(${leadConsents.consentMarketing}) OVER (
          PARTITION BY ${leadConsents.workspaceId}, ${leadConsents.leadId}
          ORDER BY ${leadConsents.ts} ASC
        )`,
        prevAdUserData: sql<string | null>`LAG(${leadConsents.consentAdUserData}) OVER (
          PARTITION BY ${leadConsents.workspaceId}, ${leadConsents.leadId}
          ORDER BY ${leadConsents.ts} ASC
        )`,
        prevAdPersonalization: sql<string | null>`LAG(${leadConsents.consentAdPersonalization}) OVER (
          PARTITION BY ${leadConsents.workspaceId}, ${leadConsents.leadId}
          ORDER BY ${leadConsents.ts} ASC
        )`,
        prevCustomerMatch: sql<string | null>`LAG(${leadConsents.consentCustomerMatch}) OVER (
          PARTITION BY ${leadConsents.workspaceId}, ${leadConsents.leadId}
          ORDER BY ${leadConsents.ts} ASC
        )`,
      })
      .from(leadConsents)
      .where(
        and(
          eq(leadConsents.workspaceId, workspaceId),
          eq(leadConsents.leadId, leadId),
        ),
      )
      .orderBy(desc(leadConsents.ts));

    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      source: r.source,
      policyVersion: r.policyVersion,
      consentAnalytics: r.consentAnalytics,
      consentMarketing: r.consentMarketing,
      consentAdUserData: r.consentAdUserData,
      consentAdPersonalization: r.consentAdPersonalization,
      consentCustomerMatch: r.consentCustomerMatch,
      prev:
        r.prevAnalytics === null &&
        r.prevMarketing === null &&
        r.prevAdUserData === null &&
        r.prevAdPersonalization === null &&
        r.prevCustomerMatch === null
          ? null
          : {
              consentAnalytics: r.prevAnalytics ?? 'unknown',
              consentMarketing: r.prevMarketing ?? 'unknown',
              consentAdUserData: r.prevAdUserData ?? 'unknown',
              consentAdPersonalization: r.prevAdPersonalization ?? 'unknown',
              consentCustomerMatch: r.prevCustomerMatch ?? 'unknown',
            },
    }));
  };

  // T-17-004: merge rows. Returns events where the lead was either the
  // canonical (primary) or merged side. BR-IDENTITY-013: surface lead_public_id
  // (= leads.id), never internal lead_id field naming on the wire.
  const canonicalLeads = alias(leads, 'canonical_leads_for_merge');
  const mergedLeads = alias(leads, 'merged_leads_for_merge');
  const getLeadMerges: GetLeadMergesFn = async ({ leadId, workspaceId }) => {
    const rows = await db
      .select({
        id: leadMerges.id,
        mergedAt: leadMerges.mergedAt,
        reason: leadMerges.reason,
        performedBy: leadMerges.performedBy,
        beforeSummary: leadMerges.beforeSummary,
        afterSummary: leadMerges.afterSummary,
        primaryLeadPublicId: canonicalLeads.id,
        mergedLeadPublicId: mergedLeads.id,
      })
      .from(leadMerges)
      .innerJoin(
        canonicalLeads,
        eq(canonicalLeads.id, leadMerges.canonicalLeadId),
      )
      .innerJoin(mergedLeads, eq(mergedLeads.id, leadMerges.mergedLeadId))
      .where(
        and(
          eq(leadMerges.workspaceId, workspaceId),
          // Show merge events on either side's timeline.
          or(
            eq(leadMerges.canonicalLeadId, leadId),
            eq(leadMerges.mergedLeadId, leadId),
          )!,
        ),
      )
      .orderBy(desc(leadMerges.mergedAt));

    return rows;
  };

  // -------------------------------------------------------------------------
  // listLeads — paginated list with multi-field search (UUID/email/phone/name)
  //
  // Search detection (in order):
  //   1. UUID format → exact match on leads.id
  //   2. Email format → hashPii(workspace, normalizedEmail) → match email_hash
  //   3. Phone format → normalizePhone + hashPii → match phone_hash
  //   4. Else → ILIKE %q% on lower(leads.name) (indexed)
  // -------------------------------------------------------------------------
  async function listLeads(opts: ListLeadsOpts): Promise<LeadListItem[]> {
    const { workspaceId, q, launchPublicId, lifecycle, cursor, limit } = opts;
    const sortBy = opts.sortBy ?? 'last_seen_at';
    const sortDir = opts.sortDir ?? 'desc';

    const conditions = [eq(leads.workspaceId, workspaceId)];

    if (lifecycle) {
      conditions.push(eq(leads.lifecycleStatus, lifecycle));
    }

    if (q) {
      if (UUID_RE.test(q)) {
        conditions.push(eq(leads.id, q));
      } else if (EMAIL_RE.test(q)) {
        const normalized = normalizeEmail(q);
        const hash = await hashPii(normalized, workspaceId);
        conditions.push(eq(leads.emailHash, hash));
      } else if (PHONE_RE.test(q)) {
        const normalized = normalizePhone(q);
        if (!normalized) return [];
        const hash = await hashPii(normalized, workspaceId);
        conditions.push(eq(leads.phoneHash, hash));
      } else {
        // Name substring search — uses idx_leads_name_lower (lower(name) text_pattern_ops).
        // For text_pattern_ops, the leading % defeats the index. With dataset size we
        // currently see (sub-thousand leads/workspace) the seq scan is fine; revisit
        // with pg_trgm if it becomes a hotspot.
        conditions.push(ilike(leads.name, `%${q}%`));
      }
    }

    // Cursor applies only to date-based sorts (stable keyset pagination).
    if (cursor && (sortBy === 'last_seen_at' || sortBy === 'first_seen_at')) {
      const col = sortBy === 'first_seen_at' ? leads.firstSeenAt : leads.lastSeenAt;
      conditions.push(sortDir === 'desc' ? lt(col, cursor) : gt(col, cursor));
    }

    let query = db
      .select({
        id: leads.id,
        status: leads.status,
        lifecycleStatus: leads.lifecycleStatus,
        name: leads.name,
        nameEnc: leads.nameEnc,
        emailEnc: leads.emailEnc,
        phoneEnc: leads.phoneEnc,
        piiKeyVersion: leads.piiKeyVersion,
        firstSeenAt: leads.firstSeenAt,
        lastSeenAt: leads.lastSeenAt,
      })
      .from(leads)
      .$dynamic();

    if (launchPublicId) {
      query = query
        .innerJoin(
          leadAttributions,
          and(
            eq(leadAttributions.leadId, leads.id),
            eq(leadAttributions.workspaceId, workspaceId),
          ),
        )
        .innerJoin(
          launches,
          and(
            eq(launches.id, leadAttributions.launchId),
            eq(launches.publicId, launchPublicId),
            eq(launches.workspaceId, workspaceId),
          ),
        );
    }

    const sortColMap = {
      last_seen_at: leads.lastSeenAt,
      first_seen_at: leads.firstSeenAt,
      name: leads.name,
      lifecycle_status: leads.lifecycleStatus,
    } as const;
    const sortCol = sortColMap[sortBy];
    const orderExpr = sortDir === 'asc' ? asc(sortCol) : desc(sortCol);

    const rows = await query
      .where(and(...conditions))
      .orderBy(orderExpr, asc(leads.id))
      .limit(limit);

    const items = await Promise.all(
      rows.map(async (row) => {
        // ADR-034: prefer plaintext leads.name; fall back to decrypt for legacy rows.
        let displayName: string | null = row.name;
        if (!displayName && row.nameEnc) {
          const r = await decryptPii(
            row.nameEnc,
            workspaceId,
            masterKeyRegistry,
            row.piiKeyVersion,
          );
          if (r.ok) displayName = r.value;
        }

        const [displayEmail, displayPhone] = await Promise.all([
          decryptOrNull(row.emailEnc, workspaceId, row.piiKeyVersion),
          decryptOrNull(row.phoneEnc, workspaceId, row.piiKeyVersion),
        ]);

        return {
          lead_public_id: row.id,
          display_name: displayName,
          display_email: displayEmail,
          display_phone: displayPhone,
          status: row.status as LeadListItem['status'],
          lifecycle_status: row.lifecycleStatus as LifecycleStatus,
          first_seen_at: row.firstSeenAt.toISOString(),
          last_seen_at: row.lastSeenAt.toISOString(),
        };
      }),
    );

    return items;
  }

  return {
    getLeadByPublicId,
    getLeadSummary,
    getEvents,
    getDispatchJobs,
    getLeadAttributions,
    getLeadStages,
    getLeadTags,
    getLeadConsents,
    getLeadMerges,
    listLeads,
  };
}
