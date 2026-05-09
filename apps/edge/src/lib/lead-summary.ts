/**
 * lead-summary.ts — aggregated, PII-free state of a single lead.
 *
 * Contract: T-17-006 (Sprint 17 — Lead Detail Observability).
 *
 * What this module does:
 *   - Reads stages, tags, attributions, consent and metrics for one lead.
 *   - Aggregates them into a single non-PII snapshot suitable for the
 *     /v1/leads/:public_id/summary endpoint.
 *
 * What this module does NOT do:
 *   - Decrypts or returns email/phone/name/hashes (BR-PRIVACY-001).
 *   - Honors RBAC role gating beyond what the route enforces — every field
 *     here is safe to return to any authenticated workspace member because
 *     UTMs, stages, tags, consent flags and aggregate counts are non-PII.
 *
 * BR-IDENTITY-013: lead_public_id = leads.id (UUID). Never leaks an internal
 *   numeric/internal identifier.
 * BR-PRIVACY-001: zero PII in payload and zero PII in any safeLog call.
 */

import {
  dispatchJobs,
  events,
  leadAttributions,
  leadConsents,
  leadStages,
  leadTags,
  leads,
  type Db,
} from '@globaltracker/db';
import { and, desc, eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LeadSummaryUtm = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
};

export type LeadSummary = {
  current_stage: { stage: string; since: string } | null;
  stages_journey: Array<{ stage: string; at: string }>;
  tags: Array<{ tag_name: string; set_by: string; set_at: string }>;
  attribution_summary: {
    first_touch: LeadSummaryUtm | null;
    last_touch: LeadSummaryUtm | null;
    fbclid: string | null;
    gclid: string | null;
  };
  consent_current: {
    analytics: boolean;
    marketing: boolean;
    ad_user_data: boolean;
    ad_personalization: boolean;
    customer_match: boolean;
    updated_at: string;
  } | null;
  metrics: {
    events_total: number;
    dispatches_ok: number;
    dispatches_failed: number;
    dispatches_skipped: number;
    purchase_total_brl: number;
    last_activity_at: string | null;
  };
};

export type BuildLeadSummaryOpts = {
  db: Db;
  leadId: string;
  workspaceId: string;
};

export type BuildLeadSummaryError =
  | { code: 'lead_not_found' }
  | { code: 'db_error'; cause: string };

export type BuildLeadSummaryResult =
  | { ok: true; value: LeadSummary }
  | { ok: false; error: BuildLeadSummaryError };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** lead_consents columns store 'granted' | 'denied' | 'unknown'. */
function isGranted(v: string | null | undefined): boolean {
  return v === 'granted';
}

/** Build a UTM-only object dropping null/empty fields. */
function pickUtm(row: {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  term: string | null;
}): LeadSummaryUtm {
  const out: LeadSummaryUtm = {};
  if (row.source) out.utm_source = row.source;
  if (row.medium) out.utm_medium = row.medium;
  if (row.campaign) out.utm_campaign = row.campaign;
  if (row.content) out.utm_content = row.content;
  if (row.term) out.utm_term = row.term;
  return out;
}

// ---------------------------------------------------------------------------
// buildLeadSummary
// ---------------------------------------------------------------------------

/**
 * Builds the aggregated summary for a single lead.
 *
 * BR-PRIVACY-001: never returns PII (email/phone/name/hashes).
 * BR-IDENTITY-013: caller is expected to have already resolved publicId → leadId
 *   (see route handler). leadId here is the internal UUID; it is consumed only
 *   for DB filtering and never echoed back to clients.
 */
export async function buildLeadSummary(
  opts: BuildLeadSummaryOpts,
): Promise<BuildLeadSummaryResult> {
  const { db, leadId, workspaceId } = opts;

  // 1) Confirm the lead exists in the caller's workspace. We do this before
  //    fanning out the parallel queries so a 404 short-circuits cleanly.
  //    BR-RBAC-002: workspace_id from auth context is the multi-tenant anchor.
  const leadRows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.workspaceId, workspaceId)))
    .limit(1);

  if (!leadRows[0]) {
    return { ok: false, error: { code: 'lead_not_found' } };
  }

  // 2) Fan out queries in parallel — none of them depend on each other.
  //    Each query is workspace-scoped to honor BR-RBAC-002 even if RLS were
  //    accidentally bypassed.
  try {
    const [
      stageRows,
      tagRows,
      attributionRows,
      consentRows,
      dispatchAggRows,
      metricsRows,
    ] = await Promise.all([
      // 2.a stages — chronological ASC for stages_journey
      db
        .select({ stage: leadStages.stage, ts: leadStages.ts })
        .from(leadStages)
        .where(
          and(
            eq(leadStages.workspaceId, workspaceId),
            eq(leadStages.leadId, leadId),
          ),
        )
        .orderBy(leadStages.ts),

      // 2.b tags — snapshot atemporal (no DELETE by design — INV-LEAD-TAG-001)
      db
        .select({
          tagName: leadTags.tagName,
          setBy: leadTags.setBy,
          setAt: leadTags.setAt,
        })
        .from(leadTags)
        .where(
          and(
            eq(leadTags.workspaceId, workspaceId),
            eq(leadTags.leadId, leadId),
          ),
        )
        .orderBy(desc(leadTags.setAt)),

      // 2.c attributions — full set; we pick first / last in JS below.
      db
        .select({
          touchType: leadAttributions.touchType,
          source: leadAttributions.source,
          medium: leadAttributions.medium,
          campaign: leadAttributions.campaign,
          content: leadAttributions.content,
          term: leadAttributions.term,
          fbclid: leadAttributions.fbclid,
          gclid: leadAttributions.gclid,
          ts: leadAttributions.ts,
        })
        .from(leadAttributions)
        .where(
          and(
            eq(leadAttributions.workspaceId, workspaceId),
            eq(leadAttributions.leadId, leadId),
          ),
        )
        .orderBy(leadAttributions.ts),

      // 2.d consents — most recent row only.
      db
        .select({
          consentAnalytics: leadConsents.consentAnalytics,
          consentMarketing: leadConsents.consentMarketing,
          consentAdUserData: leadConsents.consentAdUserData,
          consentAdPersonalization: leadConsents.consentAdPersonalization,
          consentCustomerMatch: leadConsents.consentCustomerMatch,
          ts: leadConsents.ts,
        })
        .from(leadConsents)
        .where(
          and(
            eq(leadConsents.workspaceId, workspaceId),
            eq(leadConsents.leadId, leadId),
          ),
        )
        .orderBy(desc(leadConsents.ts))
        .limit(1),

      // 2.e dispatch_jobs aggregate — count by status bucket.
      //   BR-DISPATCH-004: 'skipped' is its own bucket; 'failed' + 'dead_letter'
      //   collapse into the failed bucket; 'succeeded' = ok bucket.
      db
        .select({
          status: dispatchJobs.status,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(dispatchJobs)
        .where(
          and(
            eq(dispatchJobs.workspaceId, workspaceId),
            eq(dispatchJobs.leadId, leadId),
          ),
        )
        .groupBy(dispatchJobs.status),

      // 2.f event metrics — total count, last activity, sum of Purchase.value.
      //   Defensive cast: events.custom_data is jsonb but legacy paths landed
      //   it as a JSON-encoded string inside the jsonb column. The CASE handles
      //   both shapes so the sum does not blow up on a single bad row.
      //   The numeric cast inside COALESCE swallows malformed numbers (NULL on
      //   conversion) so one weird value does not poison the whole aggregate.
      db
        .select({
          eventsTotal: sql<number>`COUNT(*)::int`,
          lastActivityAt: sql<string | null>`MAX(${events.receivedAt})`,
          // Defensive read for events.custom_data: canonical shape is jsonb-object;
          // legacy paths landed it as a JSON-encoded string inside the jsonb column
          // (see MEMORY §6 invariants). When the column holds a jsonb-string we
          // re-parse it via (#>> '{}')::jsonb. Malformed values become NULL via
          // NULLIF and are silently dropped from the SUM (one bad row does not
          // poison the aggregate).
          purchaseTotalBrl: sql<string | null>`
            COALESCE(SUM(
              CASE
                WHEN ${events.eventName} = 'Purchase' THEN (
                  SELECT NULLIF(v, '')::numeric
                  FROM (
                    SELECT
                      CASE
                        WHEN jsonb_typeof(cd) = 'object' THEN
                          COALESCE(cd ->> 'value', cd ->> 'amount', NULL)
                        WHEN jsonb_typeof(cd) = 'string' THEN
                          COALESCE(
                            (cd #>> '{}')::jsonb ->> 'value',
                            (cd #>> '{}')::jsonb ->> 'amount',
                            NULL
                          )
                        ELSE NULL
                      END AS v
                    FROM (SELECT ${events.customData} AS cd) sub
                  ) vals
                )
                ELSE NULL
              END
            ), 0)::text
          `,
        })
        .from(events)
        .where(
          and(
            eq(events.workspaceId, workspaceId),
            eq(events.leadId, leadId),
          ),
        ),
    ]);

    // 3) Shape stages.
    const stages_journey = stageRows.map((r) => ({
      stage: r.stage,
      at: r.ts.toISOString(),
    }));
    const lastStageRow = stageRows[stageRows.length - 1];
    const current_stage = lastStageRow
      ? { stage: lastStageRow.stage, since: lastStageRow.ts.toISOString() }
      : null;

    // 4) Shape tags.
    const tags = tagRows.map((r) => ({
      tag_name: r.tagName,
      set_by: r.setBy,
      set_at: r.setAt.toISOString(),
    }));

    // 5) Shape attribution_summary.
    //    first_touch: prefer touchType='first' row; fallback to oldest row.
    //    last_touch:  prefer touchType='last'  row; fallback to newest row.
    //    BR-ATTRIBUTION-001/002: 'first' / 'last' are unique per launch but a
    //    lead may participate in multiple launches — we collapse to the lead
    //    level by picking the oldest 'first' and newest 'last'.
    const firstTouchRow =
      attributionRows.find((r) => r.touchType === 'first') ??
      attributionRows[0] ??
      null;
    const lastTouchRow =
      [...attributionRows].reverse().find((r) => r.touchType === 'last') ??
      attributionRows[attributionRows.length - 1] ??
      null;

    const first_touch = firstTouchRow ? pickUtm(firstTouchRow) : null;
    const last_touch = lastTouchRow ? pickUtm(lastTouchRow) : null;

    // Click ids: prefer last_touch (most recent meaningful signal), fallback to first.
    const fbclid =
      (lastTouchRow?.fbclid ?? null) || (firstTouchRow?.fbclid ?? null);
    const gclid =
      (lastTouchRow?.gclid ?? null) || (firstTouchRow?.gclid ?? null);

    // 6) Shape consent_current.
    const consentRow = consentRows[0];
    const consent_current = consentRow
      ? {
          analytics: isGranted(consentRow.consentAnalytics),
          marketing: isGranted(consentRow.consentMarketing),
          ad_user_data: isGranted(consentRow.consentAdUserData),
          ad_personalization: isGranted(consentRow.consentAdPersonalization),
          customer_match: isGranted(consentRow.consentCustomerMatch),
          updated_at: consentRow.ts.toISOString(),
        }
      : null;

    // 7) Shape metrics.
    let dispatches_ok = 0;
    let dispatches_failed = 0;
    let dispatches_skipped = 0;
    for (const row of dispatchAggRows) {
      const n = Number(row.count) || 0;
      switch (row.status) {
        case 'succeeded':
          dispatches_ok += n;
          break;
        case 'failed':
        case 'dead_letter':
          dispatches_failed += n;
          break;
        case 'skipped':
          dispatches_skipped += n;
          break;
        default:
          // pending / processing / retrying are in-flight — not exposed.
          break;
      }
    }

    const metricsRow = metricsRows[0];
    const events_total = metricsRow ? Number(metricsRow.eventsTotal) || 0 : 0;
    // MAX() via raw sql<string|null> returns a string from Postgres, never a Date.
    const rawActivity = metricsRow?.lastActivityAt;
    const last_activity_at = rawActivity
      ? new Date(rawActivity).toISOString()
      : null;
    const purchase_total_brl =
      metricsRow && metricsRow.purchaseTotalBrl
        ? Number(metricsRow.purchaseTotalBrl) || 0
        : 0;

    return {
      ok: true,
      value: {
        current_stage,
        stages_journey,
        tags,
        attribution_summary: {
          first_touch,
          last_touch,
          fbclid: fbclid ?? null,
          gclid: gclid ?? null,
        },
        consent_current,
        metrics: {
          events_total,
          dispatches_ok,
          dispatches_failed,
          dispatches_skipped,
          purchase_total_brl,
          last_activity_at,
        },
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'db_error',
        cause: err instanceof Error ? err.constructor.name : 'unknown',
      },
    };
  }
}
