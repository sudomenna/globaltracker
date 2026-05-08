/**
 * leads-queries.ts — DB query implementations for the leads timeline route.
 *
 * BR-PRIVACY-001: no PII in logs.
 * BR-IDENTITY-013: lead_public_id = leads.id (UUID) — no separate public_id column.
 */

import {
  createDb,
  dispatchJobs,
  events,
  launches,
  leadAttributions,
  leads,
  leadStages,
} from '@globaltracker/db';
import { and, desc, eq, ilike, lt, or, sql } from 'drizzle-orm';
import { decryptPii, hashPii } from './pii.js';
import { normalizeEmail, normalizePhone } from './lead-resolver.js';
import type { LifecycleStatus } from './lifecycle-rules.js';
import type {
  GetDispatchJobsFn,
  GetEventsFn,
  GetLeadAttributionsFn,
  GetLeadByPublicIdFn,
  GetLeadStagesFn,
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

export type ListLeadsOpts = {
  workspaceId: string;
  q?: string; // UUID / email / phone / name substring
  launchPublicId?: string;
  lifecycle?: LifecycleStatus;
  cursor?: Date | null;
  limit: number;
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
      })
      .from(events)
      .where(and(...conditions))
      .orderBy(desc(events.eventTime))
      .limit(limit);
  };

  // -------------------------------------------------------------------------
  // getDispatchJobs
  // -------------------------------------------------------------------------
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

    const rows = await db
      .select({
        id: dispatchJobs.id,
        destination: dispatchJobs.destination,
        status: dispatchJobs.status,
        skipReason: dispatchJobs.skipReason,
        idempotencyKey: dispatchJobs.idempotencyKey,
        nextAttemptAt: dispatchJobs.nextAttemptAt,
        createdAt: dispatchJobs.createdAt,
        responseStatus: sql<number | null>`null`,
        errorCode: sql<string | null>`null`,
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
  const getLeadStages: GetLeadStagesFn = async ({ leadId, workspaceId }) => {
    return db
      .select({
        id: leadStages.id,
        stage: leadStages.stage,
        ts: leadStages.ts,
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

    if (cursor) conditions.push(lt(leads.lastSeenAt, cursor));

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

    const rows = await query
      .where(and(...conditions))
      .orderBy(desc(leads.lastSeenAt))
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
    listLeads,
  };
}
