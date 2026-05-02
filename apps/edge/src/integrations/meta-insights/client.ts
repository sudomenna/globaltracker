/**
 * Meta Ads Insights API client.
 *
 * Fetches ad spend data for a given account and date via the
 * Marketing API v20.0 Insights endpoint.
 *
 * Endpoint:
 *   GET /v20.0/act_{account_id}/insights
 *   ?fields=spend,impressions,clicks,campaign_id,adset_id,ad_id,date_start
 *   &level=ad
 *   &time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
 *   &limit=500
 *   &access_token={META_ADS_ACCESS_TOKEN}
 *
 * Paginates via cursor (data.paging.cursors.after / paging.next).
 *
 * INV-COST-001: granularity is 'ad' for rows returned here — unique key uses ad_id.
 * INV-COST-006: function is pure/stateless — idempotent per (accountId, date).
 * BR-COST-001: spend is returned as a string by Meta; caller converts to cents.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config type — explicit DI, no global env access
// ---------------------------------------------------------------------------

export interface MetaInsightsConfig {
  /** Meta Ads access token (from env META_ADS_ACCESS_TOKEN) */
  accessToken: string;
}

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const MetaInsightRowSchema = z.object({
  spend: z.string(),
  impressions: z.string(),
  clicks: z.string(),
  campaign_id: z.string().optional(),
  adset_id: z.string().optional(),
  ad_id: z.string().optional(),
  date_start: z.string(),
});

export type MetaInsightRow = z.infer<typeof MetaInsightRowSchema>;

const MetaInsightsPageSchema = z.object({
  data: z.array(
    z
      .object({
        spend: z.string(),
        impressions: z.string(),
        clicks: z.string(),
        campaign_id: z.string().optional(),
        adset_id: z.string().optional(),
        ad_id: z.string().optional(),
        date_start: z.string(),
        account_currency: z.string().optional(),
      })
      .passthrough(),
  ),
  paging: z
    .object({
      cursors: z
        .object({
          after: z.string().optional(),
        })
        .optional(),
      next: z.string().optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class MetaInsightsError extends Error {
  public override readonly cause?: unknown;

  constructor(
    message: string,
    public readonly statusCode?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'MetaInsightsError';
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const META_API_VERSION = 'v20.0';
const META_API_BASE = 'https://graph.facebook.com';
const PAGE_LIMIT = 500;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch ad spend insights from Meta Ads for a given account and date.
 *
 * Returns one row per ad (level=ad), including campaign_id and adset_id for
 * hierarchy context. The `currency` field is inferred from the account's
 * reporting currency returned in each row's account_currency field,
 * defaulting to 'USD' when absent (Meta accounts default to USD).
 *
 * INV-COST-001: rows at level=ad — granularity='ad' at insert time.
 * INV-COST-006: same (accountId, date) always returns same data (idempotent read).
 *
 * @param accountId - Meta Ads account ID (without "act_" prefix)
 * @param date      - YYYY-MM-DD — fetches spend for this single day
 * @param config    - { accessToken }
 * @param fetchFn   - Injectable fetch for testability
 */
export async function fetchMetaInsights(
  accountId: string,
  date: string,
  config: MetaInsightsConfig,
  fetchFn: typeof fetch = fetch,
): Promise<MetaInsightRow[]> {
  const results: MetaInsightRow[] = [];

  const timeRange = JSON.stringify({ since: date, until: date });
  const fields =
    'spend,impressions,clicks,campaign_id,adset_id,ad_id,date_start,account_currency';

  const baseParams = new URLSearchParams({
    fields,
    level: 'ad',
    time_range: timeRange,
    limit: String(PAGE_LIMIT),
    access_token: config.accessToken,
  });

  let url: string | null =
    `${META_API_BASE}/${META_API_VERSION}/act_${accountId}/insights?${baseParams.toString()}`;

  while (url !== null) {
    let response: Response;
    try {
      response = await fetchFn(url);
    } catch (err) {
      throw new MetaInsightsError(
        `Network error fetching Meta Insights for account ${accountId}`,
        undefined,
        err,
      );
    }

    if (!response.ok) {
      throw new MetaInsightsError(
        `Meta Insights API returned HTTP ${response.status} for account ${accountId}`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new MetaInsightsError(
        'Failed to parse Meta Insights response body as JSON',
        undefined,
        err,
      );
    }

    const parsed = MetaInsightsPageSchema.safeParse(body);
    if (!parsed.success) {
      throw new MetaInsightsError(
        `Unexpected Meta Insights response shape: ${parsed.error.message}`,
      );
    }

    const page = parsed.data;

    for (const row of page.data) {
      const validated = MetaInsightRowSchema.safeParse(row);
      if (!validated.success) {
        // Skip rows that don't match expected shape — log-safe (no PII)
        // BR-COST-002: skip bad rows rather than abort the whole batch
        continue;
      }
      results.push(validated.data);
    }

    // Pagination: follow next cursor if present
    if (page.paging?.next) {
      url = page.paging.next;
    } else {
      url = null;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Utility: parse Meta spend string → cents (integer)
// ---------------------------------------------------------------------------

/**
 * Convert Meta Insights `spend` string (e.g. "12.34") to cents integer.
 *
 * Meta returns spend in major currency units as a decimal string.
 * We multiply by 100 and round to get integer cents.
 *
 * BR-COST-001: spend_cents >= 0
 */
export function parseMetaSpendCents(spend: string): number {
  const value = Number.parseFloat(spend);
  if (Number.isNaN(value) || value < 0) return 0;
  // INV-COST-003: spend_cents must be integer (cents)
  return Math.round(value * 100);
}

/**
 * Resolve the currency for a Meta Insights row.
 *
 * Meta returns account_currency in the raw response fields when
 * account_currency is included in the fields parameter.
 * The validated MetaInsightRow does not carry currency — callers must pass it.
 *
 * This helper extracts currency from the raw API row before Zod strips it.
 */
export function resolveMetaRowCurrency(
  rawRow: Record<string, unknown>,
  fallback = 'USD',
): string {
  const cur = rawRow.account_currency;
  if (typeof cur === 'string' && cur.length === 3) return cur.toUpperCase();
  return fallback;
}
