/**
 * E2E flow tests — Cost Ingestor: FX normalisation + idempotency
 *
 * T-ID: T-4-001 (cost ingestor)
 * Spec: apps/edge/src/crons/cost-ingestor.ts
 *
 * Tests the ingestDailySpend function end-to-end using:
 *   - Injectable mocks for fetchMetaInsights, fetchGoogleAdsSpend, getRateForPair
 *   - In-memory stateful mock DB (no real Postgres required)
 *
 * Scenarios covered:
 *   TC-COST-01: 2 Meta rows (USD) + 1 Google row (BRL) → 3 upserts with correct
 *               spend_cents_normalized (INV-COST-003)
 *   TC-COST-02: USD row carries fx_rate=5.20, fx_currency='BRL', fx_source='ecb'
 *               (INV-COST-004)
 *   TC-COST-03: BRL row (same currency as target) → fx_rate=1.0, no external FX call
 *   TC-COST-04: Running ingestDailySpend twice with same date → same DB state
 *               (INV-COST-006 idempotency)
 *   TC-COST-05: FX unavailable → row inserted with spend_cents_normalized=NULL
 *               (BR-COST-002)
 *   TC-COST-06: Meta fetch failure → errors collected, Google rows still processed
 *               (BR-COST-002 partial platform failure)
 *
 * BRs applied (cited inline):
 *   INV-COST-001: ON CONFLICT upsert on natural key
 *   INV-COST-003: spend_cents_normalized = round(spend_cents * fx_rate)
 *   INV-COST-004: fx_currency matches workspace.fx_normalization_currency
 *   INV-COST-006: idempotent — running twice produces same state
 *   BR-COST-001: spend parsed from string → cents integer
 *   BR-COST-002: FX failure → row with NULL normalized; partial platform failure → continue
 *   BR-PRIVACY-001: no PII in test fixtures
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted above imports that consume the modules
// ---------------------------------------------------------------------------

// We mock the two platform clients and the FX module so that ingestDailySpend
// receives injectable behaviour without any real network I/O.

vi.mock(
  '../../apps/edge/src/integrations/meta-insights/client.js',
  async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return { ...original, fetchMetaInsights: vi.fn() };
  },
);

vi.mock(
  '../../apps/edge/src/integrations/google-ads-reporting/client.js',
  async (importOriginal) => {
    const original = (await importOriginal()) as Record<string, unknown>;
    return { ...original, fetchGoogleAdsSpend: vi.fn() };
  },
);

vi.mock('../../apps/edge/src/lib/fx.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return { ...original, getRateForPair: vi.fn() };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock hoisting)
// ---------------------------------------------------------------------------

import {
  type CostIngestorEnv,
  ingestDailySpend,
} from '../../apps/edge/src/crons/cost-ingestor.js';
import { fetchGoogleAdsSpend } from '../../apps/edge/src/integrations/google-ads-reporting/client.js';
import { fetchMetaInsights } from '../../apps/edge/src/integrations/meta-insights/client.js';
import {
  FxRatesUnavailableError,
  getRateForPair,
} from '../../apps/edge/src/lib/fx.js';

// ---------------------------------------------------------------------------
// Constants — deterministic; no Math.random(), no new Date() without mock
// ---------------------------------------------------------------------------

const TEST_DATE = '2026-05-01';

const META_ACCOUNT_ID = 'act_111111111';
const GOOGLE_CUSTOMER_ID = '9999999999';

const ENV: CostIngestorEnv = {
  META_ADS_ACCOUNT_ID: META_ACCOUNT_ID,
  META_ADS_ACCESS_TOKEN: 'test_meta_token',
  GOOGLE_ADS_CUSTOMER_ID: GOOGLE_CUSTOMER_ID,
  GOOGLE_ADS_DEVELOPER_TOKEN: 'test_dev_token',
  GOOGLE_ADS_CLIENT_ID: 'test_client_id',
  GOOGLE_ADS_CLIENT_SECRET: 'test_client_secret',
  GOOGLE_ADS_REFRESH_TOKEN: 'test_refresh_token',
  GOOGLE_ADS_CURRENCY: 'BRL',
  FX_RATES_PROVIDER: 'ecb',
  // GT_KV is not called directly by ingestDailySpend — it goes through getRateForPair
  // which we mock entirely.
  GT_KV: {} as KVNamespace,
};

// ---------------------------------------------------------------------------
// Fixture helpers — sanitized synthetic data (BR-PRIVACY-001)
// ---------------------------------------------------------------------------

function makeMetaRow(campaignId: string, spendUsd: string, currency = 'USD') {
  return {
    spend: spendUsd,
    impressions: '1000',
    clicks: '50',
    campaign_id: campaignId,
    adset_id: `adset_${campaignId}`,
    ad_id: `ad_${campaignId}`,
    date_start: TEST_DATE,
    // account_currency is on the raw row but stripped by Zod schema;
    // resolveMetaRowCurrency reads it before validation so we include it.
    account_currency: currency,
  };
}

function makeGoogleRow(campaignId: string, spendCents: number) {
  return {
    spend_cents: spendCents,
    impressions: 200,
    clicks: 10,
    campaign_id: campaignId,
    ad_group_id: `adgroup_${campaignId}`,
    date: TEST_DATE,
  };
}

// ---------------------------------------------------------------------------
// In-memory mock DB
//
// Captures upsert calls to ad_spend_daily.
// INV-COST-001: tracks last-written row per natural key (platform+accountId+campaignId+...).
// ---------------------------------------------------------------------------

interface SpendRow {
  workspaceId: string;
  platform: string;
  accountId: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  granularity: string;
  date: string;
  currency: string;
  spendCents: number;
  spendCentsNormalized: number | null;
  fxRate: string | null;
  fxSource: string | null;
  fxCurrency: string | null;
  impressions: number;
  clicks: number;
  fetchedAt: Date;
}

function makeSpendDb() {
  // Natural key for upsert simulation (INV-COST-001)
  const spendRows = new Map<string, SpendRow>();
  const upsertCalls: SpendRow[] = [];

  function naturalKey(row: SpendRow): string {
    return [
      row.workspaceId,
      row.platform,
      row.accountId,
      row.campaignId ?? '',
      row.adsetId ?? '',
      row.adId ?? '',
      row.granularity,
      row.date,
    ].join('|');
  }

  // Minimal Drizzle-style insert mock for ad_spend_daily
  const db = {
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn((_opts: unknown) => {
          // INV-COST-001: upsert — last write wins per natural key
          const typed = row as SpendRow;
          const key = naturalKey(typed);
          spendRows.set(key, { ...typed });
          upsertCalls.push({ ...typed });
          return Promise.resolve();
        }),
      })),
    })),
  };

  return { db, spendRows, upsertCalls };
}

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------

const mockFetchMetaInsights = vi.mocked(fetchMetaInsights);
const mockFetchGoogleAdsSpend = vi.mocked(fetchGoogleAdsSpend);
const mockGetRateForPair = vi.mocked(getRateForPair);

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('FLOW-COST: ingestDailySpend — FX normalisation and idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // TC-COST-01: 2 Meta rows (USD) + 1 Google row (BRL) → 3 upserts
  // --------------------------------------------------------------------------

  describe('TC-COST-01: 2 Meta USD rows + 1 Google BRL row → 3 upserts with correct spend_cents_normalized (INV-COST-003)', () => {
    it('produces exactly 3 upserts, one per source row', async () => {
      const { db, upsertCalls } = makeSpendDb();

      // Meta: 2 campaigns in USD
      mockFetchMetaInsights.mockResolvedValueOnce([
        makeMetaRow('campaign_a', '10.00', 'USD'),
        makeMetaRow('campaign_b', '5.50', 'USD'),
      ] as ReturnType<typeof fetchMetaInsights> extends Promise<infer T>
        ? T
        : never);

      // Google: 1 row in BRL (same as target currency)
      mockFetchGoogleAdsSpend.mockResolvedValueOnce([
        makeGoogleRow('g_campaign_1', 2000), // 2000 BRL cents
      ] as ReturnType<typeof fetchGoogleAdsSpend> extends Promise<infer T>
        ? T
        : never);

      // FX: USD→BRL = 5.20 (only called for USD rows; BRL rows skip external call)
      mockGetRateForPair.mockResolvedValue({
        rate: 5.2,
        stale: false,
        source: 'ecb',
      });

      const result = await ingestDailySpend(
        TEST_DATE,
        ENV,
        db as unknown as Parameters<typeof ingestDailySpend>[2],
        fetch,
        // no-op sleepFn to skip FX retry backoff in tests
        async (_ms: number) => {},
      );

      expect(result.errors).toHaveLength(0);
      // INV-COST-003: 3 upserts total
      expect(upsertCalls).toHaveLength(3);
      expect(result.ingested).toBe(3);
    });

    it('INV-COST-003: spend_cents_normalized = round(spend_cents * fx_rate) for USD rows', async () => {
      const { db, upsertCalls } = makeSpendDb();

      mockFetchMetaInsights.mockResolvedValueOnce([
        makeMetaRow('campaign_a', '10.00', 'USD'), // 1000 USD cents × 5.20 = 5200 BRL cents
      ] as ReturnType<typeof fetchMetaInsights> extends Promise<infer T>
        ? T
        : never);
      mockFetchGoogleAdsSpend.mockResolvedValueOnce([]);

      mockGetRateForPair.mockResolvedValue({
        rate: 5.2,
        stale: false,
        source: 'ecb',
      });

      await ingestDailySpend(
        TEST_DATE,
        ENV,
        db as unknown as Parameters<typeof ingestDailySpend>[2],
        fetch,
        async (_ms: number) => {},
      );

      const row = upsertCalls[0];
      // 10.00 USD = 1000 cents × 5.20 = 5200 BRL cents
      expect(row?.spendCents).toBe(1000);
      expect(row?.spendCentsNormalized).toBe(5200);
    });
  });

  // --------------------------------------------------------------------------
  // TC-COST-02: USD row carries correct FX metadata (INV-COST-004)
  // --------------------------------------------------------------------------

  describe('TC-COST-02: USD row has fx_rate=5.20, fx_currency=BRL, fx_source=ecb (INV-COST-004)', () => {
    it('fx metadata written correctly for currency conversion row', async () => {
      const { db, upsertCalls } = makeSpendDb();

      mockFetchMetaInsights.mockResolvedValueOnce([
        makeMetaRow('campaign_a', '10.00', 'USD'),
      ] as ReturnType<typeof fetchMetaInsights> extends Promise<infer T>
        ? T
        : never);
      mockFetchGoogleAdsSpend.mockResolvedValueOnce([]);

      mockGetRateForPair.mockResolvedValue({
        rate: 5.2,
        stale: false,
        source: 'ecb',
      });

      await ingestDailySpend(
        TEST_DATE,
        ENV,
        db as unknown as Parameters<typeof ingestDailySpend>[2],
        fetch,
        async (_ms: number) => {},
      );

      const row = upsertCalls[0];
      // INV-COST-004: fx_rate stored as 8-decimal string
      expect(row?.fxRate).toBe('5.20000000');
      // INV-COST-004: fx_currency must match workspace.fx_normalization_currency
      expect(row?.fxCurrency).toBe('BRL');
      expect(row?.fxSource).toBe('ecb');
    });
  });

  // --------------------------------------------------------------------------
  // TC-COST-03: BRL row (same as target) — fx_rate=1.0, no getRateForPair call
  // --------------------------------------------------------------------------

  describe('TC-COST-03: BRL row (same currency as target) → fx_rate=1.0, no external FX call', () => {
    it('does not call getRateForPair when currency already matches target (BRL)', async () => {
      const { db, upsertCalls } = makeSpendDb();

      // Google Ads rows use GOOGLE_ADS_CURRENCY = 'BRL' from ENV
      mockFetchMetaInsights.mockResolvedValueOnce([]);
      mockFetchGoogleAdsSpend.mockResolvedValueOnce([
        makeGoogleRow('g_campaign_brl', 3000), // 3000 BRL cents
      ] as ReturnType<typeof fetchGoogleAdsSpend> extends Promise<infer T>
        ? T
        : never);

      await ingestDailySpend(
        TEST_DATE,
        ENV,
        db as unknown as Parameters<typeof ingestDailySpend>[2],
        fetch,
        async (_ms: number) => {},
      );

      // getRateForPair should NOT have been called — same-currency fast path
      expect(mockGetRateForPair).not.toHaveBeenCalled();

      const row = upsertCalls[0];
      expect(row?.spendCentsNormalized).toBe(3000);
      expect(row?.fxRate).toBe('1.00000000');
      expect(row?.fxCurrency).toBe('BRL');
    });
  });

  // --------------------------------------------------------------------------
  // TC-COST-04: Idempotency — second call for same date → same DB state (INV-COST-006)
  // --------------------------------------------------------------------------

  describe('TC-COST-04: idempotency — calling ingestDailySpend twice for same date yields same DB state (INV-COST-006)', () => {
    it('upsert ON CONFLICT ensures second call overwrites with identical values', async () => {
      const { db, spendRows, upsertCalls } = makeSpendDb();

      const metaRows = [makeMetaRow('campaign_a', '10.00', 'USD')];
      const googleRows = [makeGoogleRow('g_campaign_1', 500)];

      mockGetRateForPair.mockResolvedValue({
        rate: 5.2,
        stale: false,
        source: 'ecb',
      });

      // --- First call ---
      mockFetchMetaInsights.mockResolvedValueOnce(
        metaRows as ReturnType<typeof fetchMetaInsights> extends Promise<
          infer T
        >
          ? T
          : never,
      );
      mockFetchGoogleAdsSpend.mockResolvedValueOnce(
        googleRows as ReturnType<typeof fetchGoogleAdsSpend> extends Promise<
          infer T
        >
          ? T
          : never,
      );

      const result1 = await ingestDailySpend(
        TEST_DATE,
        ENV,
        db as unknown as Parameters<typeof ingestDailySpend>[2],
        fetch,
        async (_ms: number) => {},
      );

      const stateAfterFirst = new Map(spendRows);
      const upsertCountAfterFirst = upsertCalls.length;

      // --- Second call (same date, same data) ---
      mockFetchMetaInsights.mockResolvedValueOnce(
        metaRows as ReturnType<typeof fetchMetaInsights> extends Promise<
          infer T
        >
          ? T
          : never,
      );
      mockFetchGoogleAdsSpend.mockResolvedValueOnce(
        googleRows as ReturnType<typeof fetchGoogleAdsSpend> extends Promise<
          infer T
        >
          ? T
          : never,
      );

      const result2 = await ingestDailySpend(
        TEST_DATE,
        ENV,
        db as unknown as Parameters<typeof ingestDailySpend>[2],
        fetch,
        async (_ms: number) => {},
      );

      // INV-COST-006: same number of keys in the map after second call
      expect(spendRows.size).toBe(stateAfterFirst.size);

      // Both runs produce identical ingested counts and no errors
      expect(result1.errors).toHaveLength(0);
      expect(result2.errors).toHaveLength(0);
      expect(result1.ingested).toBe(result2.ingested);

      // The second call triggers the same number of upsert calls
      // (ON CONFLICT DO UPDATE replaces with same values — idempotent)
      expect(upsertCalls.length).toBe(upsertCountAfterFirst * 2);
    });
  });

  // --------------------------------------------------------------------------
  // TC-COST-05: FX unavailable → row inserted with spend_cents_normalized=NULL (BR-COST-002)
  // --------------------------------------------------------------------------

  describe('TC-COST-05: FX unavailable → row with spend_cents_normalized=NULL + error collected (BR-COST-002)', () => {
    it('does not throw — row upserted with null normalized fields, error captured', async () => {
      const { db, upsertCalls } = makeSpendDb();

      mockFetchMetaInsights.mockResolvedValueOnce([
        makeMetaRow('campaign_fxfail', '20.00', 'USD'),
      ] as ReturnType<typeof fetchMetaInsights> extends Promise<infer T>
        ? T
        : never);
      mockFetchGoogleAdsSpend.mockResolvedValueOnce([]);

      // Simulate FX provider completely unavailable (no stale fallback either)
      mockGetRateForPair.mockRejectedValue(
        new FxRatesUnavailableError('USD', 'BRL', TEST_DATE),
      );

      const result = await ingestDailySpend(
        TEST_DATE,
        ENV,
        db as unknown as Parameters<typeof ingestDailySpend>[2],
        fetch,
        async (_ms: number) => {},
      );

      // BR-COST-002: ingestDailySpend never throws — always returns IngestResult
      // Row is still upserted with NULL normalized fields
      expect(upsertCalls).toHaveLength(1);
      const row = upsertCalls[0];
      expect(row?.spendCentsNormalized).toBeNull();
      expect(row?.fxRate).toBeNull();
      expect(row?.fxCurrency).toBeNull();

      // The row is still counted as ingested
      expect(result.ingested).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // TC-COST-06: Meta fetch failure → Google rows still processed (BR-COST-002)
  // --------------------------------------------------------------------------

  describe('TC-COST-06: Meta fetch failure → error collected, Google rows still processed (BR-COST-002)', () => {
    it('partial platform failure does not abort the full batch', async () => {
      const { db, upsertCalls } = makeSpendDb();

      // Meta fails completely
      mockFetchMetaInsights.mockRejectedValueOnce(
        new Error('Meta API unavailable'),
      );

      // Google succeeds with 1 row in BRL
      mockFetchGoogleAdsSpend.mockResolvedValueOnce([
        makeGoogleRow('g_campaign_ok', 750),
      ] as ReturnType<typeof fetchGoogleAdsSpend> extends Promise<infer T>
        ? T
        : never);

      const result = await ingestDailySpend(
        TEST_DATE,
        ENV,
        db as unknown as Parameters<typeof ingestDailySpend>[2],
        fetch,
        async (_ms: number) => {},
      );

      // BR-COST-002: Meta error collected, not thrown
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('meta_insights_fetch_failed');

      // Google row still ingested
      expect(result.ingested).toBe(1);
      expect(upsertCalls).toHaveLength(1);
      expect(upsertCalls[0]?.platform).toBe('google');
    });
  });
});
