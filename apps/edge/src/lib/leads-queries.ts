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
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { decryptPii } from './pii.js';
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
  status: 'active' | 'merged' | 'erased';
  first_seen_at: string;
  last_seen_at: string;
};

export type LeadListItem = {
  lead_public_id: string;
  display_name: string | null;
  status: 'active' | 'merged' | 'erased';
  first_seen_at: string;
  last_seen_at: string;
};

export type ListLeadsOpts = {
  workspaceId: string;
  q?: string; // UUID search
  launchPublicId?: string;
  cursor?: Date | null;
  limit: number;
};

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
  // getLeadSummary — decrypts name_enc for display
  // -------------------------------------------------------------------------
  async function getLeadSummary(
    publicId: string,
    workspaceId: string,
  ): Promise<LeadSummary | null> {
    const rows = await db
      .select({
        id: leads.id,
        status: leads.status,
        nameEnc: leads.nameEnc,
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

    let displayName: string | null = null;
    if (row.nameEnc) {
      const result = await decryptPii(
        row.nameEnc,
        workspaceId,
        masterKeyRegistry,
        row.piiKeyVersion,
      );
      if (result.ok) displayName = result.value;
    }

    return {
      lead_public_id: row.id,
      display_name: displayName,
      status: row.status as LeadSummary['status'],
      first_seen_at: row.firstSeenAt.toISOString(),
      last_seen_at: row.lastSeenAt.toISOString(),
    };
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
  // listLeads — paginated list with optional search and launch filter
  // -------------------------------------------------------------------------
  async function listLeads(opts: ListLeadsOpts): Promise<LeadListItem[]> {
    const { workspaceId, q, launchPublicId, cursor, limit } = opts;

    const conditions = [eq(leads.workspaceId, workspaceId)];

    // UUID search — exact match on leads.id
    if (q) {
      const uuidLike =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidLike.test(q)) {
        conditions.push(eq(leads.id, q));
      }
      // Email search not supported client-side without hashing — return empty for non-UUID q
    }

    if (cursor) conditions.push(lt(leads.lastSeenAt, cursor));

    let query = db
      .select({
        id: leads.id,
        status: leads.status,
        nameEnc: leads.nameEnc,
        piiKeyVersion: leads.piiKeyVersion,
        firstSeenAt: leads.firstSeenAt,
        lastSeenAt: leads.lastSeenAt,
      })
      .from(leads)
      .$dynamic();

    // Filter by launch via lead_attributions join
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

    // Decrypt names in parallel (best-effort — null on failure)
    const items = await Promise.all(
      rows.map(async (row) => {
        let displayName: string | null = null;
        if (row.nameEnc) {
          const result = await decryptPii(
            row.nameEnc,
            workspaceId,
            masterKeyRegistry,
            row.piiKeyVersion,
          );
          if (result.ok) displayName = result.value;
        }
        return {
          lead_public_id: row.id,
          display_name: displayName,
          status: row.status as LeadListItem['status'],
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
