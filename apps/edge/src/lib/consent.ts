/**
 * Consent helper — createLeadConsent() and getLatestConsent().
 *
 * Implements MOD-IDENTITY consent contracts.
 * Table `lead_consents` is append-only: each row is an immutable consent record.
 * Latest row per (lead_id, finality) is the effective consent state.
 *
 * Uses pure DI: `db` is always a parameter, never imported as singleton.
 * Compatible with Cloudflare Workers runtime.
 *
 * BR-CONSENT-001: Consent is recorded per lead, per finality, at a point in time (append-only).
 * BR-PRIVACY-002: Consent records tied to lead_id (internal) — no PII in clear.
 */

import type { Db } from '@globaltracker/db';
import { leadConsents } from '@globaltracker/db';
import { and, desc, eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** ConsentValue per column (per ADR-010) */
export type ConsentValue = 'granted' | 'denied' | 'unknown';

/**
 * ConsentFinality — 5 finalidades per ADR-010.
 * Maps to individual columns in lead_consents.
 */
export type ConsentFinality =
  | 'analytics'
  | 'marketing'
  | 'ad_user_data'
  | 'ad_personalization'
  | 'customer_match';

/** Full consent snapshot — all 5 finalities */
export type ConsentSnapshot = {
  analytics: ConsentValue;
  marketing: ConsentValue;
  ad_user_data: ConsentValue;
  ad_personalization: ConsentValue;
  customer_match: ConsentValue;
};

export type LeadConsent = typeof leadConsents.$inferSelect;

export type ConsentError =
  | { code: 'db_error'; message: string }
  | { code: 'invalid_lead'; message: string }
  | { code: 'not_found'; message: string };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Records a new consent snapshot for a lead.
 *
 * Table is append-only: each call inserts a new row.
 * Effective consent state = latest row per (lead_id, finality).
 *
 * BR-CONSENT-001: Consent is recorded per lead, per finality, point-in-time.
 * BR-PRIVACY-002: No PII in clear — only lead_id (internal UUID).
 *
 * @param lead_id - internal lead UUID
 * @param consent - snapshot of all 5 consent finalities
 * @param source - origin of consent record (e.g. 'tracker', 'webhook:hotmart', 'admin')
 * @param policy_version - policy version at time of consent; empty string if unknown
 * @param workspace_id - multi-tenant anchor
 * @param db - drizzle DB instance (DI)
 */
export async function createLeadConsent(
  lead_id: string,
  consent: ConsentSnapshot,
  source: string,
  policy_version: string | null,
  workspace_id: string,
  db: Db,
): Promise<Result<LeadConsent, ConsentError>> {
  if (!lead_id || !workspace_id) {
    return {
      ok: false,
      error: {
        code: 'invalid_lead',
        message: 'lead_id and workspace_id are required',
      },
    };
  }

  try {
    const now = new Date();

    // BR-CONSENT-001: append-only insert — no upsert; latest row is effective
    const inserted = await db
      .insert(leadConsents)
      .values({
        workspaceId: workspace_id,
        leadId: lead_id,
        eventId: null, // Not tied to a specific event; administrative record
        // BR-PRIVACY-002: only store hashed/internal identifiers — no PII in clear
        consentAnalytics: consent.analytics,
        consentMarketing: consent.marketing,
        consentAdUserData: consent.ad_user_data,
        consentAdPersonalization: consent.ad_personalization,
        consentCustomerMatch: consent.customer_match,
        source,
        // schema column is notNull; fall back to empty string when null is provided
        policyVersion: policy_version ?? '',
        ts: now,
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      return {
        ok: false,
        error: { code: 'db_error', message: 'Failed to insert consent record' },
      };
    }

    return { ok: true, value: row };
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
 * Returns the effective (latest) consent value for a specific finality.
 *
 * Reads the most recent row ordered by `ts DESC` for the given lead.
 * The full snapshot is stored per row, so we select the finality column needed.
 *
 * BR-CONSENT-001: latest row per (lead_id, finality) is the effective state.
 *
 * @param lead_id - internal lead UUID
 * @param finality - which consent dimension to retrieve
 * @param workspace_id - multi-tenant scope
 * @param db - drizzle DB instance (DI)
 */
export async function getLatestConsent(
  lead_id: string,
  finality: ConsentFinality,
  workspace_id: string,
  db: Db,
): Promise<Result<ConsentValue, ConsentError>> {
  try {
    const rows = await db
      .select()
      .from(leadConsents)
      .where(
        and(
          eq(leadConsents.leadId, lead_id),
          eq(leadConsents.workspaceId, workspace_id),
        ),
      )
      // BR-CONSENT-001: latest row is effective — order by ts DESC
      .orderBy(desc(leadConsents.ts))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: `No consent records found for lead ${lead_id}`,
        },
      };
    }

    // Map finality to the correct column
    const value = finalityToValue(row, finality);

    return { ok: true, value };
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps a ConsentFinality to the corresponding column value in a consent row.
 */
function finalityToValue(
  row: LeadConsent,
  finality: ConsentFinality,
): ConsentValue {
  switch (finality) {
    case 'analytics':
      return row.consentAnalytics as ConsentValue;
    case 'marketing':
      return row.consentMarketing as ConsentValue;
    case 'ad_user_data':
      return row.consentAdUserData as ConsentValue;
    case 'ad_personalization':
      return row.consentAdPersonalization as ConsentValue;
    case 'customer_match':
      return row.consentCustomerMatch as ConsentValue;
  }
}
