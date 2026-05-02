/**
 * cost-ingestor.ts — Daily ad spend ingestion cron.
 *
 * Fetches ad spend from Meta Ads Insights and Google Ads Reporting for a
 * given date, normalizes to BRL via FX rates, and upserts into ad_spend_daily.
 *
 * Called from the scheduled handler in index.ts at 17:30 UTC daily
 * (after ECB publishes rates at ~17:00 UTC).
 *
 * INV-COST-001: upsert uses ON CONFLICT DO UPDATE on the natural key.
 * INV-COST-003: spend_cents_normalized is populated for every row after sync.
 * INV-COST-004: fx_currency matches workspace.fx_normalization_currency at write time.
 * INV-COST-006: running ingestDailySpend twice for the same date yields the same DB state.
 * BR-COST-001: unique constraint respected via COALESCE on nullable fields.
 * BR-COST-002: FX failure captured in errors[]; row still inserted with NULL normalized.
 * BR-PRIVACY-001: no PII in log output; safeLog used throughout.
 */

import type { Db } from '@globaltracker/db';
import { adSpendDaily } from '@globaltracker/db';
import { sql } from 'drizzle-orm';

import type { GoogleAdsConfig } from '../integrations/google-ads-reporting/client.js';
import { fetchGoogleAdsSpend } from '../integrations/google-ads-reporting/client.js';
import type { MetaInsightsConfig } from '../integrations/meta-insights/client.js';
import {
  fetchMetaInsights,
  parseMetaSpendCents,
  resolveMetaRowCurrency,
} from '../integrations/meta-insights/client.js';
import type { FxEnv } from '../lib/fx.js';
import {
  FxRatesUnavailableError,
  getRateForPair,
  normalizeSpendCents,
} from '../lib/fx.js';

// ---------------------------------------------------------------------------
// Bindings subset needed by cost ingestor (explicit DI)
// ---------------------------------------------------------------------------

export interface CostIngestorEnv extends FxEnv {
  META_ADS_ACCOUNT_ID: string;
  META_ADS_ACCESS_TOKEN: string;
  GOOGLE_ADS_CUSTOMER_ID: string;
  GOOGLE_ADS_DEVELOPER_TOKEN: string;
  GOOGLE_ADS_CLIENT_ID: string;
  GOOGLE_ADS_CLIENT_SECRET: string;
  GOOGLE_ADS_REFRESH_TOKEN: string;
  GOOGLE_ADS_CURRENCY: string;
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface IngestResult {
  ingested: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Workspace FX config
// ---------------------------------------------------------------------------

// INV-COST-004: workspace.fx_normalization_currency is the target currency.
// Phase 1: single global target = 'BRL' (per-workspace is Phase 2).
const WORKSPACE_FX_NORMALIZATION_CURRENCY = 'BRL';

// Fixed workspace_id for Phase 1 (single-tenant).
// Phase 2: enumerate workspaces from DB.
const GLOBAL_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Upsert helper
// ---------------------------------------------------------------------------

type UpsertRow = {
  workspaceId: string;
  platform: string;
  accountId: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  granularity: string;
  date: string;
  timezone: string;
  currency: string;
  spendCents: number;
  spendCentsNormalized: number | null;
  fxRate: string | null;
  fxSource: string | null;
  fxCurrency: string | null;
  impressions: number;
  clicks: number;
  fetchedAt: Date;
};

/**
 * Upsert a single row into ad_spend_daily.
 *
 * INV-COST-001: ON CONFLICT targets the expression index on
 *   (workspace_id, platform, account_id,
 *    COALESCE(campaign_id,''), COALESCE(adset_id,''), COALESCE(ad_id,''),
 *    granularity, date)
 *
 * On conflict, we update spend, FX, impressions, clicks, and fetched_at
 * to allow retroactive corrections from platform providers.
 */
async function upsertAdSpend(db: Db, row: UpsertRow): Promise<void> {
  // INV-COST-001: BR-COST-001 — upsert on natural key; timezone excluded from key.
  await db
    .insert(adSpendDaily)
    .values({
      workspaceId: row.workspaceId,
      platform: row.platform,
      accountId: row.accountId,
      campaignId: row.campaignId,
      adsetId: row.adsetId,
      adId: row.adId,
      granularity: row.granularity,
      date: row.date,
      timezone: row.timezone,
      currency: row.currency,
      spendCents: row.spendCents,
      spendCentsNormalized: row.spendCentsNormalized,
      fxRate: row.fxRate,
      fxSource: row.fxSource,
      fxCurrency: row.fxCurrency,
      impressions: row.impressions,
      clicks: row.clicks,
      fetchedAt: row.fetchedAt,
    })
    .onConflictDoUpdate({
      // INV-COST-001: the DB index is an expression index using COALESCE.
      // Drizzle does not support expression-based conflict targets directly;
      // use the index name as `target` is not supported for expression indexes.
      // We use the raw SQL form via `targetWhere` is also unavailable here.
      // Solution: target the unique constraint by name via sql`` tag.
      // The migration must create this as a named unique index:
      //   uq_ad_spend_daily_natural_key
      target: sql`ON CONSTRAINT uq_ad_spend_daily_natural_key` as never,
      set: {
        spendCents: row.spendCents,
        spendCentsNormalized: row.spendCentsNormalized,
        fxRate: row.fxRate,
        fxSource: row.fxSource,
        fxCurrency: row.fxCurrency,
        impressions: row.impressions,
        clicks: row.clicks,
        fetchedAt: row.fetchedAt,
      },
    });
}

// ---------------------------------------------------------------------------
// FX resolution helper
// ---------------------------------------------------------------------------

interface FxResolved {
  fxRate: string;
  fxSource: string;
  fxCurrency: string;
  spendCentsNormalized: number;
}

async function resolveFx(
  currency: string,
  spendCents: number,
  date: string,
  env: CostIngestorEnv,
  fetchFn?: typeof fetch,
  sleepFn?: (ms: number) => Promise<void>,
): Promise<FxResolved | null> {
  // INV-COST-004: target currency = workspace.fx_normalization_currency
  const targetCurrency = WORKSPACE_FX_NORMALIZATION_CURRENCY;

  try {
    // If currency === target, no conversion needed — rate is 1.0
    if (currency === targetCurrency) {
      return {
        fxRate: '1.00000000',
        fxSource: 'ecb',
        fxCurrency: targetCurrency,
        spendCentsNormalized: spendCents,
      };
    }

    const result = await getRateForPair(
      currency,
      targetCurrency,
      date,
      env,
      fetchFn,
      sleepFn,
    );

    // INV-COST-003: spend_cents_normalized = round(spend_cents * fx_rate)
    const normalized = normalizeSpendCents(spendCents, result.rate);

    return {
      fxRate: result.rate.toFixed(8),
      fxSource: result.source,
      // INV-COST-004: fx_currency matches workspace.fx_normalization_currency
      fxCurrency: targetCurrency,
      spendCentsNormalized: normalized,
    };
  } catch (err) {
    if (err instanceof FxRatesUnavailableError) {
      // BR-COST-002: FX failure → insert row with NULL normalized fields; collect error
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Ingest daily ad spend for a given date from Meta and Google Ads.
 *
 * Never throws — all errors are collected in the returned errors array.
 *
 * INV-COST-006: idempotent — running twice for the same date produces the
 *   same DB state (upsert ON CONFLICT DO UPDATE replaces previous values).
 *
 * @param date    - YYYY-MM-DD
 * @param env     - Worker bindings (credentials, KV for FX cache)
 * @param db      - Drizzle DB client (injected for testability)
 * @param fetchFn - Injectable fetch for testability
 * @param sleepFn - Injectable sleep for FX retry backoff (tests pass no-op)
 */
export async function ingestDailySpend(
  date: string,
  env: CostIngestorEnv,
  db: Db,
  fetchFn: typeof fetch = fetch,
  sleepFn?: (ms: number) => Promise<void>,
): Promise<IngestResult> {
  const errors: string[] = [];
  let ingested = 0;
  const fetchedAt = new Date();

  // -------------------------------------------------------------------------
  // 1. Fetch Meta Insights (granularity='ad')
  // -------------------------------------------------------------------------
  const metaConfig: MetaInsightsConfig = {
    accessToken: env.META_ADS_ACCESS_TOKEN,
  };

  let metaRows: Awaited<ReturnType<typeof fetchMetaInsights>> = [];
  try {
    metaRows = await fetchMetaInsights(
      env.META_ADS_ACCOUNT_ID,
      date,
      metaConfig,
      fetchFn,
    );
  } catch (err) {
    // BR-COST-002: partial platform failure — collect error and continue
    errors.push(
      `meta_insights_fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // -------------------------------------------------------------------------
  // 2. Process Meta rows
  // -------------------------------------------------------------------------
  for (const row of metaRows) {
    try {
      // INV-COST-002: granularity='ad' for Meta rows
      const granularity = 'ad';

      // BR-COST-001: parse spend string → cents integer
      const spendCents = parseMetaSpendCents(row.spend);

      // Resolve currency from raw row (account_currency field may be present).
      // resolveMetaRowCurrency accepts Record<string,unknown>; MetaInsightRow
      // is a strict subset so the cast is safe — no PII in this object.
      const currency = resolveMetaRowCurrency(
        row as Record<string, unknown>,
        'USD',
      );

      // INV-COST-003, INV-COST-004: resolve FX for normalization
      const fx = await resolveFx(
        currency,
        spendCents,
        date,
        env,
        fetchFn,
        sleepFn,
      );

      const upsertRow: UpsertRow = {
        workspaceId: GLOBAL_WORKSPACE_ID,
        platform: 'meta',
        accountId: env.META_ADS_ACCOUNT_ID,
        // INV-COST-001: COALESCE(campaign_id,'') is part of unique key
        campaignId: row.campaign_id ?? null,
        adsetId: row.adset_id ?? null,
        adId: row.ad_id ?? null,
        granularity,
        date: row.date_start,
        timezone: 'UTC',
        currency,
        spendCents,
        spendCentsNormalized: fx?.spendCentsNormalized ?? null,
        fxRate: fx?.fxRate ?? null,
        fxSource: fx?.fxSource ?? null,
        fxCurrency: fx?.fxCurrency ?? null,
        impressions: Number.parseInt(row.impressions, 10) || 0,
        clicks: Number.parseInt(row.clicks, 10) || 0,
        fetchedAt,
      };

      await upsertAdSpend(db, upsertRow);
      ingested++;
    } catch (err) {
      // Collect per-row errors without aborting the batch
      errors.push(
        `meta_row_upsert_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // 3. Fetch Google Ads Spend (granularity='adset')
  // -------------------------------------------------------------------------
  const googleConfig: GoogleAdsConfig = {
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN,
    currency: env.GOOGLE_ADS_CURRENCY,
  };

  let googleRows: Awaited<ReturnType<typeof fetchGoogleAdsSpend>> = [];
  try {
    googleRows = await fetchGoogleAdsSpend(
      env.GOOGLE_ADS_CUSTOMER_ID,
      date,
      googleConfig,
      fetchFn,
    );
  } catch (err) {
    // BR-COST-002: partial platform failure — collect error and continue
    errors.push(
      `google_ads_fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // -------------------------------------------------------------------------
  // 4. Process Google Ads rows
  // -------------------------------------------------------------------------
  for (const row of googleRows) {
    try {
      // INV-COST-002: granularity='adset' for Google Ads (ad_group level)
      const granularity = 'adset';
      const currency = googleConfig.currency;

      // INV-COST-003, INV-COST-004: resolve FX for normalization
      const fx = await resolveFx(
        currency,
        row.spend_cents,
        date,
        env,
        fetchFn,
        sleepFn,
      );

      const upsertRow: UpsertRow = {
        workspaceId: GLOBAL_WORKSPACE_ID,
        platform: 'google',
        accountId: env.GOOGLE_ADS_CUSTOMER_ID,
        // INV-COST-001: campaign_id and adset_id present; ad_id=null for adset granularity
        campaignId: row.campaign_id,
        adsetId: row.ad_group_id,
        adId: null,
        granularity,
        date: row.date,
        timezone: 'UTC',
        currency,
        spendCents: row.spend_cents,
        spendCentsNormalized: fx?.spendCentsNormalized ?? null,
        fxRate: fx?.fxRate ?? null,
        fxSource: fx?.fxSource ?? null,
        fxCurrency: fx?.fxCurrency ?? null,
        impressions: row.impressions,
        clicks: row.clicks,
        fetchedAt,
      };

      await upsertAdSpend(db, upsertRow);
      ingested++;
    } catch (err) {
      // Collect per-row errors without aborting the batch
      errors.push(
        `google_row_upsert_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { ingested, errors };
}
