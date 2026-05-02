/**
 * Attribution helper — recordTouches() for first/last/all-touch per (lead_id, launch_id).
 *
 * Implements MOD-ATTRIBUTION contract: `recordTouches()`.
 *
 * Uses pure DI: `db` is always a parameter, never imported as singleton.
 * Compatible with Cloudflare Workers runtime.
 *
 * BR-ATTRIBUTION-001: First-touch por (workspace_id, lead_id, launch_id) — INSERT ON CONFLICT DO NOTHING
 * BR-ATTRIBUTION-002: Last-touch por (workspace_id, lead_id, launch_id) — INSERT ... ON CONFLICT DO UPDATE
 * INV-ATTRIBUTION-001: unique (workspace_id, launch_id, lead_id, touch_type) when touch_type IN ('first','last')
 * INV-ATTRIBUTION-005: first-touch = first event; last-touch = last conversion event (ordered by event_time)
 * INV-ATTRIBUTION-006: lead reappearing in another launch gets new first-touch for that launch
 */

import type { Db } from '@globaltracker/db';
import { leadAttributions } from '@globaltracker/db';
import { and, eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type AttributionParams = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  fbclid?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  fbc?: string;
  fbp?: string;
  _gcl_au?: string;
  _ga?: string;
  referrer_domain?: string;
  link_id?: string;
  ad_account_id?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  creative_id?: string;
};

export type RecordTouchesInput = {
  lead_id: string;
  launch_id: string;
  workspace_id: string;
  attribution: AttributionParams;
  event_time: Date;
};

export type RecordTouchesResult = {
  first_created: boolean;
  last_updated: boolean;
};

export type RecordingError =
  | { code: 'db_error'; message: string }
  | { code: 'invalid_input'; message: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function attributionParamsToRow(
  params: AttributionParams,
): Record<string, string | null | undefined> {
  return {
    source: params.utm_source,
    medium: params.utm_medium,
    campaign: params.utm_campaign,
    content: params.utm_content,
    term: params.utm_term,
    linkId: params.link_id,
    adAccountId: params.ad_account_id,
    campaignId: params.campaign_id,
    adsetId: params.adset_id,
    adId: params.ad_id,
    creativeId: params.creative_id,
    fbclid: params.fbclid,
    gclid: params.gclid,
    gbraid: params.gbraid,
    wbraid: params.wbraid,
    fbc: params.fbc,
    fbp: params.fbp,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records first-touch, last-touch, and all-touch attribution for a lead+launch.
 *
 * - first: INSERT ON CONFLICT DO NOTHING — one per (workspace_id, lead_id, launch_id)
 * - last:  INSERT ON CONFLICT DO UPDATE — updated on every call
 * - all:   always INSERT (append-only history)
 *
 * BR-ATTRIBUTION-001: first-touch único por (workspace_id, lead_id, launch_id)
 * BR-ATTRIBUTION-002: last-touch atualizado a cada conversão
 * INV-ATTRIBUTION-001: partial unique indexes enforce uniqueness
 * INV-ATTRIBUTION-005: first from first event; last from last conversion
 * INV-ATTRIBUTION-006: new first-touch per new launch
 */
export async function recordTouches(
  input: RecordTouchesInput,
  db: Db,
): Promise<Result<RecordTouchesResult, RecordingError>> {
  if (!input.lead_id || !input.launch_id || !input.workspace_id) {
    return {
      ok: false,
      error: {
        code: 'invalid_input',
        message: 'lead_id, launch_id, and workspace_id are required',
      },
    };
  }

  try {
    const now = new Date();
    const attrRow = attributionParamsToRow(input.attribution);

    // ------------------------------------------------------------------
    // First-touch: INSERT ON CONFLICT DO NOTHING
    // BR-ATTRIBUTION-001: first-touch por (workspace_id, lead_id, launch_id) — única vez
    // INV-ATTRIBUTION-001: partial unique index enforces this at DB level
    // INV-ATTRIBUTION-005: first-touch = first event (caller provides earliest event_time)
    // INV-ATTRIBUTION-006: new launch → new first-touch (scoped per launch_id)
    // ------------------------------------------------------------------
    const firstResult = await db
      .insert(leadAttributions)
      .values({
        workspaceId: input.workspace_id,
        launchId: input.launch_id,
        leadId: input.lead_id,
        touchType: 'first',
        ts: input.event_time,
        createdAt: now,
        updatedAt: now,
        ...attrRow,
      })
      .onConflictDoNothing()
      .returning({ id: leadAttributions.id });

    const firstCreated = firstResult.length > 0;

    // ------------------------------------------------------------------
    // Last-touch: INSERT ON CONFLICT DO UPDATE (upsert)
    // BR-ATTRIBUTION-002: last-touch atualizado a cada conversão
    // INV-ATTRIBUTION-001: partial unique index uq_lead_attributions_last_per_launch
    // INV-ATTRIBUTION-005: last-touch = last conversion event
    // ------------------------------------------------------------------
    const lastResult = await db
      .insert(leadAttributions)
      .values({
        workspaceId: input.workspace_id,
        launchId: input.launch_id,
        leadId: input.lead_id,
        touchType: 'last',
        ts: input.event_time,
        createdAt: now,
        updatedAt: now,
        ...attrRow,
      })
      .onConflictDoUpdate({
        target: [
          leadAttributions.workspaceId,
          leadAttributions.launchId,
          leadAttributions.leadId,
        ],
        // Only update when conflict is on the 'last' touch_type row
        // The partial index ensures this only fires for touch_type='last'
        targetWhere: eq(leadAttributions.touchType, 'last'),
        set: {
          ts: input.event_time,
          updatedAt: now,
          source: sql`excluded.source`,
          medium: sql`excluded.medium`,
          campaign: sql`excluded.campaign`,
          content: sql`excluded.content`,
          term: sql`excluded.term`,
          linkId: sql`excluded.link_id`,
          adAccountId: sql`excluded.ad_account_id`,
          campaignId: sql`excluded.campaign_id`,
          adsetId: sql`excluded.adset_id`,
          adId: sql`excluded.ad_id`,
          creativeId: sql`excluded.creative_id`,
          fbclid: sql`excluded.fbclid`,
          gclid: sql`excluded.gclid`,
          gbraid: sql`excluded.gbraid`,
          wbraid: sql`excluded.wbraid`,
          fbc: sql`excluded.fbc`,
          fbp: sql`excluded.fbp`,
        },
      })
      .returning({
        id: leadAttributions.id,
        updatedAt: leadAttributions.updatedAt,
      });

    const lastUpdated = lastResult.length > 0;

    // ------------------------------------------------------------------
    // All-touch: always INSERT (append-only history)
    // Preserves full attribution history for future multi-touch analysis
    // ------------------------------------------------------------------
    await db.insert(leadAttributions).values({
      workspaceId: input.workspace_id,
      launchId: input.launch_id,
      leadId: input.lead_id,
      touchType: 'all',
      ts: input.event_time,
      createdAt: now,
      updatedAt: now,
      ...attrRow,
    });

    return {
      ok: true,
      value: {
        first_created: firstCreated,
        last_updated: lastUpdated,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'db_error',
        message: err instanceof Error ? err.message : 'Unknown database error',
      },
    };
  }
}

/**
 * Retrieves the lead attribution for a given (lead_id, launch_id, touch_type).
 * Returns null if no attribution exists.
 */
export async function getLeadAttribution(
  lead_id: string,
  launch_id: string,
  touch_type: 'first' | 'last' | 'all',
  db: Db,
): Promise<typeof leadAttributions.$inferSelect | null> {
  const rows = await db
    .select()
    .from(leadAttributions)
    .where(
      and(
        eq(leadAttributions.leadId, lead_id),
        eq(leadAttributions.launchId, launch_id),
        eq(leadAttributions.touchType, touch_type),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
